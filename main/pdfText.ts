import { randomUUID } from 'node:crypto'
import { BrowserWindow, session } from 'electron'
import { readPdfJsAsset } from './printing/pdf'

/** Parse untrusted PDFs off the main thread, in a disposable browser session with no network or host bridge. */
export async function extractPdfText(data: Buffer, maxChars: number): Promise<{ text: string; pages: number; truncated: boolean }> {
  const isolated = session.fromPartition(`covan-pdf-text-${randomUUID()}`)
  isolated.webRequest.onBeforeRequest((request, callback) => {
    callback({ cancel: !request.url.startsWith('https://attachment.invalid/') })
  })
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  await isolated.protocol.handle('https', (request) => {
    const url = new URL(request.url)
    if (url.origin !== 'https://attachment.invalid') return new Response('', { status: 403 })
    const headers = { 'Content-Security-Policy': "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'", 'Cache-Control': 'no-store' }
    if (url.pathname === '/') return new Response('<!doctype html><title>PDF 文字提取</title>', { headers: { ...headers, 'Content-Type': 'text/html' } })
    if (url.pathname === '/source.pdf') return new Response(new Uint8Array(data), { headers })
    try {
      const asset = readPdfJsAsset(url.pathname.slice(1))
      return new Response(new Uint8Array(asset.bytes), { headers: { ...headers, 'Content-Type': asset.mime } })
    } catch { return new Response('', { status: 404 }) }
  })
  const win = new BrowserWindow({ show: false, webPreferences: {
    session: isolated, sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false,
  } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        await win.loadURL('https://attachment.invalid/')
        const result = await win.webContents.executeJavaScript(`(async () => {
          const { getDocument, GlobalWorkerOptions } = await import('/legacy/build/pdf.mjs');
          GlobalWorkerOptions.workerSrc = '/legacy/build/pdf.worker.mjs';
          const response = await fetch('/source.pdf');
          const task = getDocument({ data: new Uint8Array(await response.arrayBuffer()), isEvalSupported: false,
            useWasm: false, cMapPacked: true, cMapUrl: '/cmaps/', standardFontDataUrl: '/standard_fonts/' });
          task.onPassword = () => { void task.destroy(); };
          try {
            const pdf = await task.promise;
            if (pdf.numPages > 200) throw new Error('PDF 超过 200 页，请拆分后上传');
            let text = '', truncated = false;
            for (let number = 1; number <= pdf.numPages; number++) {
              const page = await pdf.getPage(number);
              const content = await page.getTextContent();
              const words = content.items.map((item) => item.str === undefined ? '' : item.str + (item.hasEOL ? '\\n' : ' ')).join('');
              text += '[第 ' + number + ' 页]\\n' + words + '\\n';
              page.cleanup();
              if (text.length > ${maxChars}) { text = text.slice(0, ${maxChars}); truncated = true; break; }
            }
            if (!text.replace(/\\[第 \\d+ 页\\]/g, '').trim()) throw new Error('扫描 PDF 没有可提取文字，请先进行 OCR');
            return { text, pages: pdf.numPages, truncated };
          } finally { await task.destroy().catch(() => {}); }
        })()`)
        return result as { text: string; pages: number; truncated: boolean }
      })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('PDF 文字提取超时，请拆分后上传')), 20_000) }),
    ])
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (/200 页|OCR|超时/.test(message)) throw new Error(message.replace(/^Error invoking remote method.*?: /, ''))
    throw new Error('PDF 无法提取文字，请检查文件是否损坏或加密；加密文件请先解锁另存')
  } finally {
    clearTimeout(timer)
    if (!win.isDestroyed()) win.destroy()
    isolated.protocol.unhandle('https')
  }
}
