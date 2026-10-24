import { useEffect, useState } from 'react'
import type { WorkspaceHtmlPreview } from '@shared/types'
import { api } from '../lib/api'

export function HtmlArtifactPreview({ botId, relPath }: { botId: string; relPath: string }) {
  const [preview, setPreview] = useState<WorkspaceHtmlPreview | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    let current: WorkspaceHtmlPreview | undefined
    const release = (id: string) => { void api.releaseWorkspaceHtmlPreview(id).catch(() => {}) }
    void api.createWorkspaceHtmlPreview(botId, relPath).then((created) => {
      current = created
      if (alive) setPreview(created)
      else release(created.id)
    }).catch((error: unknown) => {
      if (alive) setError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      alive = false
      if (current) release(current.id)
    }
  }, [botId, relPath])

  if (error) return <div className="artifact-preview-state artifact-preview-error" role="alert">{error}</div>
  if (!preview) return <div className="artifact-preview-state">正在载入预览...</div>
  return <iframe
    className="artifact-preview-frame"
    title={relPath.split('/').pop() || 'HTML 预览'}
    sandbox="allow-scripts"
    referrerPolicy="no-referrer"
    src={preview.url}
    onError={() => setError('无法载入 HTML 预览，请重新加载')}
  />
}
