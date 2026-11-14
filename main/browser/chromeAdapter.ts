import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { app } from 'electron'
import type { AdapterDownload, AdapterHost, BrowserAdapter } from './adapter'
import { CdpPipe } from './cdpPipe'
import { browserUrl } from './snapshot'
import { captureBrowserPage, inputBrowserPage } from './presentation'

export function localChromeExecutable(): string | undefined {
  // Only the isolated regression harness may override the installed executable.
  const override = process.env.COVAN_USER_DATA_DIR ? process.env.COVAN_TEST_CHROME_EXECUTABLE : undefined
  return [override, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((file): file is string => !!file && fs.existsSync(file))
}
export const chromeProfile = (botId: string) => path.join(app.getPath('userData'), 'browser-profiles', createHash('sha256').update(botId).digest('hex').slice(0, 32))
class ChromeDownload extends EventEmitter implements AdapterDownload {
  private savePath = ''; private received = 0; private total = 0; private state = 'progressing'; private approved = false; private completed = false
  private timer: ReturnType<typeof setTimeout>
  constructor(private guid: string, private name: string, private url: string, private staging: string, private pipe: CdpPipe) { super(); this.timer = setTimeout(() => this.cancel(), 60_000) }
  pause() { this.approved = false }
  resume() { this.approved = true; this.finish() }
  setSavePath(file: string) { this.savePath = file }
  getFilename() { return this.name }
  getURL() { return this.url }
  getTotalBytes() { return this.total }
  getReceivedBytes() { return this.received }
  getState() { return this.state }
  progress(event: { receivedBytes: number; totalBytes: number; state: string }) {
    if (this.state !== 'progressing') return
    this.received = event.receivedBytes; this.total = event.totalBytes
    if (this.received > 32 * 1024 * 1024 || this.total > 32 * 1024 * 1024) { this.cancel(); return }
    this.emit('updated')
    if (event.state === 'canceled') this.cancel()
    else if (event.state === 'completed') { this.completed = true; this.finish() }
  }
  private finish() {
    if (!this.completed || !this.approved || !this.savePath || this.state !== 'progressing') return
    try {
      const source = path.join(this.staging, this.guid)
      try { fs.renameSync(source, this.savePath) } catch (error: any) { if (error.code !== 'EXDEV') throw error; fs.copyFileSync(source, this.savePath, fs.constants.COPYFILE_EXCL); fs.unlinkSync(source) }
      this.state = 'completed'; clearTimeout(this.timer); this.emit('done', {}, 'completed')
    } catch { this.cancel() }
  }
  cancel() {
    if (this.state !== 'progressing') return
    this.state = 'cancelled'; clearTimeout(this.timer)
    void this.pipe.send('Browser.cancelDownload', { guid: this.guid }).catch(() => {})
    for (const suffix of ['', '.crdownload']) { try { fs.rmSync(path.join(this.staging, this.guid + suffix), { force: true }) } catch { /* Our private staging file only. */ } }
    this.emit('done', {}, 'cancelled')
  }
}

export function createChromeAdapter(host: AdapterHost): BrowserAdapter {
  const executable = localChromeExecutable()
  if (!executable) throw new Error('未找到本机 Chrome 或 Edge，请使用内置 Chromium')
  const profile = chromeProfile(host.botId)
  fs.mkdirSync(profile, { recursive: true })
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'covan-browser-download-'))
  const child = spawn(executable, ['--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions', '--disable-background-networking', '--disable-features=Translate', '--window-size=1280,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
  const pipe = new CdpPipe(child)
  let sessionId = '', targetId = '', url = '', title = '', disposed = false
  const downloads = new Map<string, ChromeDownload>()
  const send = (method: string, params?: Record<string, unknown>) => pipe.send(method, params, sessionId)
  pipe.on((method, params, source) => {
    if (method === 'Browser.downloadWillBegin') {
      const download = new ChromeDownload(params.guid, params.suggestedFilename, params.url, staging, pipe)
      downloads.set(params.guid, download); download.once('done', () => downloads.delete(params.guid)); host.download(download)
    } else if (method === 'Browser.downloadProgress') downloads.get(params.guid)?.progress(params)
    else if (source === sessionId) {
      if (method === 'Page.frameNavigated' && !params.frame.parentId) { url = params.frame.url; host.navigation(); host.location() }
      if (method === 'Page.navigatedWithinDocument') { url = params.url; host.navigation(); host.location() }
      if (method === 'Runtime.bindingCalled' && params.name === '__covanHumanInput') host.humanInput()
      if (method === 'Page.domContentEventFired') void send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }).then((response) => { title = String(response.result?.value ?? '').slice(0, 240); host.location() }).catch(() => {})
      if (method === 'Inspector.detached' && !disposed) host.lost()
      if (method === 'Fetch.requestPaused') {
        const allowed = /^(https?:|data:|blob:|about:)/i.test(params.request.url) && (params.resourceType !== 'Document' || host.allowNavigation(params.request.url))
        void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: params.requestId, ...(!allowed ? { errorReason: 'BlockedByClient' } : {}) }).catch(() => {})
      }
    }
  })
  const ready = (async () => {
    const targets = await pipe.send('Target.getTargets')
    targetId = targets.targetInfos.find((target: any) => target.type === 'page')?.targetId
    if (!targetId) targetId = (await pipe.send('Target.createTarget', { url: 'about:blank' })).targetId
    sessionId = (await pipe.send('Target.attachToTarget', { targetId, flatten: true })).sessionId
    await send('Page.enable'); await send('Runtime.enable')
    await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
    await pipe.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: staging, eventsEnabled: true })
    await send('Runtime.addBinding', { name: '__covanHumanInput' })
    // This fixed listener reports only that a trusted interaction happened, never keys/values.
    await send('Page.addScriptToEvaluateOnNewDocument', { source: 'for (const name of ["pointerdown","keydown"]) addEventListener(name, event => { if(event.isTrusted) globalThis.__covanHumanInput("input") }, true); addEventListener("click", event => { const link=event.target.closest?.("a[target]"); if(link){link.target="_self"} }, true); window.open = url => { location.href=url; return null }' })
    await send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'denied' }).catch(() => {})
  })()
  void ready.catch(() => { if (!disposed) host.lost() })
  child.once('exit', () => { if (!disposed) host.lost() })
  let closing: Promise<void> | undefined
  const close = () => {
    if (closing) return closing
    disposed = true
    for (const download of downloads.values()) download.cancel()
    closing = new Promise<void>((resolve) => {
      let terminate: ReturnType<typeof setTimeout>, kill: ReturnType<typeof setTimeout>
      const done = () => { clearTimeout(terminate); clearTimeout(kill); pipe.close(); try { fs.rmSync(staging, { recursive: true, force: true }) } catch { /* A locked temporary file must not prevent app shutdown. */ }; resolve() }
      if (child.exitCode !== null || !child.pid) { done(); return }
      child.once('exit', done)
      void pipe.send('Browser.close').catch(() => {})
      terminate = setTimeout(() => child.kill('SIGTERM'), 1500); terminate.unref()
      kill = setTimeout(() => child.kill('SIGKILL'), 3500); kill.unref()
    })
    return closing
  }
  const command: BrowserAdapter['cdp'] = async (method, params) => { await ready; if (disposed) throw new Error('本地浏览器已关闭'); return send(method, params) }
  return {
    capture: () => captureBrowserPage(command), input: (input, width, height) => inputBrowserPage(command, input, width, height),
    backend: 'local-chrome', label: '本地 Chrome / Edge', cdp: command,
    url: () => url, title: () => title, resize: () => {},
    load: async (value) => { await ready; const checked = browserUrl(value); if (!host.allowNavigation(checked)) throw new Error('网站导航已暂停'); const result = await send('Page.navigate', { url: checked }); if (result.errorText) throw new Error('网页加载失败'); url = checked; host.location();
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) { const result = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }); if (result.result?.value === 'complete') return; await new Promise((resolve) => setTimeout(resolve, 100)) }
      throw new Error('网页加载超过30秒')
    },
    stop: () => { if (sessionId && !disposed) void send('Page.stopLoading').catch(() => {}) },
    show: async () => { await ready; await send('Page.bringToFront') }, close,
  }
}
