// Capability-scoped web content. Never load generated HTML in the app origin.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { ipcMain, net, protocol, type WebContents } from 'electron'
import { CH } from '../shared/ipcChannels'
import type { WorkspaceHtmlPreview } from '../shared/types'
import { getBot } from './db'
import { resolveWorkspaceFile } from './workspace'

const SCHEME = 'covan-preview:'
const MAX_HTML_BYTES = 2 * 1024 * 1024
const MAX_ASSET_BYTES = 32 * 1024 * 1024
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: http: blob:",
  "style-src 'self' 'unsafe-inline' https: http:",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data: https: http:",
  "media-src 'self' data: blob: https: http:",
  "connect-src 'self' https: http:",
  "worker-src 'self' blob:",
  "frame-src 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'none'",
  'sandbox allow-scripts',
].join('; ')
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
}
const headers = {
  'Content-Security-Policy': CSP,
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=(), payment=()',
}
const previews = new Map<string, { botId: string; owner: WebContents }>()
const watched = new WeakSet<WebContents>()

function releaseOwner(owner: WebContents): void {
  for (const [id, preview] of previews) if (preview.owner === owner) previews.delete(id)
}

function watchOwner(owner: WebContents): void {
  if (watched.has(owner)) return
  watched.add(owner)
  owner.once('destroyed', () => releaseOwner(owner))
  owner.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) releaseOwner(owner)
  })
  // Sandbox stops top navigation/popups; also prevent navigating the preview
  // itself to another app protocol or to a page outside its capability.
  owner.on('will-frame-navigate', (event) => {
    const from = event.frame?.url || ''
    if (!from.startsWith(SCHEME) && !event.url.startsWith(SCHEME)) return
    const target = new URL(event.url)
    const preview = previews.get(target.hostname)
    if (target.protocol !== SCHEME || preview?.owner !== owner ||
      (from.startsWith(SCHEME) && new URL(from).hostname !== target.hostname)) event.preventDefault()
  })
}

function createPreview(owner: WebContents, botId: string, relative: string): WorkspaceHtmlPreview {
  if (typeof botId !== 'string' || !getBot(botId)) throw new Error('Bot 不存在，请刷新后重试')
  if (typeof relative !== 'string' || !/\.html?$/i.test(relative)) throw new Error('请选择 HTML 文件预览')
  const file = resolveWorkspaceFile(botId, relative)
  const stat = fs.statSync(file)
  if (!stat.isFile()) throw new Error('目标不是 HTML 文件')
  if (stat.size > MAX_HTML_BYTES) throw new Error('HTML 超过 2MB，请缩小文件后重试')
  if (fs.readFileSync(file).includes(0)) throw new Error('二进制文件不支持 HTML 预览')
  watchOwner(owner)
  releaseOwner(owner)
  const id = randomUUID()
  previews.set(id, { botId, owner })
  const encoded = relative.split('/').map(encodeURIComponent).join('/')
  return { id, url: `${SCHEME}//${id}/${encoded}` }
}

export function registerWorkspaceHtmlPreview(): void {
  protocol.handle('covan-preview', async (request) => {
    try {
      const url = new URL(request.url)
      const preview = previews.get(url.hostname)
      if (!preview || preview.owner.isDestroyed()) return new Response('预览已关闭，请重新打开', { status: 403, headers })
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('', { status: 405, headers })
      if (!getBot(preview.botId)) return new Response('Bot 不存在', { status: 404, headers })
      const relative = decodeURIComponent(url.pathname.slice(1))
      if (!relative || relative.includes('\\') || relative.includes('\0')) return new Response('', { status: 403, headers })
      const file = resolveWorkspaceFile(preview.botId, relative)
      const stat = fs.statSync(file)
      if (!stat.isFile()) return new Response('', { status: 404, headers })
      const ext = path.extname(file).toLowerCase()
      if (stat.size > (ext === '.html' || ext === '.htm' ? MAX_HTML_BYTES : MAX_ASSET_BYTES))
        return new Response('预览资源超过大小限制', { status: 413, headers })
      const response = request.method === 'HEAD' ? null : await net.fetch(pathToFileURL(file).toString())
      return new Response(response?.body ?? null, {
        status: response?.status ?? 200,
        headers: { ...headers, 'Content-Type': MIME[ext] || 'application/octet-stream' },
      })
    } catch { return new Response('无法载入预览资源，请确认文件位于当前工作区', { status: 404, headers }) }
  })
  ipcMain.handle(CH.createWorkspaceHtmlPreview, (event, botId: string, relative: string) => {
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('仅应用主页面可打开预览')
    return createPreview(event.sender, botId, relative)
  })
  ipcMain.handle(CH.releaseWorkspaceHtmlPreview, (event, id: string) => {
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('仅应用主页面可关闭预览')
    if (typeof id === 'string' && previews.get(id)?.owner === event.sender) previews.delete(id)
  })
}
