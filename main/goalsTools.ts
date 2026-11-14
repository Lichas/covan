// main/goalsTools.ts — pi-agent-core adapter for the shared Goals service.
import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { GoalCategory, GoalSource, GoalStatus } from '../shared/types'
import * as goals from './goals'

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  details: {},
})

const statusSchema = () => Type.Union([
  Type.Literal('ACTIVE'), Type.Literal('PAUSED'), Type.Literal('RETIRED'), Type.Literal('COMPLETED'),
])
const sourceSchema = () => Type.Union([Type.Literal('user_goal'), Type.Literal('assistant_tracking')])
const categorySchema = () => Type.Union([
  Type.Literal('HEALTH'), Type.Literal('RELATIONSHIPS'), Type.Literal('MONEY'),
  Type.Literal('CAREER'), Type.Literal('INTERESTS'), Type.Literal('PRODUCTIVITY'),
  Type.Literal('SOMETHING_ELSE'),
])

/**
 * API-backed Bots can persist their own goals and progress. User-confirmed
 * destructive/assignment/sort actions stay behind the renderer IPC boundary.
 */
export function createGoalsTools(botId: string, chatId: string): AgentTool[] {
  const actor = { kind: 'agent' as const, botId, chatId }
  return [
    {
      name: 'list_goals',
      label: '查看目标',
      description:
        '读取用户的共享目标。结果来自本机 GoalsStore，不能编造目标、ID、状态或进度。省略 status 默认返回进行中和已暂停的顶层目标。',
      parameters: Type.Object({
        source: Type.Optional(sourceSchema()),
        status: Type.Optional(Type.Array(statusSchema(), { minItems: 1, maxItems: 4 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        cursor: Type.Optional(Type.String({ maxLength: 2000 })),
      }),
      execute: async (_id, params) => result(goals.listGoals(params as {
        source?: GoalSource; status?: GoalStatus[]; limit?: number; cursor?: string
      })),
    },
    {
      name: 'get_goal',
      label: '查看目标详情',
      description:
        '读取一个真实目标的详情、子目标、关联内容和活动。先从 list_goals 或工具结果获取准确 ID。',
      parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }) }),
      execute: async (_id, params) => result(goals.getGoal((params as { id: string }).id)),
    },
    {
      name: 'create_goal',
      label: '创建目标',
      description:
        '用户明确要求创建目标时调用。只在工具返回成功后才能说已创建；返回真实 Goal 和 ID。创建后由当前 Bot 负责，初始子目标最多三条。',
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 120 }),
        summary: Type.Optional(Type.String({ maxLength: 500 })),
        description: Type.Optional(Type.String({ maxLength: 10000 })),
        emoji: Type.Optional(Type.String({ maxLength: 16 })),
        category: Type.Optional(categorySchema()),
        source: Type.Optional(sourceSchema()),
        parentGoalId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        subGoals: Type.Optional(Type.Array(Type.Object({
          title: Type.String({ minLength: 1, maxLength: 120 }),
          emoji: Type.Optional(Type.String({ maxLength: 16 })),
        }), { maxItems: 3 })),
      }),
      execute: async (_id, params) => {
        const input = params as {
          title: string; summary?: string; description?: string; emoji?: string
          category?: GoalCategory; source?: GoalSource; parentGoalId?: string
          subGoals?: { title: string; emoji?: string }[]
        }
        return result(goals.createGoal({ ...input, ownerAgentId: botId, sessionId: chatId }, actor))
      },
    },
    {
      name: 'update_goal',
      label: '更新目标进度',
      description:
        '主责或协作者可以更新自己的目标状态、摘要、说明或动量。改名、改派、修改协作者、排序与删除需要用户使用目标卡片确认。写入后返回当前真实 Goal。',
      parameters: Type.Object({
        id: Type.String({ minLength: 1, maxLength: 128 }),
        status: Type.Optional(statusSchema()),
        summary: Type.Optional(Type.String({ maxLength: 500 })),
        description: Type.Optional(Type.String({ maxLength: 10000 })),
        emoji: Type.Optional(Type.String({ maxLength: 16 })),
        momentum: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
        expectedVersion: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      execute: async (_id, params) => {
        const value = params as {
          id: string; expectedVersion?: number; status?: GoalStatus; summary?: string
          description?: string; emoji?: string; momentum?: number
        }
        const { id, expectedVersion, ...patch } = value
        return result(goals.updateGoal(id, patch, actor, expectedVersion))
      },
    },
    {
      name: 'delete_goal',
      label: '删除目标（需要确认）',
      description:
        '删除目标是危险操作。不要声称已经删除，也不要自行删除；引导用户在目标详情的删除确认卡完成操作。',
      parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }) }),
      execute: async (_id, params) => result({
        id: (params as { id: string }).id,
        requiresUserConfirmation: true,
        message: '请让用户在目标详情的删除确认卡中确认删除。',
      }),
    },
    {
      name: 'add_goal_update',
      label: '记录目标进展',
      description:
        '为当前 Bot 负责或协作的真实目标追加一条进展。进展内容必须是本轮完成的实际工作，不要把计划写成已完成。',
      parameters: Type.Object({
        goalId: Type.String({ minLength: 1, maxLength: 128 }),
        text: Type.String({ minLength: 1, maxLength: 2000 }),
        expectedVersion: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      execute: async (_id, params) => {
        const value = params as { goalId: string; text: string; expectedVersion?: number }
        return result(goals.addGoalUpdate(value.goalId, value.text, actor, value.expectedVersion))
      },
    },
    {
      name: 'attach_artifact',
      label: '关联目标内容',
      description:
        '将一个已有的本地定时任务或工作区文档关联到当前 Bot 负责/协作的目标。不会创建任务、复制文件或扩大文件权限。空间关联尚未实现。',
      parameters: Type.Object({
        goalId: Type.String({ minLength: 1, maxLength: 128 }),
        artifact: Type.Union([
          Type.Object({ type: Type.Literal('cron'), id: Type.String({ minLength: 1, maxLength: 128 }) }),
          Type.Object({
            type: Type.Literal('document'),
            botId: Type.String({ minLength: 1, maxLength: 128 }),
            path: Type.String({ minLength: 1, maxLength: 2000 }),
          }),
        ]),
        expectedVersion: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      execute: async (_id, params) => {
        const value = params as {
          goalId: string
          artifact: { type: 'cron'; id: string } | { type: 'document'; botId: string; path: string }
          expectedVersion?: number
        }
        return result(goals.attachGoalArtifact(value.goalId, value.artifact, actor, value.expectedVersion))
      },
    },
    {
      name: 'reorder_goals',
      label: '排序目标（需要确认）',
      description:
        '目标排序必须由用户在看板中确认。不要自行排序；此工具只返回需要用户确认的说明。',
      parameters: Type.Object({
        orderedIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 100 }),
      }),
      execute: async (_id, params) => result({
        orderedIds: (params as { orderedIds: string[] }).orderedIds,
        requiresUserConfirmation: true,
        message: '请让用户在目标看板中确认新的排序。',
      }),
    },
  ]
}
