import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Attachment, ChatDocumentPreview } from '@shared/types'
import { api } from '../lib/api'
import { Dialog } from './Dialog'
import { ChatImage, attachmentUrl } from './ChatImage'

export const isDocumentAttachment = (attachment: Attachment) => attachment.path.startsWith('chat-documents/')

export function ChatAttachment({ attachment }: { attachment: Attachment }) {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<ChatDocumentPreview | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open || !isDocumentAttachment(attachment)) return
    let active = true
    setError(''); setPreview(null)
    void api.readChatDocument(attachment.path).then((value) => { if (active) setPreview(value) })
      .catch(() => { if (active) setError('文档不可用，请重新上传。') })
    return () => { active = false }
  }, [open, attachment.path])
  if (!isDocumentAttachment(attachment)) return <ChatImage src={attachmentUrl(attachment.path)} alt={attachment.name} />
  return <>
    <button type="button" className="chat-document" aria-label={`预览附件：${attachment.name}`} onClick={() => setOpen(true)}>
      <span className="chat-document-type">{attachment.mime === 'application/pdf' ? 'PDF' : '文档'}</span>
      <span className="chat-document-info"><strong>{attachment.name}</strong><small>
        {attachment.pages ? `${attachment.pages} 页 · ` : ''}{attachment.size === undefined ? '查看文字' : `${Math.ceil(attachment.size / 1024)} KB`}{attachment.truncated ? ' · 已截取' : ''}
      </small></span>
    </button>
    {open && createPortal(<Dialog open title={attachment.name} width="w-[900px]" onClose={() => setOpen(false)}>
      {error ? <p role="alert">{error}</p> : !preview ? <p role="status">正在读取文档…</p> : <>
        <p className="document-preview-hint">{attachment.mime === 'application/pdf' ? 'PDF 提取文字，按原文页码引用。' : '文本与代码，按行号引用。'}{preview.attachment.truncated ? ' 文件较长，仅提取前 60,000 字符；请拆分后分析其余内容。' : ''}</p>
        <pre className="document-preview selectable">{preview.text}</pre>
      </>}
    </Dialog>, document.body)}
  </>
}
