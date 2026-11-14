import { useEffect, useRef, useState } from 'react'
import type { GoalExecution, GoalExecutionAction } from '@shared/types'
import { EXECUTION_LABELS, isExecutionOpen } from '@shared/goalExecution'
import { api } from '../lib/api'

export function ExecutionActions({ run, disabled = false, reload }: { run: GoalExecution; disabled?: boolean; reload: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const act = async (action: GoalExecutionAction) => {
    setBusy(true); setError('')
    try { await api.controlGoalExecution(run.id, action); reload() }
    catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  const canPause = ['queued', 'running', 'waiting_experts', 'waiting_input', 'blocked'].includes(run.status)
  const canResume = ['paused', 'blocked', 'error'].includes(run.status)
  return <>
    {canPause && <button type="button" disabled={disabled || busy} onClick={() => void act('pause')}>暂停执行</button>}
    {canResume && <button type="button" disabled={disabled || busy} onClick={() => void act('resume')}>{run.status === 'error' ? '重试本轮' : '继续执行'}</button>}
    {run.status === 'review' && !run.parentExecutionId && <button type="button" disabled={disabled || busy} onClick={() => void act('accept')}>验收本轮</button>}
    {(isExecutionOpen(run.status) || run.status === 'error') && <button type="button" disabled={disabled || busy} onClick={() => void act('stop')}>停止此任务</button>}
    {error && <p className="goal-card-error" role="alert">{error}</p>}
  </>
}

function ExecutionItem({ run, children, reload }: { run: GoalExecution; children: GoalExecution[]; reload: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<{ text: string; id: string }>()
  const open = isExecutionOpen(run.status) || run.status === 'error'
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!text.trim() || busy || !open) return
    if (request.current?.text !== text.trim()) request.current = { text: text.trim(), id: crypto.randomUUID() }
    setBusy(true); setError('')
    try {
      await api.sendGoalExecutionInput(run.id, request.current.text, request.current.id)
      setText(''); request.current = undefined; reload()
    } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  return <details className="goal-task" open={open} data-execution-id={run.id}>
    <summary>{run.parentExecutionId ? '专家 ' : ''}{run.goalTitle} · {run.botName} · {run.parentExecutionId && run.status === 'done' ? '报告已回写' : EXECUTION_LABELS[run.status]}{run.status === 'queued' && run.queuePosition ? `（队列 ${run.queuePosition}）` : ''}</summary>
    {run.reason && <p className="goal-muted">{run.reason}</p>}
    {open && <>
      <p className="goal-muted">可继续聊天。补充只交给此任务；暂停时保留补充，点击继续后处理。累计执行上限 10 分钟。</p>
      <form className="goal-update-form" onSubmit={(event) => void submit(event)}>
        <input aria-label={`补充给${run.parentExecutionId ? run.botName : run.goalTitle}`} value={text} maxLength={2000} disabled={busy} onChange={(event) => setText(event.target.value)} placeholder={run.status === 'review' ? '填写修改意见后重新提交' : '填写补充信息或要求'} />
        <button type="submit" disabled={busy || !text.trim()}>补充要求</button>
      </form>
      <div className="goal-card-actions"><ExecutionActions run={run} disabled={busy} reload={reload} /></div>
    </>}
    {run.inputs?.map((input) => <p key={input.id} className="goal-task-input">{input.text} <small>{input.sourceMessageId ? '来自聊天 · ' : ''}{input.delivered ? '已送达执行步骤' : open ? '等待处理' : '尚未处理'}</small></p>)}
    {children.map((child) => <ExecutionItem key={child.id} run={child} children={[]} reload={reload} />)}
    {error && <p className="goal-card-error" role="alert">{error}</p>}
  </details>
}

export function GoalExecutionTray({ chatId }: { chatId: string }) {
  const [runs, setRuns] = useState<GoalExecution[]>([])
  const [error, setError] = useState('')
  const refresh = useRef<() => void>(() => {})
  useEffect(() => {
    let alive = true
    let revision = 0
    const reload = () => {
      const current = ++revision
      void api.listGoalExecutions(chatId).then((next) => {
        if (alive && current === revision) { setRuns(next); setError('') }
      }).catch(() => { if (alive && current === revision) setError('后台任务读取失败，请重试') })
    }
    refresh.current = reload
    reload()
    const unsubscribe = api.onEvent((event) => {
      if (event.type === 'goal-updated' || event.type === 'goal-deleted') reload()
    })
    return () => { alive = false; unsubscribe() }
  }, [chatId])
  const roots = runs.filter((run) => !run.parentExecutionId).filter((run, index) => isExecutionOpen(run.status) || run.status === 'error' || index < 4)
  if (!roots.length && !error) return null
  return <section className="goal-task-tray" aria-label="后台目标任务">
    {error && <button type="button" onClick={() => refresh.current()}>{error}</button>}
    {roots.map((run) => <ExecutionItem key={run.id} run={run} children={runs.filter((child) => child.parentExecutionId === run.id)} reload={() => refresh.current()} />)}
  </section>
}
