import type { Message as PiMessage, ToolResultMessage } from '@earendil-works/pi-ai'

/** Preserve successful results; close interrupted protocol pairs without replaying tools. */
export function repairGoalHistory(messages: PiMessage[]): PiMessage[] {
  const history: PiMessage[] = []
  let pending: Extract<PiMessage, { role: 'assistant' }> | undefined
  let results: ToolResultMessage[] = []
  const flush = () => {
    if (!pending) return
    history.push(pending)
    for (const part of pending.content) {
      if (part.type !== 'toolCall') continue
      history.push(results.find((result) => result.toolCallId === part.id) ?? {
        role: 'toolResult', toolCallId: part.id, toolName: part.name,
        content: [{ type: 'text', text: '上次调用中断，结果未知。先核对目录、已有成果和外部状态，不得盲目重放。' }],
        isError: true, timestamp: Date.now(),
      })
    }
    pending = undefined; results = []
  }
  for (const message of messages) {
    if (message.role === 'toolResult') { if (pending) results.push(message); continue }
    flush()
    if (message.role === 'assistant') {
      if (message.content.some((part) => part.type === 'toolCall')) {
        pending = ['aborted', 'error'].includes(message.stopReason) ? { ...message, stopReason: 'toolUse', errorMessage: undefined } : message
      } else if (!['aborted', 'error'].includes(message.stopReason)) history.push(message)
    } else history.push(message)
  }
  flush()
  return history
}
