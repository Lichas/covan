import { useEffect, useState } from 'react'
import type { BrowserHandoff } from '@shared/types'
import { api } from '../lib/api'
import './browserWorkspace.css'

export function BrowserHandoffCard({ botId, handoff }: { botId: string; handoff: BrowserHandoff }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const complete = async (completed: boolean) => {
    if (busy) return
    setBusy(true); setError('')
    try { await api.completeBrowserHandoff(botId, handoff.id, completed) }
    catch (reason) { setError((reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')) }
    finally { setBusy(false) }
  }
  return <section className="browser-handoff-card" aria-label={handoff.kind === 'control' ? '浏览器已接管' : handoff.kind === 'login' ? '需要登录' : '需要完成验证'}>
    <strong>{handoff.kind === 'control' ? '浏览器由你控制' : handoff.kind === 'login' ? '需要你登录' : '需要你完成验证'}</strong>
    <p>{handoff.reason}</p><p className="browser-handoff-origin">{handoff.origin}</p>
    <p>{handoff.kind === 'control' ? 'Agent 已暂停读取和操作。你可以点击、输入和滚动，交还后继续当前任务。' : '请在浏览器中完成，密码和验证码不经过模型。点击完成后，Agent 自动继续当前任务。'}</p>
    <div className="browser-handoff-actions"><button type="button" onClick={() => void api.openBrowser(botId).catch(() => setError('浏览器无法打开'))}>{handoff.kind === 'control' ? '打开浏览器窗口' : '打开登录窗口'}</button><button type="button" disabled={busy} onClick={() => void complete(true)}>{handoff.kind === 'control' ? '交还并继续' : '登录完成，继续'}</button><button type="button" disabled={busy} onClick={() => void complete(false)}>取消等待</button></div>
    {error && <p role="alert">{error}</p>}
  </section>
}

export function BrowserLoginCard({ botId, messageId }: { botId: string; messageId: string }) {
  const [handoff, setHandoff] = useState<BrowserHandoff | null>(null)
  useEffect(() => {
    let active = true, version = 0
    const refresh = async () => {
      const request = ++version
      try { const state = await api.getBrowserState(botId); if (active && request === version) setHandoff(state.handoff?.messageId === messageId ? state.handoff : null) }
      catch { if (active) setHandoff(null) }
    }
    void refresh()
    const unsubscribe = api.onEvent((event) => { if (event.type === 'browser-updated' && event.botId === botId) void refresh() })
    return () => { active = false; unsubscribe() }
  }, [botId, messageId])
  return handoff ? <BrowserHandoffCard key={handoff.id} botId={botId} handoff={handoff} /> : null
}
