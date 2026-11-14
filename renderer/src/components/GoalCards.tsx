import { useCallback, useEffect, useState } from 'react'
import type { Goal, GoalCategory, GoalSource, GoalStatus } from '@shared/types'
import { EXECUTION_LABELS, isExecutionOpen } from '@shared/goalExecution'
import { ExecutionActions } from './GoalExecutionTray'
import { api } from '../lib/api'
import { useBotsStore } from '../stores/botsStore'
import { useChatsStore } from '../stores/chatsStore'
import { useUiStore } from '../stores/uiStore'

const STATUS_LABEL: Record<GoalStatus, string> = {
  ACTIVE: '进行中',
  PAUSED: '已暂停',
  COMPLETED: '已完成',
  RETIRED: '已归档',
}

const CATEGORIES: { value: GoalCategory; label: string }[] = [
  { value: 'HEALTH', label: '健康' },
  { value: 'RELATIONSHIPS', label: '关系' },
  { value: 'MONEY', label: '财务' },
  { value: 'CAREER', label: '事业' },
  { value: 'INTERESTS', label: '兴趣' },
  { value: 'PRODUCTIVITY', label: '效率' },
  { value: 'SOMETHING_ELSE', label: '其他' },
]

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function GoalStatusTag({ status }: { status: GoalStatus }) {
  return <span className={`goal-status goal-status-${status.toLowerCase()}`}>{STATUS_LABEL[status]}</span>
}

function GoalLoadState({ loading, error }: { loading: boolean; error: string }) {
  if (loading) return <p className="goal-card-state" role="status">正在读取目标…</p>
  if (error) return <p className="goal-card-error" role="alert">{error}</p>
  return null
}

