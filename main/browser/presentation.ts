import type { BrowserInput } from '../../shared/types'
import type { Cdp } from './snapshot'

export async function captureBrowserPage(send: Cdp) {
  const metrics = await send('Page.getLayoutMetrics')
  const viewport = metrics.cssVisualViewport ?? metrics.visualViewport
  const width = Math.round(viewport.clientWidth), height = Math.round(viewport.clientHeight)
  if (!(width > 0 && height > 0 && width <= 10000 && height <= 10000)) throw new Error('浏览器视口不可用')
  const scale = Math.min(1, 1280 / width, 900 / height)
  const screenshot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 65, captureBeyondViewport: false, clip: { x: viewport.pageX ?? 0, y: viewport.pageY ?? 0, width, height, scale } })
  if (typeof screenshot.data !== 'string' || screenshot.data.length > 4 * 1024 * 1024) throw new Error('浏览器画面不可用')
  return { width, height, dataUrl: `data:image/jpeg;base64,${screenshot.data}` }
}
const keys: Record<string, { code: string; value: number }> = {
  Enter: { code: 'Enter', value: 13 }, Tab: { code: 'Tab', value: 9 }, Backspace: { code: 'Backspace', value: 8 }, Escape: { code: 'Escape', value: 27 }, Delete: { code: 'Delete', value: 46 },
  ArrowLeft: { code: 'ArrowLeft', value: 37 }, ArrowUp: { code: 'ArrowUp', value: 38 }, ArrowRight: { code: 'ArrowRight', value: 39 }, ArrowDown: { code: 'ArrowDown', value: 40 }, Home: { code: 'Home', value: 36 }, End: { code: 'End', value: 35 }, PageUp: { code: 'PageUp', value: 33 }, PageDown: { code: 'PageDown', value: 34 },
}
export async function inputBrowserPage(send: Cdp, input: BrowserInput, width: number, height: number) {
  if (!input || typeof input !== 'object') throw new Error('浏览器输入无效')
  if (input.type === 'click' || input.type === 'scroll') {
    if (![input.x, input.y].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error('浏览器坐标无效')
    const x = Math.min(width - 1, input.x * width), y = Math.min(height - 1, input.y * height)
    if (input.type === 'click') {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    } else {
      if (![input.deltaX, input.deltaY].every((value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 2000)) throw new Error('滚动量无效')
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: input.deltaX, deltaY: input.deltaY })
    }
  } else if (input.type === 'text') {
    if (typeof input.text !== 'string' || input.text.length > 4000) throw new Error('输入文本过长或无效')
    await send('Input.insertText', { text: input.text })
  } else if (input.type === 'key') {
    if (input.key === 'SelectAll') { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', commands: ['selectAll'] }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' }); return }
    const key = Object.hasOwn(keys, input.key) ? keys[input.key] : undefined
    if (!key) throw new Error('此按键不受支持')
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: input.key, code: key.code, windowsVirtualKeyCode: key.value })
    if (input.key === 'Enter') await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: input.key, code: key.code, windowsVirtualKeyCode: key.value })
  } else throw new Error('浏览器输入类型无效')
}
