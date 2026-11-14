// AgentHomeView.tsx — a Bot's generated, persisted OpenUI personal page.
import { ArrowLeft, RefreshCw, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { AgentHome } from '@shared/types'
import { api } from '../lib/api'
import { useBotsStore } from '../stores/botsStore'
import { useUiStore } from '../stores/uiStore'
import { Avatar } from './Avatar'
import { GenerativeMessage } from './GenerativeMessage'

export function AgentHomeView({ botId }: { botId: string }) {
  const bot = useBotsStore((state) => state.bots.find((item) => item.id === botId))
  const close = useUiStore((state) => state.setAgentHomeBotId)
  const [home, setHome] = useState<AgentHome | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      setHome(await api.regenerateAgentHome(botId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '主页生成失败，请稍后重试')
    } finally {
      setBusy(false)
    }
  }, [botId])

  useEffect(() => {
    let active = true
    setHome(null)
    setError('')
    void api.getAgentHome(botId).then((next) => {
      if (!active) return
      setHome(next)
      // First opening is the explicit user action that asks this Bot to make
      // its own page. The local starter page remains usable if generation fails.
      if (next.isFallback) void refresh()
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : '主页无法读取')
    })
    return () => { active = false }
  }, [botId, refresh])

  useEffect(() => api.onEvent((event) => {
    if (event.type !== 'agent-home-updated' || event.botId !== botId) return
    void api.getAgentHome(botId).then(setHome).catch(() => undefined)
  }), [botId])

  if (!bot) {
    return (
      <main className="agent-home-view" aria-label="Agent 主页">
        <p className="agent-home-empty">这个 Agent 已不存在。</p>
      </main>
    )
  }

  return (
    <main className="agent-home-view" aria-label={`${bot.name} 的主页`}>
      <header className="agent-home-header">
        <button
          type="button"
          className="agent-home-back"
          onClick={() => close(null)}
          aria-label="返回聊天"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          返回聊天
        </button>
        <div className="agent-home-identity">
          <Avatar name={bot.name} avatar={bot.avatar} size={38} />
          <div>
            <p>Agent 主页</p>
            <strong>{bot.name}</strong>
          </div>
        </div>
        <button
          type="button"
          className="agent-home-refresh"
          onClick={() => void refresh()}
          disabled={busy}
        >
          {busy ? <RefreshCw size={15} className="animate-spin" aria-hidden="true" /> : <Sparkles size={15} aria-hidden="true" />}
          {busy ? '正在生成' : '刷新主页'}
        </button>
      </header>

      <div className="agent-home-scroll scroll-thin">
        <div className="agent-home-content">
          {error && <p className="agent-home-error" role="alert">{error}</p>}
          {!home && !error && <p className="agent-home-loading" role="status">正在读取主页…</p>}
          {home && <GenerativeMessage content={home.content} streaming={busy} interactive={!busy} />}
          {home?.isFallback && !busy && (
            <p className="agent-home-hint" role="status">这是临时主页；点击“刷新主页”让 {bot.name} 按自己的角色生成内容。</p>
          )}
        </div>
      </div>
    </main>
  )
}
