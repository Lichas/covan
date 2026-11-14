import type { GoalExecutionStatus } from './types'

export const EXECUTION_LABELS: Record<GoalExecutionStatus, string> = {
  queued: '排队中', running: '执行中', waiting_experts: '等待专家', waiting_input: '等待补充',
  paused: '已暂停', blocked: '需要处理阻塞', review: '待验收', done: '本轮已验收', error: '执行失败', stopped: '已停止',
}
export const OPEN_EXECUTION_STATUSES: GoalExecutionStatus[] = [
  'queued', 'running', 'waiting_experts', 'waiting_input', 'paused', 'blocked', 'review',
]
export function isExecutionOpen(status: GoalExecutionStatus): boolean {
  return OPEN_EXECUTION_STATUSES.includes(status)
}
export const EXECUTION_TRANSITIONS: Record<GoalExecutionStatus, readonly GoalExecutionStatus[]> = {
  queued: ['running', 'paused', 'stopped', 'blocked', 'error'],
  running: ['queued', 'waiting_experts', 'waiting_input', 'paused', 'blocked', 'review', 'done', 'error', 'stopped'],
  waiting_experts: ['queued', 'paused', 'blocked', 'stopped'],
  waiting_input: ['queued', 'paused', 'blocked', 'stopped'],
  paused: ['queued', 'waiting_input', 'waiting_experts', 'blocked', 'review', 'stopped'],
  blocked: ['queued', 'paused', 'stopped'],
  review: ['queued', 'done', 'stopped'],
  error: ['queued', 'stopped'],
  done: [], stopped: [],
}
