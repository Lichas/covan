import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { Globe, Hand, Monitor, Radio, X } from 'lucide-react'
import type { BrowserFrame, BrowserInput } from '@shared/types'
import { api } from '../lib/api'
import { useBrowserState } from '../stores/browserStore'
import { useUiStore } from '../stores/uiStore'
import { BrowserHandoffCard } from './BrowserLoginCard'
import './browserPreview.css'

function cleanError(reason: unknown) { return String(reason instanceof Error ? reason.message : reason).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') }

/** User-only stream: never used in model context, persisted or included in chat exports. */
export function BrowserStream({ botId, taskId, interactive = false, live = true }: { botId: string; taskId: string; interactive?: boolean; live?: boolean }) {
  const element = useRef<HTMLDivElement>(null)
  const current = useRef<BrowserFrame | null>(null)
  const [frame, setFrame] = useState<BrowserFrame | null>(null)
  const [visible, setVisible] = useState(false)
  const [documentVisible, setDocumentVisible] = useState(document.visibilityState === 'visible')
  useEffect(() => { const update = () => setDocumentVisible(document.visibilityState === 'visible'); document.addEventListener('visibilitychange', update); return () => document.removeEventListener('visibilitychange', update) }, [])
  const [error, setError] = useState('')
  const queue = useRef(Promise.resolve())
  const inputSender = useRef<(input: BrowserInput) => void>(() => {})
  const composing = useRef(false)
  const typing = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting))
    if (element.current) observer.observe(element.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>
    current.current = null; setFrame(null)
    const tick = async () => {
      if (!active) return
      if (visible && documentVisible) {
        try { const next = await api.getBrowserFrame(botId, taskId); if (active) { current.current = next; setFrame(next) } } catch { if (active) { current.current = null; setFrame(null) } }
      }
      if (active && live) timer = setTimeout(() => void tick(), 350)
    }
    void tick()
    return () => { active = false; clearTimeout(timer); current.current = null }
  }, [botId, taskId, visible, live, interactive, documentVisible])
  const send = (input: BrowserInput) => {
    if (!interactive) return
    queue.current = queue.current.then(async () => {
      const next = current.current
      if (!next) return
      try { await api.sendBrowserInput(botId, taskId, next.id, input); setError('') }
      catch (reason) { setError(cleanError(reason)) }
    })
  }
  const point = (event: MouseEvent<HTMLImageElement>) => { const rect = event.currentTarget.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) } }
  inputSender.current = send
  useEffect(() => {
    const target = element.current
    if (!target || !interactive) return
    const wheel = (event: WheelEvent) => {
      const image = target.querySelector('img')
      if (!image) return
      const bounds = image.getBoundingClientRect()
      if (event.clientY < bounds.top || event.clientY > bounds.bottom) return
      event.preventDefault()
      inputSender.current({ type: 'scroll', x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)), deltaX: Math.max(-2000, Math.min(2000, event.deltaX)), deltaY: Math.max(-2000, Math.min(2000, event.deltaY)) })
    }
    target.addEventListener('wheel', wheel, { passive: false })
    return () => target.removeEventListener('wheel', wheel)
  }, [interactive])
  const onKey = (event: KeyboardEvent) => {
    if (!interactive || composing.current || event.nativeEvent.isComposing) return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); send({ type: 'key', key: 'SelectAll' }); return }
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key.length === 1) { event.preventDefault(); send({ type: 'text', text: event.key }) }
    else if (['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) { event.preventDefault(); send({ type: 'key', key: event.key }) }
  }
  return <div ref={element} className={`browser-stream ${interactive ? 'is-controlling' : ''}`}>
    {frame ? <div className="browser-stream-input" role={interactive ? 'textbox' : undefined} aria-label={interactive ? '浏览器画面控制' : undefined} aria-multiline={interactive || undefined} tabIndex={interactive ? 0 : -1} onKeyDown={onKey}
      onPaste={(event) => { if (interactive) { event.preventDefault(); send({ type: 'text', text: event.clipboardData.getData('text/plain') }) } }}
      onCompositionStart={() => { composing.current = true }} onCompositionEnd={(event) => { composing.current = false; if (event.data) send({ type: 'text', text: event.data }); if (typing.current) typing.current.value = '' }}>
      {interactive && <textarea ref={typing} className="browser-remote-typing" aria-label="浏览器键盘输入" autoComplete="off" onChange={(event) => { if (!composing.current && event.target.value) { send({ type: 'text', text: event.target.value }); event.target.value = '' } }} />}
      <img src={frame.dataUrl} alt="浏览器实时画面" draggable={false} onClick={(event) => { if (interactive) { typing.current?.focus(); send({ type: 'click', ...point(event) }) } }} />
    </div> : <div className="browser-stream-empty"><Monitor size={24} /><span>等待浏览器画面 · 旧预览在关闭或重启后失效</span></div>}
    {error && <p role="alert" className="browser-input-error">{error}</p>}
  </div>
}

