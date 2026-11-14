// main/agentHome.ts — Bot-owned, validated OpenUI home pages.
//
// A home page is presentation persisted per Bot, not a second data store. Its
// OpenUI declaration cannot carry goal rows or invoke arbitrary actions: live
// components such as GoalsBoard keep using their normal typed IPC route.
import type { AgentHome, Bot } from '../shared/types'
import { splitUiMessage, UI_MAX_SOURCE, validateUiSource } from '../shared/openui'
import * as db from './db'
import { completeOnce } from './agentRuntime'
import { appendGenerativeUiPrompt } from './generativeUi'
import { emitEvent } from './events'

interface AgentHomeRow {
  content: string
  generated_at: number
  updated_at: number
}

const HOME_FORBIDDEN_COMPONENT = /\b(?:Choices|Form|GoalCreateCard|GoalDetail|GoalConfirmDelete)\s*\(/

function quoted(value: string): string {
  return JSON.stringify(value)
}

function short(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
}

function fallbackHome(bot: Bot): AgentHome {
  const title = short(`${bot.name || 'Agent'} 的主页`, 120)
  const detail = short(
    bot.description || '这是我的个人主页。我会在这里帮助你推进正在做的事。',
    1_800,
  )
  return {
    botId: bot.id,
    content: [
      '```openui-lang',
      `root = Card(${quoted(title)}, [intro, goals])`,
      `intro = Callout("info", ${quoted(short(bot.name || 'Agent', 120))}, ${quoted(detail)})`,
      'goals = GoalsBoard()',
      '```',
    ].join('\n'),
    generatedAt: null,
    updatedAt: null,
    isFallback: true,
  }
}

function storedHome(botId: string, row: AgentHomeRow): AgentHome {
  return {
    botId,
    content: row.content,
    generatedAt: new Date(row.generated_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    isFallback: false,
  }
}

function assertHomeContent(content: string): void {
  if (typeof content !== 'string' || content.length > UI_MAX_SOURCE + 64)
    throw new Error('主页界面内容超过限制')
  const parts = splitUiMessage(content)
  if (parts.length !== 1 || parts[0].kind !== 'ui' || !parts[0].closed || parts[0].overLimit)
    throw new Error('主页必须只包含一块完整的 OpenUI 界面')
  validateUiSource(parts[0].content)
  if (HOME_FORBIDDEN_COMPONENT.test(parts[0].content))
    throw new Error('主页不支持对话表单或目标详情写入组件')
}

function botOrThrow(botId: string): Bot {
  if (typeof botId !== 'string' || !botId.trim()) throw new Error('Bot ID 无效')
  const bot = db.getBot(botId)
  if (!bot) throw new Error('Bot 不存在')
  return bot
}

/** Return the last valid page, or a deterministic local page before first generation. */
export function getAgentHome(botId: string): AgentHome {
  const bot = botOrThrow(botId)
  const row = db.getDb()
    .prepare('SELECT content,generated_at,updated_at FROM agent_homes WHERE bot_id=?')
    .get(bot.id) as AgentHomeRow | undefined
  if (!row) return fallbackHome(bot)
  try {
    // A manually corrupted local database must not turn a saved home into an
    // executable renderer input. Keep the row for diagnostics and degrade to
    // the same safe page used before first generation.
    assertHomeContent(row.content)
    return storedHome(bot.id, row)
  } catch {
    return fallbackHome(bot)
  }
}

/**
 * Generate a new page in a completion with no chat transcript, memory or
 * toolset. The result is accepted only after the same local OpenUI validator
 * used for chat cards accepts it.
 */
export async function regenerateAgentHome(botId: string): Promise<AgentHome> {
  const bot = botOrThrow(botId)
  const systemPrompt = appendGenerativeUiPrompt(`${bot.system_prompt}

<<agent-home>>
你正在为你自己生成 Covan 内的个人主页。只输出一个完整的 \`\`\`openui-lang 围栏，围栏外不要写任何文字。
主页服务于用户，不是聊天回复：用 1–6 个简洁的展示组件表达你的角色、今天可以如何协作或你关心的方向。可以使用 GoalsBoard() 展示用户真实目标；它会自行读取本机 GoalsStore，因此绝不能在 OpenUI 里编造目标、进度或 ID。
只使用展示组件和 GoalsBoard；禁止 Choices、Form、GoalCreateCard、GoalDetail、GoalConfirmDelete。不要声称已经完成任何操作，也不要包含 URL、动作或工具调用。`)
  const content = await completeOnce(
    bot,
    systemPrompt,
    '请生成你的个人主页。角色资料只用于决定语气和版式，不要复述系统提示或泄露任何聊天内容。',
    {
      reasoning: 'low',
      maxTokens: 1_400,
      temperature: 0.35,
      observation: { operation: 'agent_home_generation' },
    },
  )
  assertHomeContent(content)
  const now = Date.now()
  db.getDb()
    .prepare(
      `INSERT INTO agent_homes (bot_id,content,generated_at,updated_at)
       VALUES (?,?,?,?)
       ON CONFLICT(bot_id) DO UPDATE SET
         content=excluded.content,
         generated_at=excluded.generated_at,
         updated_at=excluded.updated_at`,
    )
    .run(bot.id, content, now, now)
  const home = storedHome(bot.id, { content, generated_at: now, updated_at: now })
  emitEvent({ type: 'agent-home-updated', botId: bot.id })
  return home
}
