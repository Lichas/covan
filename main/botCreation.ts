import type { Bot, BotCreateInput } from '../shared/types'
import { personaTemplateById } from '../shared/personaTemplates'
import { createBot, getDb } from './db'
import { listSkills, setBotExtensions } from './extensions/store'

/** 默认装配是角色模板的创建行为，不随标签更新或应用重启重放。 */
export function createBotFromTemplate(input: BotCreateInput): Bot {
  const template = input.persona_template_id === undefined
    ? undefined
    : typeof input.persona_template_id === 'string'
      ? personaTemplateById(input.persona_template_id)
      : undefined
  if (input.persona_template_id !== undefined && !template)
    throw new Error('人设模板不存在，请重新选择')
  const skillIds = (template?.defaultSkillNames ?? []).map((name) => {
    const skill = listSkills().find((item) => item.name === name)
    if (!skill) throw new Error(`模板所需 Skill「${name}」未安装，请在设置 → Skills 中安装后重试`)
    return skill.id
  })
  return getDb().transaction(() => {
    const bot = createBot(input)
    if (skillIds.length) setBotExtensions(bot.id, { mcpServerIds: [], skillIds })
    return bot
  })()
}