export function BrowserTaskCard({ botId, messageId }: { botId: string; messageId: string }) {
  const state = useBrowserState(botId)
  const task = state?.tasks.find((entry) => entry.messageId === messageId)
  if (!task) return null
  const live = state?.opened && state.currentTaskId === task.id
  return <section className="browser-task-card" aria-label="浏览器任务">
    <header><span className="browser-task-icon"><Globe size={21} /></span><div><strong>浏览器</strong><p>{task.label}</p></div><small>{live ? state.mode === 'human' ? '你正在控制' : '实时' : '已结束'}</small></header>
    <BrowserStream botId={botId} taskId={task.id} live={!!live} />
    <footer><span>{live ? state.title || state.url || '正在加载网页' : task.backend === 'local-chrome' ? '本地 Chrome / Edge' : '内置 Chromium'}</span><button onClick={() => useUiStore.getState().setBrowserPreview({ botId, taskId: task.id })}>打开浏览器</button></footer>
  </section>
}

export function BrowserPreviewPanel() {
  const target = useUiStore((store) => store.browserPreview)
  return target ? <BrowserPreviewContent key={`${target.botId}/${target.taskId}`} {...target} /> : null
}
function BrowserPreviewContent({ botId, taskId }: { botId: string; taskId: string }) {
  const state = useBrowserState(botId)
  const task = state?.tasks.find((entry) => entry.id === taskId)
  const connected = !!state?.opened && state.currentTaskId === taskId
  const [error, setError] = useState(''), [url, setUrl] = useState(''), [working, setWorking] = useState(false)
  useEffect(() => setUrl(state?.url ?? ''), [state?.url])
  const act = async (action: () => Promise<unknown>) => { setWorking(true); setError(''); try { await action() } catch (reason) { setError(cleanError(reason)) } finally { setWorking(false) } }
  return <aside className="browser-preview-panel" aria-label="浏览器预览">
    <header className="browser-preview-header"><div><strong>{task?.label ?? '浏览器'}</strong><small>{(task?.backend ?? state?.backend) === 'local-chrome' ? '本地 Chrome / Edge' : '内置 Chromium'} · {connected ? state?.handoff ? '等待你操作' : state?.mode === 'human' ? '由你控制' : state?.busy ? 'Agent 正在操作' : task?.status === 'live' ? 'Agent 准备下一步' : '本轮任务已结束' : '预览已结束'}</small></div><button aria-label="关闭浏览器预览" onClick={() => useUiStore.getState().setBrowserPreview(null)}><X size={18} /></button></header>
    <div className="browser-preview-actions"><button disabled={!connected || working} className="browser-takeover" onClick={() => void act(() => state?.mode === 'human' ? state.handoff ? api.completeBrowserHandoff(botId, state.handoff.id, true) : api.setBrowserControl(botId, 'agent') : api.takeOverBrowser(botId))}><Hand size={14} />{state?.mode === 'human' ? state.handoff ? '交还并继续' : '交给 Agent' : '接管浏览器'}</button>
      <button disabled={!connected || working} onClick={() => void act(() => api.showBrowserNative(botId))}>打开本地窗口</button>
      <button disabled={!connected || working || task?.status !== 'live'} onClick={() => void act(async () => { if (task) await api.stopChat(task.chatId); await api.setBrowserControl(botId, 'human') })}>停止</button>
    </div>
    <form className="browser-preview-address" onSubmit={(event) => { event.preventDefault(); void act(() => api.navigateBrowser(botId, url)) }}><Globe size={14} /><input aria-label="预览浏览器网址" disabled={!connected || state?.mode !== 'human'} value={url} onChange={(event) => setUrl(event.target.value)} /><button disabled={!connected || state?.mode !== 'human' || working}>前往</button></form>
    <p className="browser-preview-hint"><Radio size={12} />{connected ? state?.mode === 'human' ? '点击画面后可输入、粘贴和滚动；完成后交还 Agent。' : '正在显示真实浏览器画面，接管后可直接操作。' : '此任务的画面已失效；新任务会创建新的浏览器卡片。'}</p>
    {error && <p className="browser-preview-error" role="alert">{error}</p>}
    <div className="browser-preview-body"><BrowserStream botId={botId} taskId={taskId} interactive={connected && state?.mode === 'human'} live={connected} />
      {connected && state?.handoff && <BrowserHandoffCard key={state.handoff.id} botId={botId} handoff={state.handoff} />}
      {connected && state?.pending && <section className="browser-preview-approval" aria-label="预览浏览器操作确认"><strong>{state.pending.summary}</strong>{state.pending.details.map((detail, index) => <p key={index}>{detail}</p>)}<button disabled={working} onClick={() => void act(() => api.respondBrowserApproval(botId, state.pending!.id, true))}>确认执行</button><button disabled={working} onClick={() => void act(() => api.respondBrowserApproval(botId, state.pending!.id, false))}>拒绝</button></section>}
    </div>
  </aside>
}

export function BrowserBackendSelector({ botId }: { botId: string }) {
  const state = useBrowserState(botId)
  const [error, setError] = useState('')
  return <div className="browser-backend-selector"><label>浏览器环境<select aria-label="浏览器环境" value={state?.backend ?? 'embedded'} disabled={state?.busy || state?.tasks.some((task) => task.id === state.currentTaskId && task.status === 'live')} onChange={(event) => { setError(''); void api.setBrowserBackend(botId, event.target.value as 'embedded' | 'local-chrome').catch((reason) => setError(cleanError(reason))) }}>{(state?.availableBackends ?? [{ id: 'embedded', label: '内置 Chromium' }]).map((backend) => <option key={backend.id} value={backend.id}>{backend.label}</option>)}</select></label>{error && <p role="alert">{error}</p>}</div>
}
