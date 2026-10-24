// main/fitness.ts — 健身教练的本地结构化工具（SPEC §14）
import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { FitnessLogInput, FitnessProfileInput } from '../shared/types'
import * as db from './db'

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  details: {},
})

function today(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`
}

const optionalNumber = (description: string, minimum: number, maximum: number) =>
  Type.Optional(Type.Number({ description, minimum, maximum }))

export function createFitnessTools(botId: string): AgentTool[] {
  const profileTool: AgentTool = {
    name: 'fitness_profile',
    label: '身体档案',
    description:
      '读取或更新当前 Bot 的健身档案：年龄、性别、身高、体重、体脂、腰围、目标、目标日期、训练经验、伤病限制、器械、计划与备注。省略参数表示读取；只传需要修改的字段。身体数字必须落库，不要只写在回复里。',
    parameters: Type.Object({
      age: optionalNumber('年龄', 1, 120),
      sex: Type.Optional(
        Type.Union([Type.Literal('female'), Type.Literal('male'), Type.Literal('other')]),
      ),
      height_cm: optionalNumber('身高 cm', 50, 260),
      weight_kg: optionalNumber('体重 kg', 20, 400),
      body_fat_pct: optionalNumber('体脂率 %', 1, 75),
      waist_cm: optionalNumber('腰围 cm', 30, 250),
      goal: Type.Optional(Type.String({ maxLength: 500 })),
      target_weight_kg: optionalNumber('目标体重 kg', 20, 400),
      target_date: Type.Optional(
        Type.String({ description: '目标日期 YYYY-MM-DD；空字符串清除' }),
      ),
      experience: Type.Optional(Type.String({ maxLength: 1000 })),
      injuries: Type.Optional(Type.String({ maxLength: 2000 })),
      equipment: Type.Optional(Type.String({ maxLength: 1000 })),
      plan: Type.Optional(Type.String({ maxLength: 12000 })),
      notes: Type.Optional(Type.String({ maxLength: 4000 })),
    }),
    execute: async (_id, params) => {
      const patch = params as Omit<FitnessProfileInput, 'bot_id'>
      const hasField = Object.values(patch).some((value) => value !== undefined)
      if (!hasField) return result(db.getFitnessProfile(botId))
      return result(db.saveFitnessProfile({ ...patch, bot_id: botId }))
    },
  }

  const logTool: AgentTool = {
    name: 'fitness_log',
    label: '记录身体数据',
    description:
      '记录或更新某一天的身体数据：体重、腰围、体脂、睡眠、步数、训练、蛋白质、热量与备注。同一天重复调用会更新当天记录；日期省略表示今天。记录后返回最近 14 天摘要。',
    parameters: Type.Object({
      date: Type.Optional(
        Type.String({ description: 'YYYY-MM-DD，省略表示今天' }),
      ),
      weight_kg: optionalNumber('体重 kg', 20, 400),
      waist_cm: optionalNumber('腰围 cm', 30, 250),
      body_fat_pct: optionalNumber('体脂率 %', 1, 75),
      sleep_hours: optionalNumber('睡眠小时', 0, 24),
      steps: optionalNumber('步数', 0, 200000),
      workout: Type.Optional(Type.String({ maxLength: 1000 })),
      protein_g: optionalNumber('蛋白质克数', 0, 500),
      calories: optionalNumber('热量 kcal', 0, 15000),
      note: Type.Optional(Type.String({ maxLength: 2000 })),
    }),
    execute: async (_id, params) => {
      const input = params as Omit<FitnessLogInput, 'bot_id' | 'date'> & {
        date?: string
      }
      const saved = db.saveFitnessLog({
        ...input,
        bot_id: botId,
        date: input.date ?? today(),
      })
      return result({
        log: saved,
        summary: db.getFitnessSummary(botId, 14),
      })
    },
  }

  const summaryTool: AgentTool = {
    name: 'fitness_summary',
    label: '健康趋势摘要',
    description:
      '读取身体档案与最近 N 天的记录、7 天均值、区间变化和体重/腰围序列。绘制图表、制定或调整计划前先调用它，不要把原始多行记录直接塞进上下文。',
    parameters: Type.Object({
      days: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 365, description: '统计天数，默认 30' }),
      ),
    }),
    execute: async (_id, params) => {
      const days = (params as { days?: number }).days ?? 30
      const summary = db.getFitnessSummary(botId, days)
      // Keep the tool payload compact; the health tab can still read the full window.
      return result({ ...summary, logs: summary.logs.slice(-60) })
    },
    executionMode: 'sequential',
  }

  return [profileTool, logTool, summaryTool]
}
