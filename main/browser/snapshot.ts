import { randomUUID } from 'node:crypto'

export type Cdp = (method: string, parameters?: Record<string, unknown>) => Promise<any>
export interface BrowserChallenge { kind: 'login' | 'verification'; reason: string }
const CHALLENGE_SCRIPT = String.raw`(() => {
  const visible = (element) => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < innerHeight && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0'; };
  const inputs = Array.from(document.querySelectorAll('input')).filter((element) => visible(element) && !element.disabled && !element.readOnly);
  if (inputs.some((element) => element.autocomplete === 'one-time-code' || /(^|[-_])(otp|smscode|authcode|verificationcode)([-_]|$)/i.test(element.id + ' ' + element.name))) return {kind:'verification',reason:'网站需要你手动完成验证码验证'};
  if (Array.from(document.querySelectorAll('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare"],.g-recaptcha,.h-captcha')).some(visible)) return {kind:'verification',reason:'网站需要你完成人机验证'};
  const authentication = /log\s*in|sign\s*in|登录|登入|身份验证|账户验证|扫码登录/i;
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,[role=heading],button,[type=submit]')).filter(visible).map((element) => element.textContent || '').join(' ');
  const route = /\/(login|signin|sign-in|auth|authenticate)(\/|$)/i.test(location.pathname);
  const password = inputs.some((element) => element.type === 'password');
  if (password && (route || authentication.test(document.title + ' ' + headings) || inputs.some((element) => element.autocomplete === 'username'))) return {kind:'login',reason:'网站需要登录，请在浏览器中手动输入账号和密码'};
  if ((route || authentication.test(headings)) && Array.from(document.querySelectorAll('canvas,img,[role=img]')).some((element) => visible(element) && ((route && element.tagName === 'CANVAS') || /qr|二维码|扫码/i.test(element.getAttribute('alt') || element.getAttribute('aria-label') || element.id)))) return {kind:'login',reason:'网站需要扫码登录，请在浏览器中完成'};
  return null;
})()`
export async function detectBrowserChallenge(cdp: Cdp): Promise<BrowserChallenge | null> {
  const response = await cdp('Runtime.evaluate', { expression: CHALLENGE_SCRIPT, returnByValue: true })
  if (response.exceptionDetails) return null
  return response.result?.value ?? null
}
export interface BrowserTarget { backendNodeId: number; name: string; role: string; tag: string; type: string; signature: string; sensitive: boolean }
const roles = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menuitem', 'tab', 'switch', 'spinbutton', 'slider'])
const sensitive = /password|passwd|passcode|secret|\botp\b|\bpin\b|one.?time|verification.?code|security.?code|auth.?code|credit.?card|card.?number|cvc|cvv|密码|验证码|密钥|银行卡|信用卡/i

export function browserUrl(value: string): string {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('网址无效')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('请输入完整的 http:// 或 https:// 网址') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('浏览器只允许不含凭据的 HTTP(S) 网址')
  return url.href
}
export function publicUrl(value: string): string {
  try { const url = new URL(browserUrl(value)); url.search = ''; url.hash = ''; return url.href } catch { return '' }
}
export function browserDownloadOrigin(value: string, currentUrl: string): string {
  if (value.startsWith('blob:')) {
    const source = new URL(browserUrl(value.slice(5))).origin
    if (source !== new URL(browserUrl(currentUrl)).origin) throw new Error('Blob 下载来源与当前网站不一致')
    return source
  }
  return new URL(browserUrl(value)).origin
}

export async function describeTarget(cdp: Cdp, backendNodeId: number): Promise<BrowserTarget> {
  const [{ node }, accessibility] = await Promise.all([
    cdp('DOM.describeNode', { backendNodeId }), cdp('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false }),
  ])
  const attributes: Record<string, string> = {}
  for (let i = 0; i < (node.attributes?.length ?? 0); i += 2) attributes[node.attributes[i]] = node.attributes[i + 1]
  const ax = accessibility.nodes?.find((entry: any) => entry.backendDOMNodeId === backendNodeId) ?? accessibility.nodes?.[0]
  const name = String(ax?.name?.value ?? attributes['aria-label'] ?? attributes.placeholder ?? '').slice(0, 240)
  const role = String(ax?.role?.value ?? '')
  const type = (attributes.type ?? '').toLowerCase()
  const tag = String(node.localName ?? '').toLowerCase()
  return { backendNodeId, name, role, type, tag,
    sensitive: type === 'password' || type === 'hidden' || attributes.disabled !== undefined || attributes.readonly !== undefined || attributes['aria-disabled'] === 'true' || sensitive.test([name, attributes.id, attributes.name, attributes.autocomplete].join(' ')),
    signature: JSON.stringify([tag, type, role, name, attributes.href, attributes.formaction, attributes.name, attributes.autocomplete]),
  }
}

export async function readSnapshot(cdp: Cdp) {
  const { nodes } = await cdp('Accessibility.getFullAXTree')
  const byId = new Map<string, any>((nodes ?? []).map((node: any) => [node.nodeId, node]))
  const hiddenValues = new Set<string>()
  const hideChildren = (id: string) => {
    if (hiddenValues.has(id)) return
    hiddenValues.add(id)
    for (const child of byId.get(id)?.childIds ?? []) hideChildren(child)
  }
  for (const node of nodes ?? []) if (['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(node.role?.value)) hideChildren(node.nodeId)
  const targets = new Map<string, BrowserTarget>()
  const text: string[] = []
  const elements: { ref: string; role: string; name: string; type?: string; state: Record<string, string | boolean> }[] = []
  let chars = 0
  for (const node of (nodes ?? []).slice(0, 1500)) {
    if (node.ignored) continue
    const role = String(node.role?.value ?? '')
    const name = String(node.name?.value ?? '').slice(0, 500)
    if (!hiddenValues.has(node.nodeId) && (role === 'StaticText' || role === 'heading')) {
      if (chars + name.length <= 20_000) { text.push(name); chars += name.length }
    }
    if (targets.size >= 80 || !node.backendDOMNodeId) continue
    if (!roles.has(role)) continue
    try {
      const target = await describeTarget(cdp, node.backendDOMNodeId)
      if (target.sensitive) continue
      const ref = `e${targets.size + 1}`
      targets.set(ref, target)
      const state: Record<string, string | boolean> = {}
      for (const property of node.properties ?? []) if (['checked', 'selected', 'expanded', 'required'].includes(property.name)) state[property.name] = typeof property.value?.value === 'boolean' ? property.value.value : String(property.value?.value ?? '').slice(0, 50)
      elements.push({ ref, role: target.type === 'file' ? 'file' : role, name: target.name, state, ...(target.type ? { type: target.type } : {}) })
    } catch { /* Detached nodes are omitted; the next snapshot reflects the new page. */ }
  }
  return { snapshotId: randomUUID(), targets, text: text.join('\n'), elements }
}
