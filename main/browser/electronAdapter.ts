import { WebContentsView, session, type BrowserWindow } from 'electron'
import type { AdapterHost, BrowserAdapter } from './adapter'
import { browserUrl } from './snapshot'
import { captureBrowserPage, inputBrowserPage } from './presentation'

export const browserPartition = (botId: string) => `persist:covan-browser-${botId}`
export function createElectronAdapter(host: AdapterHost, window: BrowserWindow): BrowserAdapter {
  const isolated = session.fromPartition(browserPartition(host.botId))
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolated.setPermissionCheckHandler(() => false)
  isolated.webRequest.onBeforeRequest((request, callback) => callback({ cancel: !/^(https?:|data:|blob:|about:)/i.test(request.url) }))
  const view = new WebContentsView({ webPreferences: { session: isolated, sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true, backgroundThrottling: false } })
  window.contentView.addChildView(view)
  const contents = view.webContents
  contents.setAudioMuted(true)
  const resize = () => { const [width, height] = window.getContentSize(); view.setBounds({ x: 300, y: 140, width: Math.max(1, width - 300), height: Math.max(1, height - 140) }) }
  window.on('resize', resize); resize()
  contents.on('did-navigate', host.location); contents.on('did-navigate-in-page', host.location); contents.on('page-title-updated', host.location)
  contents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) host.navigation() })
  const navigation = (event: Electron.Event, url: string) => { if (!host.allowNavigation(url)) event.preventDefault() }
  contents.on('will-navigate', navigation); contents.on('will-redirect', navigation)
  contents.setWindowOpenHandler(({ url }) => { if (host.allowNavigation(url)) void contents.loadURL(browserUrl(url)).catch(() => {}); return { action: 'deny' } })
  contents.on('before-input-event', (event) => { if (host.humanInput()) event.preventDefault() })
  contents.on('before-mouse-event', (event, input) => { if (input.type === 'mouseDown' && host.humanInput()) event.preventDefault() })
  contents.on('render-process-gone', host.lost)
  const download = (_event: Electron.Event, item: Electron.DownloadItem) => host.download(item)
  isolated.on('will-download', download)
  const send: BrowserAdapter['cdp'] = async (method, parameters) => { if (!contents.debugger.isAttached()) contents.debugger.attach('1.3'); return contents.debugger.sendCommand(method, parameters) }
  return {
    capture: () => captureBrowserPage(send), input: (input, width, height) => inputBrowserPage(send, input, width, height),
    backend: 'embedded', label: '内置 Chromium',
    cdp: send,
    url: () => contents.isDestroyed() ? '' : contents.getURL(), title: () => contents.isDestroyed() ? '' : contents.getTitle(),
    load: (url) => contents.loadURL(url), stop: () => { if (!contents.isDestroyed()) contents.stop() }, show: async () => { window.show() }, resize,
    close: () => { window.removeListener('resize', resize); isolated.removeListener('will-download', download); if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false }); void isolated.cookies.flushStore().catch(() => {}) },
  }
}
