import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserState } from '@shared/types'
import { api } from '../lib/api'
import './browserWorkspace.css'
import { BrowserStream } from './BrowserPreview'
import { BrowserHandoffCard } from './BrowserLoginCard'

const labels: Record<string, string> = { open: '访问网站', click: '点击', fill: '填写', select: '选择', upload: '上传', download: '下载', snapshot: '读取', wait: '等待', downloads: '检查下载', login: '登录接管', verification: '验证接管', control: '人工接管' }
const statuses = { done: '已执行', denied: '已拒绝', error: '未完成', interrupted: '已中断' }
const downloadStatuses = { pending: '待确认', downloading: '下载中', done: '已保存', cancelled: '已取消', error: '未完成' }

export function BrowserWorkspace({ botId }: { botId: string }) {
  const [state, setState] = useState<BrowserState | null>(null)
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [resetConfirm, setResetConfirm] = useState(false)
  const [responding, setResponding] = useState(false)
  const version = useRef(0)
  const refresh = useCallback(async () => {
    const request = ++version.current
    try { const next = await api.getBrowserState(botId); if (request === version.current) setState(next) }
    catch { setError('浏览器状态无法读取，请重新打开工作台。') }
  }, [botId])
  useEffect(() => {
    void refresh()
    let timer: ReturnType<typeof setTimeout> | undefined
    const dispose = api.onEvent((event) => {
      if (event.type === 'browser-updated' && event.botId === botId) { clearTimeout(timer); timer = setTimeout(() => void refresh(), 40) }
    })
    return () => { clearTimeout(timer); dispose(); version.current += 1 }
  }, [botId, refresh])
  useEffect(() => { if (state?.url) setUrl(state.url) }, [state?.url])
  const act = async (action: () => Promise<unknown>) => {
    setError('')
    try { await action(); await refresh() }
    catch (reason) { setError((reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')) }
  }
  const respond = async (approved: boolean) => {
    if (!state?.pending || responding) return
    setResponding(true)
    await act(() => api.respondBrowserApproval(botId, state.pending!.id, approved))
    setResponding(false)
  }
  return <main className="browser-workspace" aria-label="浏览器工作台">
    <header className="browser-toolbar">
      <div className="browser-heading"><div><strong>{state?.botName ?? 'Covan'} <span>浏览器</span></strong><small>独立登录环境 · 网页与应用隔离</small></div>
        <div className="browser-toolbar-actions"><select aria-label="浏览器执行模式" value={state?.policy ?? 'auto'} disabled={!!state?.handoff} onChange={(event) => void act(() => api.setBrowserPolicy(botId, event.target.value as 'auto' | 'confirm'))}><option value="auto">自动执行</option><option value="confirm">每步确认</option></select><span className={`browser-control-status ${state?.mode ?? ''}`}>{state?.handoff ? state.handoff.kind === 'control' ? '由你控制' : '等待登录' : state?.mode === 'human' ? '你正在接管' : state?.busy ? 'Agent 正在处理' : 'Agent 可操作'}</span>
          <button className="browser-primary" onClick={() => void act(() => state?.handoff ? api.completeBrowserHandoff(botId, state.handoff.id, true) : state?.mode === 'human' ? api.setBrowserControl(botId, 'agent') : api.takeOverBrowser(botId))}>{state?.handoff ? '完成并继续' : state?.mode === 'human' ? '交给 Agent' : '接管浏览器'}</button>
          <button onClick={() => void api.closeBrowser(botId)}>关闭</button>
        </div>
      </div>
      <form className="browser-address" onSubmit={(event) => { event.preventDefault(); void act(() => api.navigateBrowser(botId, url)) }}>
        <input aria-label="浏览器网址" placeholder="https://example.com" value={url} disabled={state?.mode !== 'human'} onChange={(event) => setUrl(event.target.value)} />
        <button type="submit" disabled={state?.mode !== 'human'}>前往</button>
      </form>
      <p className="browser-notice" role="status">{error || state?.notice || (state?.policy === 'confirm' ? '每步确认模式；页面交互将在左侧请求确认。' : '浏览器动作自动执行；遇到登录或验证码会显示接管卡，完成后自动继续。')}</p>
    </header>
    <aside className="browser-sidebar">
      {state?.handoff ? <BrowserHandoffCard botId={botId} handoff={state.handoff} /> : state?.pending ? <section className="browser-approval" aria-label="浏览器操作确认">
        <span className="browser-eyebrow">等待你确认</span><h2>{state.pending.summary}</h2><p className="browser-origin">{state.pending.origin}</p>
        <div className="browser-approval-details">{state.pending.details.map((detail, index) => <p key={index}>{detail}</p>)}</div>
        <p className="browser-muted">仅执行这一次操作；页面或控制权变化后确认失效。</p>
        <div className="browser-approval-actions"><button className="browser-primary" disabled={responding} onClick={() => void respond(true)}>确认执行</button><button disabled={responding} onClick={() => void respond(false)}>拒绝</button></div>
      </section> : <section className="browser-explanation"><h2>{state?.mode === 'human' ? '现在由你操作' : '你始终掌握控制权'}</h2><p>可在右侧查看真实网页。接管后，Agent 会停止读取和操作；完成后交还，Agent 会从当前页面继续任务。</p></section>}
      <section><h2>下载文件</h2>{state?.downloads.length ? <ul className="browser-downloads">{state.downloads.map((item) => <li key={item.id}><strong>{item.name}</strong><span>{downloadStatuses[item.status]}{item.bytes ? ` · ${Math.ceil(item.bytes / 1024)} KB` : ''}</span>{item.relPath && item.status === 'done' && <button onClick={() => void act(() => api.revealWorkspaceFile(botId, item.relPath!))}>在文件夹中显示</button>}</li>)}</ul> : <p className="browser-muted">保存至 Bot 工作区，不自动打开。</p>}</section>
      <section><h2>近期活动</h2>{state?.activities.length ? <ol className="browser-activities">{state.activities.map((item) => <li key={item.id}><span>{labels[item.action] ?? item.action} · {statuses[item.status]}</span><time>{new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></li>)}</ol> : <p className="browser-muted">执行记录会出现在这里。</p>}</section>
      <section className="browser-session"><button onClick={() => setResetConfirm(!resetConfirm)}>清除本 Bot 登录态</button>{resetConfirm && <><p className="browser-muted">将关闭工作台并退出其中的网站，不影响其他 Bot 或系统浏览器。</p><button className="browser-danger" onClick={() => void act(() => api.resetBrowserSession(botId))}>确认清除</button></>}</section>
    </aside>
    {state?.backend === 'local-chrome' ? <div className="browser-external-stream">{state.currentTaskId ? <BrowserStream botId={botId} taskId={state.currentTaskId} interactive={state.mode === 'human'} /> : <button onClick={() => void act(() => api.showBrowserNative(botId))}>打开本地 Chrome 窗口</button>}</div> : <div className="browser-native-placeholder" aria-hidden="true">右侧为隔离的网页浏览区域</div>}
  </main>
}
