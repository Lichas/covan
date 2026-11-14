import { memo } from 'react'
import type { Bot, Message } from '@shared/types'
import { Avatar } from './Avatar'
import { QuoteIcon, RefreshIcon, WarnIcon, BugIcon } from './icons'
import { CopyButton } from './CopyButton'
import { MarkdownContent } from './MarkdownContent'
import { ChatAttachment } from './ChatAttachment'
import { BrowserTaskCard } from './BrowserPreview'
import { BrowserLoginCard } from './BrowserLoginCard'
import { formatFullTime, formatMessageTime } from '../lib/format'
import { ArtifactCard } from './ArtifactCard'
import { GenerativeMessage } from './GenerativeMessage'

interface Props {
  message: Message
  bot: Bot | null
  isGroup: boolean
  streaming?: boolean
  busy?: boolean
  onInspectBot?: (botId: string) => void
  onRetry?: (message: Message) => void
  onQuote?: (message: Message) => void
  onUiReply?: (message: Message, text: string) => void
  onRegenerateWelcome?: (message: Message) => void
}

export const MessageBubble = memo(function MessageBubble({
  message,
  bot,
  isGroup,
  streaming,
  busy,
  onInspectBot,
  onRetry,
  onQuote,
  onUiReply,
  onRegenerateWelcome,
}: Props) {
  if (message.sender_type === 'system') {
    if (!message.content) return null
    return (
      <div
        className={`system-message selectable ${message.system_kind === 'topic_boundary' ? 'topic-boundary' : ''}`}
        title={formatFullTime(message.created_at)}
        data-message-id={message.id}
        data-system-kind={message.system_kind || undefined}
      >
        <span>{message.content}</span>
      </div>
    )
  }
  const isUser = message.sender_type === 'user'
  const isError = message.status === 'error'
  const name = isUser ? '你' : (bot?.name ?? 'Bot')
  return (
    <article
      className={`message-row ${isUser ? 'message-user' : 'message-bot'}`}
      data-message-id={message.id}
      data-status={message.status}
      data-system-kind={message.system_kind || undefined}
      aria-label={`${name}的消息`}
    >
      {!isUser && isGroup && (
        <button
          className="message-avatar"
          onClick={() => bot && onInspectBot?.(bot.id)}
          title={`查看 ${name} 的设置`}
          disabled={!bot}
        >
          <Avatar name={name} avatar={bot?.avatar ?? ''} size={30} />
        </button>
      )}
      <div className="message-body">
        <div className="message-meta">
          {/* 单人聊天参考气泡式布局：头像并入名称胶囊，不再单独占一列。 */}
          {!isUser && !isGroup && (
            <button
              className="message-avatar-inline"
              onClick={() => bot && onInspectBot?.(bot.id)}
              title={`查看 ${name} 的设置`}
              disabled={!bot}
            >
              <Avatar name={name} avatar={bot?.avatar ?? ''} size={18} />
            </button>
          )}
          <span className="message-author">{name}</span>
          <time
            dateTime={new Date(message.created_at).toISOString()}
            title={formatFullTime(message.created_at)}
          >
            {formatMessageTime(message.created_at)}
          </time>
          {streaming && <span className="generation-label">{message.goal_execution_id ? '后台执行中' : '正在回复'}</span>}
          {message.goal_input_execution_id && <span className="generation-label">任务补充 · {message.goal_input_delivery === 'delivered' ? '已送达' : message.goal_input_delivery === 'pending' ? '待处理' : '关联已失效'}</span>}
          {message.system_kind === 'welcome' && (
            <span className="generation-label">开场</span>
          )}
        </div>
        <div className={`message-surface ${isError ? 'message-error' : ''}`}>
          {message.attachments.length > 0 && (
            <div className="message-images">
              {message.attachments.map((item, i) => (
                <ChatAttachment
                  key={`${item.path}-${i}`}
                  attachment={item}
                />
              ))}
            </div>
          )}
          {isUser ? (
            message.content.startsWith('> ') ? <MarkdownContent content={message.content} /> : <div className="selectable msg-content">{message.content}</div>
          ) : message.content ? (
            <GenerativeMessage content={message.content} streaming={!!streaming} interactive={message.status === 'done' && !streaming && !busy} onReply={onUiReply ? (text) => onUiReply(message, text) : undefined} />
          ) : streaming && !message.attachments.length ? (
            <div className="thinking-indicator" role="status">
              <span />
              <span />
              <span />
              <span className="sr-only">正在思考</span>
            </div>
          ) : isError ? (
            <span className="text-stone-500">未能完成这次回复</span>
          ) : null}
        </div>
        {!isUser && bot && <BrowserTaskCard botId={bot.id} messageId={message.id} />}
        {!isUser && bot && message.status === 'streaming' && <BrowserLoginCard botId={bot.id} messageId={message.id} />}
        {!isUser && bot && message.artifacts.length > 0 && (
          <ArtifactCard
            artifacts={message.artifacts}
            botId={bot.id}
            streaming={streaming}
          />
        )}
        {isError && (
          <div className="message-error-info" role="alert">
            <WarnIcon width={14} height={14} />
            <span>{message.error || '生成失败，请重试'}</span>
          </div>
        )}
        {message.status === 'stopped' && (
          <div className="message-stopped">已停止生成 · 已保留现有内容</div>
        )}
        {(!streaming || !isUser) && (
          <div className="message-actions">
            {!streaming && message.content && (
              <>
                <CopyButton text={message.content} compact />
                <button
                  className="message-action"
                  onClick={() => onQuote?.(message)}
                  title="引用回复"
                  aria-label="引用回复"
                >
                  <QuoteIcon width={14} height={14} />
                </button>
              </>
            )}
            {!isUser && <CopyButton compact label="复制诊断标识" text={`covan-debug:v1:${message.id}`} icon={<BugIcon size={14} />} />}
            {message.system_kind === 'welcome' && (
              <button
                className="message-action"
                disabled={busy}
                onClick={() => onRegenerateWelcome?.(message)}
                title="重新生成开场白"
              >
                <RefreshIcon width={14} height={14} />
                重新生成开场白
              </button>
            )}
            {isError && (
              <button
                className="message-action"
                disabled={busy}
                onClick={() => onRetry?.(message)}
              >
                <RefreshIcon width={14} height={14} />
                重试
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  )
})