function GoalExecutionControls({ goal, disabled, onChange }: { goal: Goal; disabled: boolean; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const execution = goal.execution
  const open = execution ? isExecutionOpen(execution.status) : false
  const act = async () => {
    if (busy || disabled || open) return
    setBusy(true); setError('')
    try { await api.runGoalNextStep(goal.id, goal.version); onChange() }
    catch (reason) { setError(errorText(reason)) } finally { setBusy(false) }
  }
  const openChat = async () => {
    if (!execution) return
    useUiStore.getState().setAgentHomeBotId(null)
    await useChatsStore.getState().loadChats()
    await useChatsStore.getState().selectChat(execution.chatId)
  }
  return <div className="goal-execution">
    <div className="goal-card-actions">
      {!open && <button type="button" disabled={busy || disabled || !goal.ownerAgentId || goal.status !== 'ACTIVE'} onClick={() => void act()}>
        {busy ? '正在处理…' : execution?.status === 'error' || execution?.status === 'stopped' ? '重新执行下一步' : '执行下一步'}
      </button>}
      {execution && <ExecutionActions run={execution} disabled={disabled || busy} reload={onChange} />}
      {execution && <button type="button" onClick={() => void openChat().catch((reason) => setError(errorText(reason)))}>查看执行会话</button>}
    </div>
    {!goal.ownerAgentId && <p className="goal-muted">先在目标详情选择负责 Bot，即可执行下一步。</p>}
    {execution && <p className="goal-muted" role="status">{EXECUTION_LABELS[execution.status]}{execution.reason ? `：${execution.reason}` : ''}</p>}
    {error && <p className="goal-card-error" role="alert">{error}</p>}
  </div>
}

export function GoalCreateCardView({
  title = '',
  category,
  source = 'user_goal',
  subGoals = [],
  disabled = false,
  onCreated,
}: {
  title?: string
  category?: GoalCategory
  source?: GoalSource
  subGoals?: { title: string; emoji?: string }[]
  disabled?: boolean
  onCreated?: (goal: Goal) => void
}) {
  const [draftTitle, setDraftTitle] = useState(title)
  const [draftCategory, setDraftCategory] = useState<GoalCategory | ''>(category ?? '')
  const [draftSource, setDraftSource] = useState<GoalSource>(source)
  const [children, setChildren] = useState(subGoals)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState<Goal | null>(null)
  const bots = useBotsStore((state) => state.bots)
  const [ownerAgentId, setOwnerAgentId] = useState('')

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (disabled || saving) return
    const normalizedTitle = draftTitle.trim()
    if (!normalizedTitle) {
      setError('请填写目标标题')
      return
    }
    setSaving(true)
    setError('')
    try {
      const goal = await api.createGoal({
        title: normalizedTitle,
        ...(draftCategory ? { category: draftCategory } : {}),
        source: draftSource,
        ownerAgentId: ownerAgentId || null,
        subGoals: children.map((child) => ({ ...child, title: child.title.trim() })).filter((child) => child.title),
      })
      setCreated(goal)
      onCreated?.(goal)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setSaving(false)
    }
  }

  if (created) return <GoalDetailCardView goalId={created.id} disabled={disabled} />
  return <form className="goal-card goal-create-card" onSubmit={submit} aria-label="创建目标">
    <div className="goal-card-heading"><strong>新建目标</strong><span>确认后保存到本机</span></div>
    <label>目标标题<input disabled={disabled || saving} value={draftTitle} maxLength={120} onChange={(event) => setDraftTitle(event.target.value)} placeholder="例如：每周跑步 3 次" /></label>
    <label>负责 Bot<select aria-label="负责 Bot" disabled={disabled || saving} value={ownerAgentId} onChange={(event) => setOwnerAgentId(event.target.value)}><option value="">稍后指派</option>{bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
    <label>分类<select disabled={disabled || saving} value={draftCategory} onChange={(event) => setDraftCategory(event.target.value as GoalCategory | '')}>
      <option value="">未分类</option>{CATEGORIES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
    </select></label>
    <label>来源<select disabled={disabled || saving} value={draftSource} onChange={(event) => setDraftSource(event.target.value as GoalSource)}>
      <option value="user_goal">我的目标</option><option value="assistant_tracking">助手跟踪</option>
    </select></label>
    <div className="goal-subgoal-drafts"><span>子目标（可选）</span>{children.map((child, index) => <div key={index} className="goal-subgoal-draft"><input disabled={disabled || saving} value={child.title} maxLength={120} placeholder="下一步" onChange={(event) => setChildren((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, title: event.target.value } : item))} /><button type="button" disabled={disabled || saving} onClick={() => setChildren((current) => current.filter((_item, itemIndex) => itemIndex !== index))}>移除</button></div>)}
      {children.length < 3 && <button type="button" className="goal-text-button" disabled={disabled || saving} onClick={() => setChildren((current) => [...current, { title: '' }])}>添加子目标</button>}
    </div>
    {error && <p className="goal-card-error" role="alert">{error}</p>}
    <div className="goal-card-actions"><button type="submit" disabled={disabled || saving}>{saving ? '正在创建…' : '确认创建'}</button></div>
  </form>
}

export function GoalConfirmDeleteCardView({
  goalId,
  disabled = false,
  expectedVersion,
  onDeleted,
}: {
  goalId: string
  disabled?: boolean
  expectedVersion?: number
  onDeleted?: () => void
}) {
  const [goal, setGoal] = useState<Goal | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [removing, setRemoving] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const reload = useCallback(async () => {
    setLoading(true); setError('')
    try { setGoal(await api.getGoal(goalId)) } catch (reason) { setError(errorText(reason)) } finally { setLoading(false) }
  }, [goalId])
  useEffect(() => { void reload() }, [reload])
  const remove = async () => {
    if (!goal || disabled || removing) return
    setRemoving(true); setError('')
    try { await api.deleteGoal(goal.id, expectedVersion ?? goal.version); onDeleted?.(); setGoal(null) } catch (reason) { setError(errorText(reason)) } finally { setRemoving(false) }
  }
  if (cancelled) return <p className="goal-card-state">已取消删除。</p>
  if (!goal && !loading && !error) return <p className="goal-card-state">目标已删除。</p>
  return <section className="goal-card goal-delete-card" aria-label="确认删除目标">
    <div className="goal-card-heading"><strong>删除目标？</strong><span>此操作无法撤销</span></div>
    <GoalLoadState loading={loading} error={error} />
    {goal && <><p>将删除「{goal.title}」及 {goal.subGoals?.length ?? 0} 条子目标。</p><p className="goal-muted">已关联的定时任务、文档和聊天记录会保留；仍在运行的提醒不会自动停止。</p><div className="goal-card-actions"><button type="button" className="goal-danger-button" disabled={disabled || removing} onClick={() => void remove()}>{removing ? '正在删除…' : '确认删除'}</button><button type="button" disabled={disabled || removing} onClick={() => setCancelled(true)}>取消</button></div></>}
  </section>
}

export function GoalDetailCardView({ goalId, disabled = false }: { goalId: string; disabled?: boolean }) {
  const bots = useBotsStore((state) => state.bots)
  const [goal, setGoal] = useState<Goal | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [updateText, setUpdateText] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const reload = useCallback(async () => {
    setLoading(true); setError('')
    try { const next = await api.getGoal(goalId); setGoal(next); setDraftTitle(next.title) } catch (reason) { setError(errorText(reason)) } finally { setLoading(false) }
  }, [goalId])
  useEffect(() => {
    void reload()
    return api.onEvent((event) => {
      if (event.type === 'goal-deleted' && event.goalId === goalId) {
        setGoal(null)
        setError('')
        setLoading(false)
        return
      }
      if (event.type === 'goal-updated' && event.goalId === goalId) void reload()
    })
  }, [goalId, reload])
  const mutate = async (patch: Parameters<typeof api.updateGoal>[1]) => {
    if (!goal || disabled || busy) return
    setBusy(true); setError('')
    try { const next = await api.updateGoal(goal.id, patch, goal.version); setGoal(next); setDraftTitle(next.title); setEditing(false) } catch (reason) { setError(errorText(reason)) } finally { setBusy(false) }
  }
  const appendUpdate = async () => {
    if (!goal || disabled || busy || !updateText.trim()) return
    setBusy(true); setError('')
    try { await api.addGoalUpdate(goal.id, updateText.trim(), goal.version); setUpdateText(''); await reload() } catch (reason) { setError(errorText(reason)) } finally { setBusy(false) }
  }
  if (!goal && !loading && !error) return <p className="goal-card-state">目标已删除或不可用。</p>
  return <section className="goal-card goal-detail-card" aria-label="目标详情">
    <GoalLoadState loading={loading} error={error} />
    {goal && <>
      <div className="goal-detail-title"><span className="goal-emoji">{goal.emoji || '◎'}</span>{editing ? <input aria-label="目标标题" disabled={disabled || busy} value={draftTitle} maxLength={120} onChange={(event) => setDraftTitle(event.target.value)} /> : <strong>{goal.title}</strong>}<GoalStatusTag status={goal.status} /></div>
      <div className="goal-meta">{goal.category && CATEGORIES.find((item) => item.value === goal.category)?.label}{goal.ownerAgentId ? ' · 已指派 Bot' : ' · 待指派'}{goal.momentum === undefined ? ' · 动量未设置' : ` · 动量 ${Math.round(goal.momentum * 100)}%`}</div>
      <label>负责 Bot<select aria-label="负责 Bot" disabled={disabled || busy || !!goal.execution && isExecutionOpen(goal.execution.status)} value={goal.ownerAgentId ?? ''} onChange={(event) => void mutate({ ownerAgentId: event.target.value || null })}><option value="">未指派</option>{bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
      <fieldset className="goal-collaborators" disabled={disabled || busy || !!goal.execution && isExecutionOpen(goal.execution.status)}>
        <legend>协作 Bot（可由主责咨询）</legend>
        {bots.filter((bot) => bot.id !== goal.ownerAgentId).map((bot) => <label key={bot.id}>
          <input type="checkbox" checked={goal.collaboratorAgentIds.includes(bot.id)} onChange={(event) => void mutate({ collaboratorAgentIds: event.target.checked ? [...goal.collaboratorAgentIds, bot.id] : goal.collaboratorAgentIds.filter((id) => id !== bot.id) })} />{bot.name}
        </label>)}
      </fieldset>
      <GoalExecutionControls goal={goal} disabled={disabled || busy} onChange={() => void reload()} />
      {goal.summary && <p>{goal.summary}</p>}
      {goal.description && <p>{goal.description}</p>}
      <div className="goal-card-actions">
        {editing ? <><button type="button" disabled={disabled || busy || !draftTitle.trim()} onClick={() => void mutate({ title: draftTitle.trim() })}>保存名称</button><button type="button" disabled={disabled || busy} onClick={() => { setEditing(false); setDraftTitle(goal.title) }}>取消</button></> : <button type="button" disabled={disabled || busy} onClick={() => setEditing(true)}>改名</button>}
        {goal.status !== 'COMPLETED' && <button type="button" disabled={disabled || busy} onClick={() => void mutate({ status: 'COMPLETED' })}>标记完成</button>}
        {goal.status === 'ACTIVE' && <button type="button" disabled={disabled || busy} onClick={() => void mutate({ status: 'PAUSED' })}>暂停</button>}
        {(goal.status === 'PAUSED' || goal.status === 'COMPLETED' || goal.status === 'RETIRED') && <button type="button" disabled={disabled || busy} onClick={() => void mutate({ status: 'ACTIVE' })}>恢复进行中</button>}
        {!confirmDelete && <button type="button" className="goal-danger-link" disabled={disabled || busy} onClick={() => setConfirmDelete(true)}>删除</button>}
      </div>
      {confirmDelete && <GoalConfirmDeleteCardView goalId={goal.id} expectedVersion={goal.version} disabled={disabled || busy} onDeleted={() => setGoal(null)} />}
      <section className="goal-detail-section"><h4>关联内容</h4>{goal.artifacts?.length ? <ul>{goal.artifacts.map((artifact) => <li key={`${artifact.type}:${artifact.id}`}>{artifact.title}<span>{artifact.type === 'cron' ? ` · ${artifact.status}` : ''}</span></li>)}</ul> : <p className="goal-muted">尚未关联定时任务或文档。</p>}</section>
      <section className="goal-detail-section"><h4>子目标</h4>{goal.subGoals?.length ? <ul>{goal.subGoals.map((child) => <li key={child.id}><span>{child.emoji || '○'}</span> {child.title}<GoalStatusTag status={child.status} />{child.status !== 'COMPLETED' && <button type="button" disabled={disabled || busy} onClick={() => void api.updateGoal(child.id, { status: 'COMPLETED' }, child.version).then(() => reload()).catch((reason) => setError(errorText(reason)))}>完成</button>}</li>)}</ul> : <p className="goal-muted">还没有子目标。</p>}</section>
      <section className="goal-detail-section"><h4>活动</h4><div className="goal-update-form"><input disabled={disabled || busy} value={updateText} maxLength={2000} placeholder="记录一条真实进展" onChange={(event) => setUpdateText(event.target.value)} /><button type="button" disabled={disabled || busy || !updateText.trim()} onClick={() => void appendUpdate()}>追加进展</button></div>{goal.updates?.length ? <ol className="goal-updates">{goal.updates.map((item) => <li key={item.id}><p>{item.text}</p><span>{item.authorName || (item.actorKind === 'user' ? '你' : '系统')} · {new Date(item.createdAt).toLocaleString()}</span></li>)}</ol> : <p className="goal-muted">还没有活动记录。</p>}</section>
    </>}
  </section>
}

export function GoalsBoardView({ source, status, disabled = false }: { source?: GoalSource; status?: GoalStatus[]; disabled?: boolean }) {
  const [goals, setGoals] = useState<Goal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const reload = useCallback(async () => {
    setLoading(true); setError('')
    try { setGoals((await api.listGoals({ source, status })).goals) } catch (reason) { setError(errorText(reason)) } finally { setLoading(false) }
  }, [source, status?.join('|')])
  useEffect(() => {
    void reload()
    return api.onEvent((event) => {
      if (event.type === 'goal-updated' || event.type === 'goal-deleted' || event.type === 'goals-reordered') void reload()
    })
  }, [reload])
  const allGroups: { source: GoalSource; title: string; items: Goal[] }[] = [
    { source: 'user_goal', title: '我的目标', items: goals.filter((goal) => goal.source === 'user_goal') },
    { source: 'assistant_tracking', title: '助手跟踪', items: goals.filter((goal) => goal.source === 'assistant_tracking') },
  ]
  const groups = allGroups.filter((group) => !source || group.source === source)
  return <section className="goal-card goals-board" aria-label="目标看板">
    <div className="goal-card-heading"><strong>目标</strong><button type="button" disabled={disabled} onClick={() => setCreating(true)}>新建目标</button></div>
    <GoalLoadState loading={loading} error={error} />
    {groups.map((group) => <section className="goal-board-section" key={group.source}><h4>{group.title}</h4>{group.items.length ? <ul>{group.items.map((goal) => <li key={goal.id}><button type="button" className="goal-board-row" onClick={() => setSelected(goal.id)}><span className="goal-emoji">{goal.emoji || '◎'}</span><span>{goal.title}</span><GoalStatusTag status={goal.status} />{goal.momentum !== undefined && <small>{Math.round(goal.momentum * 100)}%</small>}</button><div className="goal-row-actions">{goal.status !== 'COMPLETED' && <button type="button" disabled={disabled} onClick={() => void api.updateGoal(goal.id, { status: 'COMPLETED' }, goal.version).then(() => reload()).catch((reason) => setError(errorText(reason)))}>完成</button>}{goal.status === 'ACTIVE' && <button type="button" disabled={disabled} onClick={() => void api.updateGoal(goal.id, { status: 'PAUSED' }, goal.version).then(() => reload()).catch((reason) => setError(errorText(reason)))}>暂停</button>}</div><GoalExecutionControls goal={goal} disabled={disabled} onChange={() => void reload()} /></li>)}</ul> : <p className="goal-muted">当前筛选下没有目标。</p>}</section>)}
    {creating && <GoalCreateCardView disabled={disabled} onCreated={(goal) => { setCreating(false); setSelected(goal.id); void reload() }} />}
    {selected && <GoalDetailCardView key={selected} goalId={selected} disabled={disabled} />}
  </section>
}
