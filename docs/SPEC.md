# SPEC — Covan（Grok Bot 风格多智能体聊天桌面应用）

> 单一事实来源。所有子代理必须严格按本规范实现接口与模块边界。

## 0. 产品概述

Covan 是一个 macOS 风格三栏布局的桌面应用（Electron + React），核心概念是 **Bot**（有独立人设、记忆、模型配置、工作区的智能体）与 **Chat**（单聊或群聊）。用户可以：
- 创建多个 Bot（工作伙伴或虚拟伴侣）
- 与单个 Bot 私聊，或把多个 Bot 拉入群聊讨论
- 群聊可选「主动回复」或「顺序回复」，由每位成员结合上下文自主判断是否发言
- 每个 Bot 有持久记忆（自动提取 + 手动管理）、独立文件工作区
- 每个 Bot 可拥有持久化定时 Agent 任务；可在 Bot 侧或设置全局管理，运行结果投递回绑定会话
- 所有对话通过 pi-mono agent runtime 调用用户配置的 LLM provider

## 1. 技术栈（固定）

- Electron ^38（pi 包 engines 要求 Node >= 22.19），electron-vite ^2，TypeScript ^5.6
- React ^18.3 + react-dom，状态管理 zustand ^5，样式 Tailwind CSS ^3.4
- 数据库：better-sqlite3 ^11（主进程内，WAL 模式）
- 本地调度：croner ^10（Cron、IANA 时区、下一次执行计算；无服务端依赖）
- Agent runtime：pi-mono（具体包名与 API 见 §8，依据调研结果填写）
- 构建：electron-vite build；打包说明用 electron-builder（README 中说明，不要求交付时产出安装包）
- Node >= 22.19（系统 Node 用于构建；原生模块及冒烟测试使用 Electron 的 ABI）

## 2. 进程架构

```
main/           Electron 主进程（Node）
  index.ts          入口：窗口创建、app 生命周期
  db.ts             SQLite 打开、migration、DAO 函数
  ipc.ts            ipcMain.handle 注册全部通道（白名单）
  agentRuntime.ts   pi-mono 封装：provider 解析、agent 会话创建、流式转发
  orchestrator.ts   群聊编排（成员判断 → 并发/顺序回复 → 落库）
  decisionStrategy.ts Bot 响应决策策略（自动 / 传统 LLM / TypeSafe Jev）
  cli/              本地 CLI 运行后端（codex / claude 适配器、探测、会话续接）
  memory.ts         实时短摘要、场景归纳、检索与注入
  scheduledTasks.ts 本地定时器恢复、无重入执行与状态更新
  workspace.ts      每 Bot 工作区目录管理
preload/
  index.ts          contextBridge.exposeInMainWorld('covan', api)
renderer/         React 应用（electron-vite renderer）
  src/
    App.tsx, main.tsx, index.css
    stores/         zustand stores（bots, chats, messages, settings）
    components/     Sidebar / ChatList / ChatView / MessageBubble /
                    Composer / BotSettingsPanel / SettingsModal /
                    NewBotDialog / NewGroupDialog / MemoryPanel / WorkspacePanel
    lib/api.ts      window.covan 类型化封装
shared/
  types.ts          全部 TS 类型（主/渲染共享）
  ipcChannels.ts    IPC 通道名常量
```

## 3. 数据模型（SQLite）

数据库文件为 `~/.covans/covan.db`，WAL 模式；目录不存在时自动创建。

```sql
CREATE TABLE providers (
  id TEXT PRIMARY KEY,            -- uuid
  name TEXT NOT NULL,             -- 显示名 "OpenAI 主账号"
  kind TEXT NOT NULL,             -- ProviderKind，含 lm-studio/openai-compatible/mock
  api_key TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL DEFAULT '', -- 可空，openai-compatible 必填
  default_model TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE bots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',   -- 相对 userData 的路径或内置 emoji 头像 id
  gender TEXT NOT NULL DEFAULT 'female', -- female|male；旧库按已有内置头像迁移，否则 female
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',     -- 逗号分隔
  system_prompt TEXT NOT NULL DEFAULT '',
  provider_id TEXT REFERENCES providers(id),
  model TEXT NOT NULL DEFAULT '',    -- 空 = 用 provider 默认
  temperature REAL NOT NULL DEFAULT 0.7,
  max_tokens INTEGER NOT NULL DEFAULT 1000000, -- 输出预算可配置 64–1000000（1M）
  reasoning_effort TEXT NOT NULL DEFAULT 'medium', -- off|low|medium|high|xhigh
  response_decision_strategy TEXT NOT NULL DEFAULT 'auto', -- auto|llm|jev
  backend TEXT NOT NULL DEFAULT 'api',    -- api|codex-cli|claude-cli
  cli_path TEXT NOT NULL DEFAULT '',      -- 空 = 在 PATH 中按命令名查找
  cli_access TEXT NOT NULL DEFAULT 'read-only', -- read-only|workspace-write
  workspace_dir TEXT NOT NULL DEFAULT '',  -- 相对 workspaces/ 的目录名
  notify INTEGER NOT NULL DEFAULT 1,
  welcome_at INTEGER NOT NULL DEFAULT 0, -- 首次开场白生成时间；0 表示尚未生成
  is_coordinator INTEGER NOT NULL DEFAULT 0, -- legacy：仅兼容旧库，现行调度不读取
  pinned INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,               -- 'dm' | 'group'
  name TEXT NOT NULL DEFAULT '',    -- group 必填；dm 空
  bot_id TEXT REFERENCES bots(id),  -- dm 专用
  coordinator_bot_id TEXT REFERENCES bots(id), -- legacy：仅兼容旧库
  background_image TEXT NOT NULL DEFAULT '', -- 内置聊天背景文件名；群聊新建随机，私聊可手动设置
  last_message_at INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  reply_mode TEXT NOT NULL DEFAULT 'sequential', -- 'active'|'sequential'
  context_summary TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE chat_members (
  chat_id TEXT NOT NULL REFERENCES chats(id),
  bot_id TEXT NOT NULL REFERENCES bots(id),
  role TEXT NOT NULL DEFAULT 'member',  -- legacy 可含 coordinator；现行统一按 member
  PRIMARY KEY (chat_id, bot_id)
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  sender_type TEXT NOT NULL,        -- 'user'|'bot'|'system'
  sender_bot_id TEXT,               -- bot 消息必填
  content TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]', -- JSON [{path,name,mime}]
  artifacts TEXT NOT NULL DEFAULT '[]',   -- JSON [{relPath,name,size,mtime,operation}]
  mentions TEXT NOT NULL DEFAULT '[]',    -- JSON [botId]
  status TEXT NOT NULL DEFAULT 'done',    -- 'streaming'|'done'|'error'|'stopped'
  error TEXT NOT NULL DEFAULT '',
  system_kind TEXT NOT NULL DEFAULT '',   -- ''|'topic_boundary'|'welcome'
  created_at INTEGER NOT NULL
);
CREATE TABLE chat_topics (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  boundary_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,                  -- 分界前累计上下文摘要，最多 6000 字
  previous_message_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE bot_cli_sessions (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  backend TEXT NOT NULL,
  fingerprint TEXT NOT NULL,              -- 运行方式|可执行文件|权限|工作区
  session_id TEXT NOT NULL,               -- CLI 自身返回的会话 ID
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, chat_id)
);
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  kind TEXT NOT NULL DEFAULT 'fact', -- 'fact'|'preference'|'summary'
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'auto', -- 'auto'|'manual'
  created_at INTEGER NOT NULL,
  layer TEXT NOT NULL DEFAULT 'long', -- short|episodic|semantic|long
  source_type TEXT NOT NULL DEFAULT 'legacy', -- chat|private|manual|legacy
  source_id TEXT NOT NULL DEFAULT '',
  scene_id TEXT NOT NULL DEFAULT '',
  participants TEXT NOT NULL DEFAULT '[]', -- JSON [user|botId]
  speaker TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '[]', -- JSON [sourceMessageId]
  expires_at INTEGER,
  last_recalled_at INTEGER
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule TEXT NOT NULL,          -- 'once' | 'cron'
  cron TEXT NOT NULL DEFAULT '',
  run_at INTEGER,                  -- 单次任务的 Unix 毫秒
  timezone TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',  -- 空 = 运行时继承 Bot 模型
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER,
  last_run_at INTEGER,
  last_status TEXT NOT NULL DEFAULT 'idle', -- idle|running|done|error|stopped|missed
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE fitness_profiles (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  age INTEGER,
  sex TEXT NOT NULL DEFAULT '', -- ''|female|male|other
  height_cm REAL,
  weight_kg REAL,
  body_fat_pct REAL,
  waist_cm REAL,
  goal TEXT NOT NULL DEFAULT '',
  target_weight_kg REAL,
  target_date TEXT NOT NULL DEFAULT '', -- YYYY-MM-DD
  experience TEXT NOT NULL DEFAULT '',
  injuries TEXT NOT NULL DEFAULT '',
  equipment TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE fitness_logs (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  date TEXT NOT NULL, -- 本地 YYYY-MM-DD，同一 Bot 每天一条
  weight_kg REAL,
  waist_cm REAL,
  body_fat_pct REAL,
  sleep_hours REAL,
  steps INTEGER,
  workout TEXT NOT NULL DEFAULT '',
  protein_g REAL,
  calories REAL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(bot_id, date)
);
```

### 3.1 Goals（`main/goals.ts`）

Goals 使用 settings 中自动生成的 `goals_user_id` 作为当前本机 profile 的稳定所有者；调用方不能提供或切换该值。迁移新增 `goals`、`goal_collaborators`、`goal_sessions`、`goal_artifacts`、`goal_updates`、`goal_operations` 和 `goal_order_scopes`：

- `goals` 保存标题、摘要/说明/emoji、状态、来源、分类、一级 `parent_goal_id`、同级 `sort_order`、预留 `fixed_position`、`momentum`、创建会话、主责 Bot、最后触达 Bot、乐观锁 `version` 与时间。根目标和子目标分别按 `(user_id, source, parent_goal_id)` 排序；列表只返回根目标，详情返回一级子目标。
- `goal_collaborators` 与 `goal_sessions` 是目标到 Bot/会话的去重关联；`goal_artifacts` 以 `(goal_id, artifact_type, artifact_key)` 唯一保存经服务校验后的展示快照；`goal_updates` 保存系统活动或进展及作者快照。删除目标级联删除它们，删除 Bot 将主责/作者置空并删除协作者关系，不删除目标；删除会话将创建会话置空并删除会话关联。
- `goal_operations` 和 `goal_order_scopes` 已为操作幂等和排序修订预留表。当前版本只用排序修订记录排序范围；一次性审批、操作结果重放和游标过期协议尚未启用。
- 来源是 `user_goal | assistant_tracking`；状态是 `ACTIVE | PAUSED | RETIRED | COMPLETED`；分类是 `HEALTH | RELATIONSHIPS | MONEY | CAREER | INTERESTS | PRODUCTIVITY | SOMETHING_ELSE`。标题为 1–120 字符，摘要 500、说明 10,000、进展 2,000、emoji 16；动量为 0–1 的有限数。子目标继承父目标的来源、主责和协作者，当前最大深度为根加一级，创建根目标时最多附带 3 个子目标。
- 状态转换为 ACTIVE→PAUSED/COMPLETED/RETIRED、PAUSED→ACTIVE/COMPLETED/RETIRED、COMPLETED→ACTIVE/RETIRED、RETIRED→ACTIVE。父子状态互不自动改变；同值更新不写重复活动。删除目标不会删除实际定时任务、文档或聊天消息。

### 3.2 Agent 主页（`main/agentHome.ts`）

`agent_homes` 以 `bot_id` 为主键保存每个 Bot 的一份 OpenUI 源码、生成时间和更新时间；Bot 删除时级联删除主页。它只保存已通过本地白名单校验的展示声明，不保存目标快照、聊天正文、记忆、工具调用或运行函数。

- 首次读取没有记录时，服务返回不落库的安全模板：一张 `Card`、角色简介与 `GoalsBoard()`。模板不是模型生成结果。
- 重新生成只把 Bot 的人设和固定主页任务交给一次无工具、无聊天记录/记忆的 `completeOnce`；结果必须恰好含一块闭合的 `openui-lang` 围栏，且通过 `validateUiSource`。`Choices`、`Form`、`GoalCreateCard`、`GoalDetail`、`GoalConfirmDelete` 在主页中被拒绝，避免把对话草稿或单目标写入流程放进主页。
- `GoalsBoard` 是声明式受控例外：主页源码不能携带目标行或 ID；renderer 中固定组件仍通过 Goals IPC 查询实际数据，写入只由用户点击触发。生成失败或校验失败保留上一次有效主页；首次失败继续展示本地模板与错误。

## 4. IPC 接口契约（preload 暴露 `window.covan`）

`shared/types.ts` 是可编译的完整接口，`shared/ipcChannels.ts` 是通道白名单；本节记录行为分组与关键签名。任何 IPC 变更必须在同一提交同步 main、preload、shared 和 renderer。

```ts
// shared/types.ts 中定义全部类型；以下为签名（全部 async，主进程实现）
interface CovanApi {
  // images / user context / agent private chat
  importChatImage(name: string, bytes: Uint8Array): Promise<Attachment>;
  getUserProfile(): Promise<UserProfile>;
  saveUserProfile(profile: UserProfile): Promise<UserProfile>;
  pickUserAvatar(): Promise<UserProfile>;
  listUserPresetAvatars(): Promise<UserPresetAvatar[]>; // 仅返回实际随附的用户默认头像
  listUserMemories(): Promise<UserMemory[]>;
  saveUserMemory(content: string, kind?: MemoryKind, id?: string): Promise<UserMemory>;
  deleteUserMemory(id: string): Promise<void>;
  listAgentThreads(chatId: string): Promise<AgentThread[]>;
  getAgentThread(id: string): Promise<{ thread: AgentThread; messages: AgentPrivateMessage[] }>;
  startAgentConversation(chatId: string, fromBotId: string, toBotId: string, message: string): Promise<string>;
  stopAgentConversation(threadId: string): Promise<void>;

  // scheduled tasks
  listScheduledTasks(botId?: string): Promise<ScheduledTask[]>;
  saveScheduledTask(input: ScheduledTaskInput): Promise<ScheduledTask>;
  deleteScheduledTask(id: string): Promise<void>;
  runScheduledTask(id: string): Promise<void>;
  regenerateWelcome(chatId: string): Promise<Message | null>;

  // fitness coach
  getFitnessProfile(botId: string): Promise<FitnessProfile>;
  saveFitnessProfile(input: FitnessProfileInput): Promise<FitnessProfile>;
  listFitnessLogs(botId: string, since?: string): Promise<FitnessLog[]>;
  saveFitnessLog(input: FitnessLogInput): Promise<FitnessLog>;
  deleteFitnessLog(id: string): Promise<void>;
  getFitnessSummary(botId: string, days?: number): Promise<FitnessSummary>;

  // Agent 主页：每个 Bot 一份经过校验的 OpenUI 布局。
  getAgentHome(botId: string): Promise<AgentHome>;
  regenerateAgentHome(botId: string): Promise<AgentHome>;

  // Goals：所有方法都经主进程 GoalsService，以当前本机用户身份执行。
  listGoals(options?: GoalListOptions): Promise<GoalsListResponse>;
  getGoal(id: string): Promise<Goal>;
  runGoalNextStep(id: string, expectedVersion?: number): Promise<GoalExecution>;
  stopGoalExecution(id: string): Promise<void>;
  controlGoalExecution(executionId: string, action: 'pause' | 'resume' | 'stop' | 'accept'): Promise<GoalExecution>;
  listGoalExecutions(chatId: string): Promise<GoalExecution[]>;
  sendGoalExecutionInput(executionId: string, text: string, requestId: string): Promise<GoalExecutionInput>;
  sendGoalFollowUp(chatId: string, replyToMessageId: string, text: string, requestId: string): Promise<Message>;
  createGoal(input: GoalCreateInput): Promise<Goal>;
  updateGoal(id: string, patch: GoalPatch, expectedVersion?: number): Promise<Goal>;
  deleteGoal(id: string, expectedVersion?: number): Promise<void>;
  addGoalUpdate(id: string, text: string, expectedVersion?: number): Promise<GoalUpdate>;
  attachGoalArtifact(id: string, artifact: GoalArtifactInput, expectedVersion?: number): Promise<Goal>;
  reorderGoals(orderedIds: string[], source: GoalSource, parentGoalId?: string | null): Promise<void>;

  // providers
  listProviders(): Promise<Provider[]>;
  saveProvider(p: ProviderInput): Promise<Provider>;
  deleteProvider(id: string): Promise<void>;
  listProviderModels(id: string): Promise<string[]>;
  testProvider(id: string): Promise<{ ok: boolean; error?: string; models?: string[] }>;
  getJevConfig(): Promise<JevConfig>;              // 只返回 has_api_key，不返回密钥
  saveJevConfig(input: JevConfigInput): Promise<JevConfig>; // api_key 省略保留、空串清除
  testJev(): Promise<TestJevResult>;
  probeLocalCli(kind: LocalCliKind, executablePath?: string): Promise<LocalCliProbe>; // 只探测本机可执行文件与版本
  listLocalCliModels(kind: LocalCliKind, executablePath?: string): Promise<LocalCliModelCatalog>; // 本机 CLI 模型目录（不启动推理）

  // bots
  listBots(): Promise<Bot[]>;
  createBot(input: BotInput): Promise<Bot>;
  updateBot(id: string, patch: Partial<BotInput>): Promise<Bot>;
  deleteBot(id: string): Promise<void>;
  listPresetAvatars(): Promise<PresetAvatar[]>;        // id/label/gender/avatar/lifestyle，只返回实际随附的素材
  pickAvatar(botId: string): Promise<string>;          // 打开文件对话框，拷贝进 avatars/，返回路径
  generateAvatar(botId: string, prompt: string, mode?: 'local'|'image'|'auto'): Promise<string>; // 返回保存路径；失败 reject
  expandAvatarPrompt(botId: string, direction?: string): Promise<AvatarDesign>;

  // chats
  listChats(): Promise<ChatSummary[]>;                 // 含最后一条消息预览、未读、成员头像、聊天背景
  createDm(botId: string): Promise<Chat>;
  createGroup(name: string, memberBotIds: string[], coordinatorBotId?: string, replyMode?: GroupReplyMode): Promise<Chat>; // coordinatorBotId 仅兼容旧调用；group 随机分配内置背景；replyMode 省略为 sequential，创建时原子保存，IPC 拒绝非法值
  updateChat(id: string, patch: { name?: string; coordinatorBotId?: string; replyMode?: 'active'|'sequential'; backgroundImage?: string }): Promise<void>; // coordinatorBotId 已弃用；backgroundImage 必须为空或来自内置背景清单
  addChatMembers(chatId: string, botIds: string[]): Promise<void>;
  hideChat(chatId: string): Promise<void>;
  clearChatMessages(chatId: string): Promise<void>;
  deleteChat(id: string): Promise<void>; // 停止生成后永久删除会话及关联记录
  markRead(chatId: string): Promise<void>;
  exportChat(chatId: string): Promise<string | null>; // 原生保存对话框，导出完整 Markdown 历史
  writeClipboard(text: string): Promise<void>;        // 原生剪贴板写入，不暴露读取接口

  // messages
  listMessages(chatId: string, before?: number, limit?: number): Promise<Message[]>;
  getChatTopicState(chatId: string): Promise<ChatTopicState>;
  startChatTopic(chatId: string): Promise<StartChatTopicResult>;
  sendUserMessage(chatId: string, content: string, mentions: string[], attachments?: Attachment[]): Promise<void>;
  stopChat(chatId: string): Promise<void>;             // 停止该会话普通/定时生成；目标任务独立停止

  // memory
  listMemories(botId: string): Promise<Memory[]>;
  addMemory(botId: string, content: string, kind?: string): Promise<Memory>;
  deleteMemory(id: string): Promise<void>;

  // workspace
  listWorkspaceFiles(botId: string): Promise<WorkspaceFile[]>;
  openWorkspace(botId: string): Promise<void>;         // shell.openPath
  revealWorkspaceFile(botId: string, relPath: string): Promise<void>; // shell.showItemInFolder
  readWorkspaceFile(botId: string, relPath: string): Promise<string>;
  printWorkspaceFile(botId: string, relPath: string): Promise<PrintResult>;
  pickAndPrintDocument(): Promise<PrintResult>;

  // settings
  getSetting(key: string): Promise<string>;
  setSetting(key: string, value: string): Promise<void>;
  openObservabilityLogs(): Promise<void>;

  // 事件订阅（返回取消订阅函数）
  onEvent(cb: (ev: CovanEvent) => void): () => void;
}

type CovanEvent =
  | { type: 'user-context-updated' }
  | { type: 'memories-updated'; botId: string }
  | { type: 'agent-thread-updated'; chatId: string; threadId: string }
  | { type: 'message-start'; chatId: string; message: Message }
  | { type: 'generation-state'; chatId: string; generating: boolean }
  | { type: 'scheduled-task-state'; chatId: string; taskId: string; running: boolean }
  | { type: 'agent-activity'; chatId: string; botId: string; state: 'preparing'|'speaking'|'idle' }
  | { type: 'message-delta'; chatId: string; messageId: string; delta: string }
  | { type: 'message-done'; chatId: string; message: Message }
  | { type: 'message-error'; chatId: string; messageId: string; error: string }
  | { type: 'chat-updated'; chatId: string }
  | { type: 'bot-updated'; botId: string }
  | { type: 'scheduled-tasks-updated'; taskId?: string }
  | { type: 'fitness-updated'; botId: string }
  | { type: 'goal-updated'; goalId: string; version: number }
  | { type: 'goal-deleted'; goalId: string }
  | { type: 'goals-reordered'; source: GoalSource; parentGoalId: string | null }
  | { type: 'agent-home-updated'; botId: string }
  | { type: 'notification-click'; chatId: string }
  | { type: 'system-message'; chatId: string; message: Message };
```

## 5. 群聊编排协议（orchestrator.ts）

### 5.0 新话题与上下文边界

- 单聊和群聊顶部都提供「开始新话题」。用户确认后，主进程先用该会话 Bot（群聊优先协调者，否则首位成员）把更早话题摘要、当前群滚动摘要和当前话题原文压缩成累计摘要；摘要成功后才在同一事务中写入 `chat_topics` 和 `system_kind='topic_boundary'` 的可见系统分界消息。摘要失败不得创建半成品边界。
- 摘要通过内部 Provider completion 执行：API Bot 使用自己的 Provider/模型；CLI Bot 优先使用显式判断用 Provider，否则使用第一个带 API Key 的非 mock Provider，并使用该 Provider 的默认模型，绝不传入 CLI 模型名。不启动或续接 CLI 来生成摘要；缺少 Provider 或默认模型时保留原上下文并报配置错误，不改写 Bot 的运行方式、Provider 或 CLI 模型配置。
- `listMessages`、导出和 UI 分页继续返回完整历史；模型历史、群聊判断、自然续发、定时任务和记忆检索查询只读取最新边界之后的原文，并把最新 `chat_topics.summary` 作为只读旧话题资料注入 system prompt。群聊 `context_summary` 在分界成功后清空，从新话题重新滚动。
- 当前话题达到 40 条 user/bot 消息，或至少 12 条消息且连续 24 小时未活动时，UI 提醒开始新话题；阈值只触发提示，未经用户确认不得调用摘要模型或改变上下文。
- 边界按 SQLite `rowid` 截断而非只按时间戳，避免同一毫秒消息越界。正在生成或已经执行摘要时，UI 禁用入口；主进程还必须拒绝与普通会话轮次并发创建边界。
- 开始新话题不删除消息、记忆、产物、定时任务或 Agent 私聊。清空/删除会话时，关联 `chat_topics` 随消息或会话级联删除。观测日志只记录消息数、输入/输出字符数、耗时和错误分类，不记录摘要或聊天正文。

触发：`sendUserMessage(groupChatId, …)`。
1. 落库用户消息；发 `chat-updated`。
2. 每位成员按自己的 `response_decision_strategy` 判断：默认 `auto` 在 TypeSafe Key 已配置时优先 Jev，否则使用当前 LLM；`llm` 强制使用当前 Provider/Model 输出 `REPLY` 或 `SKIP`；`jev` 将经过裁剪的 Bot 身份、前文总结和最新 5 条消息作为结构化 state，向 TypeSafe System One 提交 `reply|skip` Choice。传统 LLM 的群聊与续发轻量判断关闭推理，避免短输出预算被 reasoning 消耗。被用户 @mention 的成员跳过模型判断并必须回复。
3. `reply_mode='active'`：所有成员并发判断，决定回复的成员并发输出。
4. `reply_mode='sequential'`：成员按群成员顺序逐个判断、回复，后面成员可以看到前面成员的输出。
5. 两种模式生成期间 Composer 都保持可发送。新用户消息立即落库并提高群修订号；所有尚未完成的成员判断被取消，再基于包含新消息的最新 5 条上下文重新开始。已在流式输出的回复不截断，后续成员或下一轮读取新消息。过期修订的判断结果必须丢弃。
6. 首轮结束后，成员可基于刚发生的真实发言继续第 2–5 轮讨论；每轮都重新判断，只有能补充新信息、回应具体观点、提出异议或推进未决问题才 `REPLY`，无人回复立即停止。`@mention` 仅强制首轮，整次用户话题硬上限为 5 轮。
7. 准备判断/正在输出通过 `agent-activity` 推送。回复机制不写入 system 消息，不在聊天消息区显示调度文案。
8. 流式 delta → `message-delta`；完成 → 落库 + `message-done`。轮次完成后异步刷新群聊前文总结，并触发分层记忆归纳。

单聊（dm）：直接调用该 bot agent。设置项 `natural_follow_up` 默认开启；开启时主回复提示要求按即时聊天节奏输出：较长内容先发送一个自然完整的语义段，一条即可回答时仍完整回答。主回复完成后按 Bot 的响应决策策略判断是否续发：传统 LLM 继续用一次轻量 completion 同时返回 `SKIP` 或 `REPLY\n<候选短消息>`；Jev 只返回结构化 `reply|skip`，选择 `reply` 后再由 Bot 当前 LLM 起草正文。仅在仍有未完成的新内容、遗漏重要具体信息或存在必须由用户回答的明确问题时追加，最多 2 条。候选在写入消息前必须通过 240 字上限、近期回复长片段去重和调度元话术过滤；完整回答、只能复述改写、寒暄、泛泛关心、格式无效、判断失败、停止或主回复失败都不追加。跟进不再对以 assistant 消息结尾的历史调用 `agent.continue()`。

`decisionStrategy.ts` 是群聊发言和自然续发共用的策略边界。Jev 固定调用 `POST https://api.typesafe.ai/v1/systemone`，默认模型 `jev-latest`，问题使用显式 `reply|skip` Choice；TypeSafe API Key 使用 Electron `safeStorage` 加密后存入 settings，renderer 只能读取是否已配置。全局可设置模型与 0.50–0.95 置信度阈值（默认 0.60）。Jev 置信度低于阈值、未配置、超时、返回无效或服务失败时回退原有 LLM 判断；取消信号不回退。Jev state 只包含决策所需的 Bot 名称/描述/标签/截断人设、会话名/摘要/最新 5 条消息、轮次及审核规则，不包含 API Key、工具内容或附件二进制。生成回复正文始终使用 Bot 当前 Provider/Model。

普通 Agent 若 Provider 以 `stop_reason=length` 结束且可见正文为空，不得写入 `done` 空白消息；消息标记为失败并提示输出 Token 被推理耗尽。已有部分正文时仍保留部分结果。观测事件同时记录上下文窗口、输入上下文占比、输出预算占比、推理占输出比和可见字符数，以区分输入上下文超限与输出预算耗尽。

Bot 的最大输出预算支持 64–1000000（1M）的整数，新建 Bot 默认 1M；设置页、创建与更新接口使用同一范围。普通 API Agent 与内部 completion 在请求前取配置预算（内部用途有显式预算时优先）和 SDK 模型声明最大输出的较小值，SDK 再按剩余上下文收敛；保存的 Bot 配置不随请求调整。1M 表示输出预算配置，不代表模型上下文或服务端承诺的输出能力；已有 Bot 的保存值保持不变。

普通 Agent 生成不再把最新用户消息预填进历史后调用 `agent.continue()`；历史只初始化到上一条消息，最新的 user/toolResult 通过 `agent.prompt(message)` 显式开始本轮，兼容要求本轮必须存在 user query 的 LM Studio Jinja 模板。

### 5.1 定时 Agent 任务（scheduledTasks.ts）

- `scheduled_tasks` 保存 Bot、目标 chat、任务提示词、单次 Unix 毫秒或 Cron、IANA 时区、可选模型覆盖与最近状态。`bot_id` 和 `chat_id` 都使用级联外键；保存时额外验证 Bot 仍是目标会话成员。
- 应用启动后用 Croner 恢复所有已启用的未来任务；单次任务触发后自动停用，重启时错过的单次任务标记 `missed` 而不补跑。重复任务从下一次 Cron 匹配继续。每任务同一时刻最多运行一次。
- 运行时复用 Bot 当前 Provider/模型/采样参数；`model` 非空时只为该次运行替换模型。编排器插入一个 streaming Bot 消息并用真实 Agent 输出更新；不会落库伪造的 user 消息。运行前后成对广播 `scheduled-task-state`，渲染层将它与用户发起轮次独立计数，避免任务结束时错误清掉普通轮次或遗留“回复中”。完成、失败或停止写入任务最近状态并广播 `scheduled-tasks-updated`。
- 普通会话应用工具提供 `list_scheduled_tasks`、`create_scheduled_task`、`update_scheduled_task`、`delete_scheduled_task`；所有写操作仅限当前 Bot、当前会话。Agent 私聊不装配这些工具。

设置项 `local_observability` 默认关闭。开启后，主进程向 `<userData>/logs/observability.jsonl` 写入 JSON Lines 结构化事件：运行阶段、Provider/模型、匿名化后的 chat/bot/message/trace/task ID、角色序列、各消息字符数、payload 角色及 user 索引、请求/工具序号、耗时、Token 用量、上下文窗口与输入占比、输出预算与推理占比、可见字符数、停止原因、HTTP 状态、续发与群聊决策、Jev 模型/置信度/阈值/回退原因、定时任务排程/触发/完成/错过/失败、内部 completion 调用及归一化错误码。Agent 与模型调用接受同轮 `trace_id`，用于关联不同回复消息和调度阶段。禁止写入消息正文、prompt、Jev state、工具参数与返回值、API Key、Provider 完整错误文本；单文件 5MB 后轮转为 `.1`，仅保留当前文件和一份历史。`openObservabilityLogs` 只打开日志目录。

### 5.2 消息诊断

- Bot 回复（包含正在生成、失败和停止状态）旁提供 Bug 图标，复制 `covan-debug:v1:<messageId>`；标识不包含聊天正文。设置 → Debug 可粘贴标识或消息 ID。
- IPC `getDiagnosticReport(reference): Promise<DiagnosticReport>` 只在主进程查询指定 Bot 消息的状态、输出字符数、归一化错误码、当前模型配置以及是否存在运行任务。只读取固定的当前/上一份本地日志；先按匿名化 message ID 找到消息，再将其 trace ID 下的事件合并，最多返回最近 200 条，字段按白名单输出。不能传入任意日志文件路径或直接将用户粘贴内容作为模型指令。
- 普通回复和定时任务的 Agent 调用携带消息 ID 与同轮 trace ID；记录 Provider 请求序号、状态和耗时，首段文字耗时，工具序号/名称/输入输出字符数/成败/归一化错误类别/HTTP 状态/耗时，每个模型步骤的 Token 用量及停止原因。所有 `completeOnce` 调用记录开始、payload 摘要、响应、结束或失败、模型参数与用量；已标注群聊判断、续发、记忆摘要、上下文摘要和头像提示等用途。群聊每次 REPLY/SKIP、强制回复、失败降级和过期重试均有事件。工具参数、返回内容、推理正文均不记入日志。
- 定时器记录启动/停止、计划恢复、下次触发时间、定时/手动触发、重复运行跳过、执行完成/失败、错过单次任务和恢复失败；每次执行关联匿名 task ID 和 trace ID，并与其投递的 Bot 消息共享 trace ID。任务标题、指令和原始异常文本不入观测日志。
- Debug 显示日志关闭、缺失、轮转、旧版未关联或消息生成态残留等证据限制；开启日志只影响之后的调用，无法补回历史。模型配置标明为当前值，历史执行参数以事件为准。
- IPC `analyzeDiagnostic(reference, botId): Promise<string>` 在主进程重新采集报告，通过所选 Bot 当前 Provider/模型执行独立 completion，沿用其推理强度、输出上限和温度（新 Bot 默认 medium / 1M，实际请求受模型最大输出与剩余上下文限制），120 秒超时；无工具、无人设/聊天/记忆注入，不落入聊天记录。全局只允许一个分析，`cancelDiagnostic()` 取消分析，离开 Debug 页也取消。空正文、输出截断、网络、鉴权、限流、配置及服务错误分类返回中文建议，取消与超时分别显示，不透传 Provider 原始错误。
- 分析使用独立 `diagnostic_id`，开启本地日志时记录 `diagnostic.*` 开始、HTTP 响应、结束原因/Token 用量、完成或失败及耗时；关联源消息但以 `phase=diagnostic` 区分，不改变源消息状态。失败提示携带分析编号，刷新报告可查询；不记录分析正文和原始错误。Debug 分别显示源回复当前配置和诊断 Bot 的实际 Provider、模型及预算，隐藏 Electron IPC 错误包装。页面说明发送的数据范围和服务额度，并区分模型推测与证据。

### 5.3 引用草稿

- 点击引用时，草稿保存 `{messageId, author, content}`，在输入框内部上方显示左侧色条、作者和可滚动引用摘录，并可单独取消；正文输入不混入 `>` 原始标记。每个会话独立持久保存引用与正文，重载后恢复。
- 发送时将作者与原文序列化为 Markdown 引用，再拼接用户正文，经既有发送接口进入模型上下文；仅引用也可发送。输入区和引用区隐藏滚动条但保留滚动、文本选择和中文输入法行为。

### 5.4a 消息内生成式 UI（OpenUI）

- Agent 单聊、群聊的正式 Bot 回复可混排 Markdown 和 `openui-lang` 围栏。运行时注入共享组件规格生成的 UI 提示；普通交流默认 Markdown，比较、可视化、选项与信息收集时按需生成 UI。API 和本地 CLI 均支持，后台判断/摘要不注入这段提示。新生成只使用 SDK inlineMode 认可的 `openui-lang` 标签；解析器同时接受历史消息中的 `openui` 标签，升级前已保存的界面继续渲染。每条消息的界面独立完整，从 Card 根开始，不接受只输出变更语句的增量写法。
- `openui-lang` 围栏使用开源 OpenUI Lang，由 renderer 的本地白名单组件渲染：Card、Text、Metric、Callout、Tag、List、Separator、Table、BarChart、LineChart、AreaChart、PieChart、RadarChart、RadialChart、ScatterChart、Steps/StepsItem、Stack、Tabs/TabItem、Accordion/AccordionItem、Choices、Form。复用 `messages.content` 和现有 IPC 增量，复制/导出保留原始内容，重启及新话题不破坏旧消息。用户消息和 Agent 间咨询记录保持普通 Markdown。
- 围栏未闭合时保持流式预览，正式回复未完成、失败或停止时全部交互禁用。源码超限、未知组件、非法属性、循环引用、解析/渲染失败时显示局部降级提示和可展开源码，不能拖垮聊天。限制每消息最多 3 块 UI、每块 24,000 字符、120 个语法节点及 12 层引用深度；表格最多 50 行、8 列，柱状图最多 50 项，折线图/面积图最多 24 个点，饼图 2–12 项，雷达图 3–10 项，进度环 1–8 项（values 为 0–100），散点图 2–100 个点；Stack 子项最多 16，Tabs/Accordion 最多 8 组，Steps 最多 8 项，表单/选项最多 8 项。
- 组件仅支持本地受控渲染；不接入 Gateway、云端观测、远程纠错或 Renderer toolProvider，不渲染任意 HTML/JS，不支持 Query/Mutation/自定义函数或模型声明的动作执行。官方默认库中依赖动作/查询/可编辑表格、外部图片 URL 和复杂表单控件的组件不在白名单内；需要时先扩展 SPEC 与校验，不能由模型直接启用。数据只来自当前 Bot 消息，不把显示为卡片等同于事实验证。
- Choices 按钮与 Form 提交把人类可读内容追加至所属会话的输入草稿，并附来源消息引用；群聊同时记录并插入 @来源 Bot。保留已有正文、附件、提及，不直接发送或执行工具/定时任务。用户通过正常发送操作确认，沿用现有群聊规则。群成员离开后不再提供该消息的交互入口。
- 未提交表单状态仅在当前界面内维护；重载后从组件初值重新填写。生成的回复草稿沿用现有持久化，重载不会重复提交或调用模型；不同消息/围栏/群成员的表单互不共享。

### 5.4b Goals：本机共享目标（G1 第一批）

- **任务状态机与异步派单（2026-11-02）**：`runGoalNextStep(id, expectedVersion?)` 由用户启动 ACTIVE 且有有效主责的目标，先持久化为 queued，优先处理未送达用户补充，再领取专家，同优先级按入队顺序 FIFO 领取。每目标最多一个未结束的根执行；重复启动返回原执行。全局最多两项主责阶段、四项实际运行（含专家）；等待、暂停、阻塞和待验收不占执行名额，满额任务留在持久队列中。
- 执行状态为 `queued | running | waiting_experts | waiting_input | paused | blocked | review | done | error | stopped`。状态转换由主进程统一校验。主责生成最终结果且没有未完成专家时进入 review，由用户「验收本轮」置 done；不自动完成 Goal。专家成功直接 done。失败进入 error，可显式重试同一执行；停止为 stopped，不自动重启。Goal 仍与执行状态独立。
- 主责 API 工具 `consult_goal_expert` 校验用户配置的协作 Bot 后持久化独立子执行，立即返回派单 ID/当前状态，不等待报告；同一调用键重试复用派单，不同参数复用键拒绝。每根最多 3 项专家派单，专家不得递归派单或修改目标/用户资料。`wait_goal_experts` 使主责让出名额等待；主责自然结束但仍有未结束专家时也进入 waiting_experts。专家完成/失败/停止后的真实报告和文件引用持久化到收件箱，在下一模型步骤送达；等待中的主责在专家全部结算后自动排队恢复并汇总，无需用户发送“继续”。暂停、等待用户或已停止的主责不因专家结果自行运行。
- `request_goal_input(question)` 和 `block_goal_task(reason)` 让执行保存上下文后进入 waiting_input/blocked，不靠自由文本猜测状态。`sendGoalExecutionInput(executionId, text, requestId)` 支持根与专家的未结束执行，按执行与请求 ID 去重；给等待输入、阻塞或待验收任务补充后继续排队，给 paused 任务补充只保存，仍须用户继续。未引用任务的普通 Composer 消息维持普通聊天，不猜测任务归属。
- **应用内后续消息路由（2026-11-02）**：引用后台任务回复或此前的任务补充时，普通输入框明确显示「继续此任务」；发送通过 `sendGoalFollowUp(chatId, replyToMessageId, text, requestId)` 直达原执行，不启动普通聊天轮次。主进程按真实引用关系解析目标并校验同会话、有效执行、目标主责／专家范围；只支持 1–2000 字的新补充，附件须移除或取消引用后按普通聊天发送，不静默丢弃附件。取消引用恢复普通聊天；无引用的普通消息不推测归属。
- 后续消息、任务收件箱和唤醒状态在同一 SQLite 事务保存，提交后才发事件和调度；按执行／请求键去重，同键不同正文或不同引用拒绝。重试已提交请求返回同一聊天消息，不重复派发，即使任务后来已经验收／停止。消息永久标注任务来源，避免目标删除后补充被重新解释成普通聊天；输入记录保存来源消息和引用消息，展示待处理／已送达／关联已失效。暂停任务只保存新补充，已停止／已验收任务拒绝新补充并保留草稿，不能通过引用扩大授权或复活终态。
- 用户给 waiting_experts 的执行补充会将其重新排队，先处理新要求，未完成专家仍保留；报告和其他资料不绕过等待用户／暂停状态。调度在既有并发上限内优先处理已有任务的未送达用户补充，再领取其他专家和新目标；同优先级按入队顺序，队列位置使用同样顺序。
- `controlGoalExecution(executionId, action)` 为用户命名 IPC，action 是 `pause | resume | stop | accept`。暂停取消当前调用并保存执行上下文，继续使用相同 executionId、目录和真实历史；不是创建新任务或从头执行。主责暂停/停止传播到其专家；单独暂停/停止专家不影响其他目标，主责继续时只恢复因该主责暂停的专家，不恢复用户单独暂停的专家。等待输入须先补充；error 可由用户重试，done/stopped 不自动复活。验收仅对没有未完成专家的 review 根执行开放；补充修改意见可从 review 回到 queued。
- 每项执行使用独立 runtime/session、`tasks/<executionId>/` 和取消信号。API 完整步骤与输入/报告送达标记在同一事务保存，恢复时带入真实工具结果；中断且没有结果的工具调用标为“结果未知，先核对”，不自动重放。CLI 的任务会话 ID 单独持久化，不覆盖 bot/chat 普通会话；补充要求在当前 CLI 调用结束后处理，批量要求一起送入下一调用。每项累计活跃执行最多十分钟，等待、暂停与应用离线不耗用此时长；活跃时长每秒持久化并在阶段结束补齐，崩溃最多损失一秒采样。预算耗尽进入 error，需用户结束本轮后另开执行。
- `goal_executions` additive 字段保存上下文检查点、原因、暂停前状态、运行次数、活跃时长与 CLI 续接；`goal_execution_inputs` 保存用户补充及来源／引用消息 ID，`messages.goal_input_execution_id` 独立保留来源标记，`goal_execution_reports` 保存专家报告及幂等送达。`listGoalExecutions(chatId)` 返回最近执行、同类队列位置、原因、输入与专家关系；任务卡可补充、暂停、继续、停止和验收。后台消息带只读 `goal_execution_id`，不锁普通聊天；任务阶段复用同一消息，实际文件按成功工具结果关联目标，专家报告保留作者。
- 正常退出取消实际执行并保存为 paused，崩溃恢复也将已开始但未结束的计算暂停，保留检查点、待处理要求和专家报告，不自动重放。尚未开始的 queued 任务可在应用启动后按原授权首次执行；waiting_input/blocked/review 保持等待，因主责暂停而挂起的专家不抢跑。清空/删除会话、删除相关 Bot、完成/改派/删除目标取消相关执行；暂停 Goal 暂停相关执行，恢复 Goal 后仍由用户继续任务。独立定时任务语义不变。

- **同 profile 单实例**：主进程设置 userData 后、打开数据库与恢复任务前获取 Electron 单实例锁；同 profile 的第二实例只唤起原窗口并退出，不执行迁移／恢复／调度。不同临时 profile 可独立运行。开发重启脚本等待旧实例释放，超过五秒仍未退出才清理该仓库的旧开发进程，再启动新版本。任务补充和后台结果均不作为普通聊天历史或新话题摘要的待回复输入；任务补充只保存在执行上下文／收件箱，不额外写入普通聊天自动记忆或启动其摘要。

- `shared/types.ts` 定义 `Goal`、`GoalUpdate`、`GoalArtifact`、创建/更新/查询输入和上述 IPC；`main/goals.ts` 是唯一的领域服务。renderer、API Bot 与未来协作 worker 不能直接读 SQLite 或自行生成 ID、时间和用户身份。
- API Bot 的普通会话工具集装配 `list_goals`、`get_goal`、`create_goal`、`update_goal`、`delete_goal`、`add_goal_update`、`attach_artifact`、`reorder_goals`。读取与写入均调用同一服务：创建后当前 Bot 成为主责；主责或协作者只能更新状态、摘要、说明、emoji、动量、追加进展或关联内容。改名、改派、协作者变更、删除和排序不由 Agent 工具执行，删除/排序工具仅返回「需要用户确认」；Agent 私聊和本地 CLI 都不装配 Goals 工具。
- 当前用户经命名 IPC 可创建、更新、删除、追加活动、关联与重排。每次更新、追加或关联可带 `expectedVersion`；版本不一致时拒绝写入并要求刷新。写入成功后服务返回真实实体/活动，并在提交后发送 `goal-updated`、`goal-deleted` 或 `goals-reordered`。卡片监听这些事件后重新 `getGoal`/`listGoals`，事件是刷新信号，不是事实源。
- `listGoals` 只查询当前本机用户的根目标，`source` 可选、`status` 省略时为 ACTIVE/PAUSED、单页 1–100（默认 50）；`nextCursor` 是与当前来源和状态筛选绑定的不透明 offset 游标。`getGoal` 返回真实子目标、最多 50 条最新活动和关联。当前游标尚不在排序写入后返回过期错误，调用者应写后重新查询。
- 可关联已存在的 `scheduled_tasks`（cron 或单次）和经工作区 realpath 边界校验的 Bot 文档；重复关联不增加版本或活动。`space` 仅保留类型，当前明确拒绝。暂停或完成目标不改变关联的定时任务。
- OpenUI 组件名为 `GoalsBoard`、`GoalCreateCard`、`GoalDetail`、`GoalConfirmDelete`。模型最多提供筛选、创建草稿或真实 ID，实体展示由组件调用 IPC 读取；看板分「我的目标 / 助手跟踪」，创建卡可提交标题、分类、来源、负责 Bot 和最多 3 条子目标，详情按关联内容、子目标、活动的顺序显示。卡片在消息未完成、失败或停止时禁用；普通 `Choices` 与 `Form` 继续只填入 Composer 草稿。
- 删除始终先在详情显示 `GoalConfirmDelete`，用户点击确认才调用 `deleteGoal`；当前直接用户点击是确认边界，尚未实现跨重载的一次性审批令牌或请求幂等记录。看板筛选/分页控件、详情新增子目标/关联控件、固定位置属于后续工作，不能由模型文本假装已完成。

### 5.4c Agent 个人主页：持久化 OpenUI 布局

- 右侧 Bot 资料可打开该 Bot 的全页「Agent 主页」。首次打开读取安全模板后异步请求 Bot 生成自己的主页；用户可随时点击「刷新主页」再次生成，切换聊天或返回聊天离开该视图。
- `AgentHome` 的 `content` 是单块、完整、静态的 `openui-lang` 声明。主页用与聊天相同的 React/OpenUI renderer，但不属于消息、不会写入会话、不会发送 Composer 草稿；主页可展示角色说明、静态展示组件和 `GoalsBoard`。
- 主进程在写入前校验源码，并拒绝通用对话表单与目标创建/详情/删除卡。模型不能指定 IPC、SQL、函数、任意 HTML/JS、目标数据或目标 ID。`GoalsBoard` 的数据读取、完成/暂停/删除等动作继续走 §5.4b 的真实 GoalsService 和本地事件刷新。
- 生成使用无工具、无聊天记录、无记忆的单次 completion，失败不会覆盖上一份有效主页；没有 Provider 或首次生成失败时，用户仍可在模板中的真实目标看板查看和操作目标。成功写入后发送 `agent-home-updated`，当前页及其他打开该 Bot 主页的 renderer 重新读取。

### 5.4 本地 CLI 运行后端（main/cli/）

- 每个 Bot 有一种运行方式 `backend`：`api`（默认，走 Provider）或 `codex-cli` / `claude-cli`（正文由本机已登录的 CLI 生成）。CLI Bot 仍可配置 Provider，用于「是否发言 / 是否续发」判断以及上下文、记忆等内部摘要，不影响正文生成。所有内部 Provider completion 统一使用显式或默认判断用 Provider 的默认模型，不透传 CLI 模型名，也不修改持久配置。`cli_access` 为 `read-only`（默认）或 `workspace-write`；`cli_path` 为空时在 PATH 中按命令名查找。
- 运行方式、可执行文件路径、模型、文件权限与工作区组成会话指纹。首次发言以 `cli_path` 启动一次 CLI，把系统提示（人设、记忆、审核规则）、既有转录与当前用户消息合并为起始提示词，并记录 CLI 返回的会话 ID；同一 Bot 在同一会话中后续轮次改为续接，只发送最新一条用户消息。指纹变化、清空聊天记录、开始新话题或删除会话都会丢弃映射并重新建立会话。会话映射存 `bot_cli_sessions`，CLI 自身的会话与登录状态仍由 CLI 管理。
- 新建 Bot 与已有 Bot 的模型页共用同一个模型选择器：左轨是 Provider / 本地 CLI 来源，右轨是模型列表。支持来源默认（保存空 `model`）、Provider 模型目录（`listProviderModels`）、CLI 返回的模型目录和自定义 ID。左轨只切换浏览来源，点轨道不写入保存；新建 Bot 没有已保存状态，点轨道即切换运行方式。列表把 Provider 默认模型置顶标「默认」、CLI 推荐模型置顶标「CLI 推荐」、Bot 已保存模型标「(Bot 的模型)」，同一行只保留后者；底部「恢复默认」把 `model` 存为空，tooltip 解释当前浏览来源的默认规则。选择器顶部始终显示「本次将使用」与当前已提交的来源和模型；浏览其他来源不改此摘要，右侧来源标题仅在浏览其他来源时显示，避免重复。模型器保留外框与左右分栏线，摘要、运行配置和默认操作之间用留白代替横线。CLI 检测状态与失败原因直接显示，路径、版本和长说明默认折叠到「运行详情」；路径仍可展开编辑，检测成功不代表登录或模型权限验证。Provider 默认能解析时显示具体模型名；CLI 未指定模型时明确标注具体模型由 CLI 自身配置决定、目录推荐不会自动生效，不把推荐值冒充实际默认。来源不可用（Provider 未填 API Key，本机未检测到 CLI）时轨道项置灰并在名称下写原因，但仍可点开查看与修复。Provider 目录读取失败时就地显示原因与刷新入口，不回退猜测列表。Codex 不再使用写死模型列表；Claude 仍提供 `sonnet` / `opus` / `haiku` 稳定别名并明确标注。Codex 目录可能来自 CLI 缓存，不视作账号权限验证，实际可用性以回复结果为准；空 `model` 沿用 CLI 自己的配置，不等于目录推荐模型。已保存模型不在目录时保留原值、显示提示并提供明确选择 CLI 推荐模型的按钮；不静默替换用户选择。切换运行方式清空旧模型，避免把 API 或另一种 CLI 的模型带入；修改判断用 Provider 不清空已选择的 CLI 模型。自定义 ID 在失焦或 Enter 时提交，新建时随 Bot 保存，模型页即时保存，重载后回显。CLI 路径和权限分别以 `cli_path` / `cli_access` 保存。
- 模型（Bot 的 `model` 字段）在新建与续接调用中都必须下发：`codex exec resume` 不带 `-m`、`claude --resume` 不带 `--model` 时会回退 CLI 自己的默认模型，与建会话时不一致会触发 CLI 警告，默认模型不可用时整轮直接失败。为空时才使用 CLI 默认模型。
- Codex：`codex exec --json --sandbox <read-only|workspace-write> -C <工作区> --skip-git-repo-check [-m 模型] [-i 图片] <提示词>`；续接为 `codex exec resume <会话 ID> --json --skip-git-repo-check [-m 模型]`（resume 不支持 `--sandbox` 与 `-C`，沙箱与工作目录在首次会话确定后继承）。解析 stdout 的 JSONL：`thread.started` 取会话 ID，`item.completed` 中 `agent_message` 取正文增量、`file_change` 转为交付产物、`command_execution`/`reasoning`/`mcp_tool_call` 仅记入观测，`turn.completed` 取 Token 用量，`turn.failed` 与顶层 `error` 视为失败。上行事件形态已用 codex-cli 0.149.0 真机核对。
- Claude：`claude -p <提示词> --output-format stream-json --verbose [--model <模型>] [--resume <会话 ID>] --permission-mode <plan|acceptEdits>`，只读映射为 `plan`、可写映射为 `acceptEdits`。解析 `system(init)` 取会话 ID，`assistant` 的文本块取正文，`result.subtype!=='success'` 或 `is_error` 视为失败。Claude 适配器按文档化契约实现，尚未在真机验证。
- 两条适配器都不存储用户凭据，完全依赖 CLI 自身的登录状态；子进程继承用户真实 HOME 与 PATH（并补齐 Homebrew 等常见安装目录，避免 GUI 启动时找不到命令），以 Bot 工作区为工作目录。正文为空、CLI 未安装、未登录或额度用尽都转为可见错误，不产生空白完成消息。
- 本地 CLI Bot 的「是否发言」判断引擎按顺序解析：显式判断用 Provider → 已配置的 Jev（`auto` / `jev` 策略）→ 第一个带 API Key 的非 mock Provider（即默认判断用 Provider）→ 本机 CLI 自身。默认 Provider 只认带 Key 的来源，避免把未启动的本地服务当默认引擎；借用 Provider 判断时使用该 Provider 的默认模型，不透传 CLI 的模型名。CLI 自身判断只用于群聊首轮，延展轮不再为判断启动进程。正文生成始终由 CLI 负责：CLI 后端优先于 mock Provider，判断用 Provider（含 mock）不接管正文。私聊自然追问需要判断用 Provider 起草候选，只有 CLI 时直接跳过，不为追问额外启动 CLI。判断失败沿用“失败即回复”的兜底，由消息气泡展示错误；判断与引擎选择写入脱敏观测事件（`group.reply_decision.judge_engine`）。
- `cli:models` 解析指定 CLI 路径；Codex 通过 `app-server --listen stdio://` 执行 `initialize` → `initialized` → `model/list`，分页读取公开目录、去重并过滤隐藏项，只向 renderer 返回模型 ID/显示名/推荐标记。不启动 thread/turn，不发送聊天内容，不请求或返回凭据；CLI 自身可能刷新联网目录。15 秒超时、2MB 响应上限、最多 10 页；失败或空目录返回可恢复错误，保留默认/自定义入口，不退回静态列表。结束即关闭进程，未退出时限时终止；界面提供刷新按钮且忽略旧路径/旧请求结果。
- CLI 返回模型不支持（含截图中的 ChatGPT account 400）时，气泡显示中文修复建议：打开「模型」、刷新目录、选择返回的模型后重试，不直接展示原始 JSON，不自动改模型或重新计费调用。
- `cli:probe` 只在本机按命令名或给定路径查找可执行文件并运行 `--version`，返回 `{kind, available, path, version, error}`，不读取登录凭据，也不发起网络请求。

## 6. 分层记忆系统（memory.ts / db.ts）

### 6.1 归属与即时写入

- 普通消息状态进入 `done` 时同步写入实际参与 Bot 的记忆（带任务来源标记的定向补充使用任务自身上下文，不走普通聊天自动记忆）：人和 Bot 单聊写入该 Bot；群消息写入当时全部成员（含未发言成员）；Bot 私聊问题和成功回复分别写入双方。`system`、流式中间态、失败与停止的残缺回复不提取为事实。已送达的问题在接收方失败时仍保留。
- 消息与所有参与 Bot 记忆副本在一个 SQLite transaction 中写入并一起回滚，使用 source_id 幂等去重；不自动共享给未参与的 Bot，不把私聊转述写进全局 user_memories。用户侧保留原始聊天记录；显式的「关于我」共同记忆维持原接口。
- 升级使用 additive migration，旧 memories 原样归入长期层。首次升级按已存 agent_threads 的真实双方补入已完成的私聊记录（过期记录随后清理）；不猜测历史群成员，不读取外部 profile。

### 6.2 层级、归纳与淘汰

| 层级 | 内容与进入方式 | 保留规则 |
| --- | --- | --- |
| short 短时 | 同一场景按非重叠窗口维护极短工作摘要（约 80 字：当前话题、结论、待办/未决）；每窗最多 10 条，首尾跨度最多 15 分钟 | 段内每次新消息后 0.8 秒防抖更新；越过消息数或时间边界开启新窗；生成后 1 天过期 |
| evidence 原文证据 | 已送达消息原文，最多 12000 字，仅供引用与审计 | 原文从消息时间起 90 天，不作为短时摘要直接注入 |
| episodic 场景 | 带参与者、时间和来源的场景归纳，约 500 字 | 摘要从生成起 90 天 |
| semantic 语义 | 后台归纳的事实、偏好、人物关系，附原话证据 | 生成起 180 天 |
| long 长期 | 手动记忆、旧记忆，或用户明确要求记住的后台归纳 | 不自动过期 |

- 每条完整消息送达后，按 Bot/场景启动实时摘要调度；连续消息以 0.8 秒防抖、最迟 5 秒触发一次。短时窗口从本段第一条开始，满足“最多 10 条”且“首尾不超过 15 分钟”时持续更新同一条 `short_summary`，超过任一条件则以新消息开启下一窗口；窗口互不重叠，旧窗口摘要保留至过期。场景 `summary` 仍使用最近最多 30 条、18000 字原文维护更长脉络；单次还可生成最多 4 项稳定记忆，调用 60 秒超时。Bot 私聊成功结束后同样更新双方摘要。每 Bot 同时最多一个摘要任务，进程全局最多两个；忙碌时场景合并排队，失败时保留上一次有效摘要并标记 error，原文证据仍可召回，用户可手动重试。
- 模型必须分别返回短时窗口与场景摘要的证据 ID。写入前对摘要与原文做归一化子串和四字片段重合校验；近似摘抄、格式错误或证据越界时自动重试一次，仍不合格则不把输出保存为摘要。应用启动、手动刷新或新消息归纳时会清理同场景中已存在的近似原文摘要；启动清理不自动发起网络请求，而是在记忆页提示用户刷新。
- 输出须为 `{content, layer, source_id, quote}[]`；验证来源属于该 Bot、来源仍在记忆中、quote 为原文连续摘录。归纳保留发言者与原话，转述不升级为用户亲口确认；长期层还要求来源是用户且包含明确记住意图。模型归纳不是事实验证。
- 相同发言者、相同层级、归纳及原话完全归一化相等才去重，不使用包含关系，避免吞掉否定和纠正。冲突并存并注明来源/时间，回答以当前明确表达优先。
- 启动、读取与检索时维护 TTL；每 Bot 普通自动记忆最多保留 2000 条，按最近召回/创建时间淘汰。手动和长期记忆不进入容量淘汰。淘汰记忆不删除聊天原文。

### 6.3 实时检索与上下文

- 单聊回复、自然跟进、群聊判断/回复、Bot 私聊回复都先检索自己的保留记忆。结合最新用户问题、当前场景、参与 Bot、文本提及的 Bot 名称进行本地检索；中文双字词与英文单词匹配，加上人物、场景、时效与长期权重。无网络/embedding 依赖。
- 检索最多返回 30 条，优先当前场景的 short/episodic 摘要，再补充语义/长期记忆；evidence 原文只在命中具体话题或作为摘要证据时带入。JSON 记忆正文预算 6500 字符；长原文选择靠近查询词的片段。不能只从最近 30 条候选中查找；未命中话题或人物的背景补充最多 3 条。普通人的名字可按文本命中，Bot 名称额外解析为稳定 ID；尚无通用别名/人名实体库。
- 注入内容按层级、时间、发言者、参与者、来源、场景 ID 和证据 ID 编码为 JSON 行，明确是历史资料而非指令/新授权。允许依据来源说「某人曾告诉我」，不得把历史记录说成本轮新执行的咨询。
- 验收案例：猛男私聊 ds 说「橙色的天空来自意大利」，用户立即在另一个会话问 ds「橙色的天空来自哪里」，ds 的模型输入应包含这条原话、猛男身份和私聊来源；第三位未参与 Bot 的检索不可返回该私聊。

### 6.4 数据与管理

- `Memory` 在既有字段上新增 layer/representation/source_type/source_id/scene_id/participants/speaker/evidence/expires_at/last_recalled_at/updated_at；participants/evidence 在 SQLite 为 JSON，在共享类型与 IPC 为数组。旧客户端增删接口不变，手动添加默认长期。另有 `memory_summary_states` 保存每个 Bot/场景摘要状态、游标和错误。
- 记忆 IPC 在原有 `listMemories/addMemory/deleteMemory` 外增加 `listMemorySummaryStates(botId)` 和 `refreshMemorySummaries(botId)`；摘要状态通过 `memories-updated` 事件驱动右栏更新。
- 记忆面板按全部/短时/场景/语义/长期筛选，显示来源、作者、参与者和时间；支持分页展示、手动添加和删除。`memories-updated {botId}` 经现有 typed preload 事件通道即时刷新。
- 删除带证据记忆会同时删除该 Bot 对同一来源的原文与归纳，避免删后仍从摘要召回；另一位 Bot 的副本独立保留。不会从原聊天定期重建已删除记忆。删除聊天不等同于忘记已保存的记忆，需在记忆面板删除。

### 6.5 MCP 与 Skills 扩展

- 设置 → MCP / Skills 分别作为一级全局安装库，提供 MCP 服务的新增/编辑/停用/删除/测试及工具清单。新增 MCP 支持粘贴 mcpServers JSON、单个服务 JSON、单条带引号的启动命令或 HTTP/HTTPS URL，解析并填入后供用户检查；多服务配置必须选择其中一个，本次仅安装该服务。解析不保存、不启动进程、不测试连接，显式点击安装后才保存。启动命令按 argv 解析，不经 shell，拒绝管道、命令链、命令替换与未闭合引号；无效 JSON/参数类型就地提示。参数、工作目录、环境变量与请求头默认折叠到高级配置，编辑已保存服务时展开；原有凭据省略保留约定不变。安装库空状态说明用途与导入方式，Skills 的本地目录或 HTTPS Git 仓库导入、预览、停用与卸载。Bot 右栏 → 扩展独立装配；仅创建时应用所选角色模板声明的默认 Skills，未声明的模板与未指定模板的新 Bot 均无扩展。全局安装不自动授权给任何 Bot，扩展页标明已装配/未装配，Bot 页签数量表示当前装配数。
- MCP 使用官方 TypeScript SDK，支持 stdio、Streamable HTTP 和显式 SSE。stdio 由主进程直接启动 command/args（不经 shell），仅继承 SDK 默认环境和显式配置的 env；远程 URL 不接受用户信息、查询参数和 fragment，凭据通过 headers 配置。env/headers 使用 Electron safeStorage 加密存储，系统加密不可用时拒绝保存非空凭据；列表只返回键名，编辑省略保留、传空对象清除。Provider 原有密钥存储方式不变。
- 每轮为已装配且全局启用的服务建立独立连接，连接/发现各 15 秒、工具调用 60 秒超时，支持停止取消并在结束时关闭连接/子进程。工具名带服务 ID 命名空间；发现最多 128 个工具/服务，单 Bot 最多装配 8 个服务。失败服务以简洁状态加入当前轮上下文，其余能力继续使用。MCP 服务只获知当前 Bot 工作区 root；不提供采样、自动确认或递归调用宿主能力。
- Skills 遵循 Agent Skills 的 YAML frontmatter + Markdown 格式，必须有合法 name/description；安装复制 SKILL.md 及 scripts/references/assets 到应用管理目录，拒绝符号链接与目录逃逸，不自动执行安装脚本。支持一次导入目录中的多个技能，同名重新导入更新并保留 Bot 绑定。每技能最多 1000 文件、单文件 10MB、总 50MB；SKILL.md 与按需读取的文本最多 200KB，拒绝二进制读取。Git 导入限 HTTPS、浅克隆、不启用仓库 hooks/子模块，支持相对子目录；不自动安装系统依赖。
- 每轮仅将已启用 Skill 的名称/描述加入上下文，通过 `skill_read` 按需读正文或附属文件，脚本可由已有 bash 工具按当前任务调用。Bash 沙箱只额外允许只读访问当前 Bot 已装配且启用的 Skill 包，所有写入仍限制在工作区。正文不能覆盖用户请求，也不授予额外权限。单 Bot 最多装配 32 个 Skills。用户通过自然语言明确要求时，Agent 可用 `list_extensions` 和 `configure_extensions` 查看安装库并修改自己的绑定，下轮生效；Agent 不安装新进程或修改全局库。
- 单聊、群聊成员回复与定时任务使用同一套装配；受限 Bot 间咨询维持原有只读工具范围，不加载外部 MCP/Skills。装配在每轮开始快照，删除/停用后禁止发起新调用，已执行的外部动作不回滚。
- `mcp_servers`、`installed_skills` 与两张 Bot 绑定表独立持久化，删除 Bot/扩展级联清理绑定。IPC 为 `listExtensions/saveMcpServer/deleteMcpServer/testMcpServer/pickSkillDirectory/installSkills/readInstalledSkill/setSkillEnabled/deleteSkill/getBotExtensions/setBotExtensions`，全局或装配变化广播 `extensions-updated`。
- 开启观测时，全局安装/装配记录匿名扩展或 Bot ID；回复执行中的 MCP 连接/发现/调用/关闭与 Skill 读取事件关联 message/trace ID，手动连接测试不属于聊天 trace。不记录 URL、命令参数、认证值、Skill 正文或工具输入输出。安装配置属于用户信任的软件，MCP 本地进程以当前用户权限运行，MCP 工作区 root 不是操作系统沙箱。当前 MCP 接入 tools 能力，认证使用手动 headers；不含 OAuth 登录、resources/prompts 界面或在线市场。

## 7. 工作区（workspace.ts）

### 聊天文档附件（2026-10-29）

- 输入框支持选择、拖入、粘贴 PNG/JPEG/WebP/GIF、PDF、UTF-8 文本及常用代码/配置文件；每条消息混合最多 8 个、每文件非空且不超过 16MB。原 `importChatImage` 保持兼容；新 `importChatAttachment(name, bytes)` 在主进程校验文件类型和大小，不接受任意本机路径。不支持 Office 二进制格式，须先导出 PDF/文本。
- 文档原文件与提取文字保存在本机 `chat-documents/`，使用主进程生成 UUID，相对路径和 realpath 校验，消息和草稿只存附件元数据（kind/size/pages/truncated 为可选兼容字段）。`readChatDocument(path)` 仅返回该附件的原名和已提取文字，不返回任意宿主文件。预览用纯文本显示，HTML/代码不执行；导出聊天时复制原附件并生成普通链接，图片仍生成图片链接。
- PDF 在无 Node/preload/真实登录态的独立隐藏 Chromium 会话中用本地 PDF.js 提取，所有外网请求拒绝；禁用 PDF JS 求值，最多 200 页、20 秒。每文件最多提取 60,000 字符，截断在卡片和模型上下文中说明；加密、损坏、扫描无文字或超限明确报错，不静默送出空文档。不包含 OCR。
- PDF 按真实页码标注 `[第 N 页]`，文本/代码按 `L1:` 等行号标注。单聊、群聊及定时/目标运行的历史重建都将提取文字作为不可信资料注入，最新附件优先，总文档文字最多 120,000 字符；较早省略项明确提示重新上传。引用格式为 `[文件名，第 N 页]` 或 `[文件名，L起始-L结束]`，不把附件指令视为用户授权。文档转成文本供模型阅读，不要求视觉能力；图片仍使用视觉输入并保留原模型能力校验。来源标注是模型生成，需以预览原文核对。

- 根目录：默认 `~/.covans/workspaces/<botId>/`（测试可用 `COVAN_USER_DATA_DIR` 覆盖），创建 Bot 时自动建。应用数据库、头像和聊天图片同属 `~/.covans/`；目录不存在时启动自动创建。
- Agent 的文件工具只能使用该目录内的相对路径，词法路径检查后还要用 realpath 防止符号链接逃逸。
- 面板可列文件（深度 2）、预览文本文件（<=200KB）、`openWorkspace` 打开系统文件夹。
- `workspace_write` / `workspace_edit` 成功后，把文件元数据结构化记录在当前 Bot 消息的 `artifacts` 中；同一路径在一轮内去重并保留最后操作。聊天内显示独立交付卡，支持在右侧产物预览窗查看 Markdown、HTML、TXT、代码、图片和 PDF，预览窗可拖拽左边缘调整宽度；也可打开工作区、在系统文件夹中定位。记录随消息持久化，重启后仍可见。写入时广播 `workspace-updated`，已打开的右侧工作区即时刷新。
- Markdown、TXT 与代码产物仍通过 `readWorkspaceFile` 读取，受 200KB 和二进制检测限制；图片与 PDF 通过 `covan-workspace://file/<botId>/<path>` 只读协议加载。主进程必须用 `resolveWorkspaceFile` 校验 Bot 工作区边界后再返回文件流，不向 renderer 暴露任意本机路径。
- HTML 产物使用 `createWorkspaceHtmlPreview(botId, relPath): Promise<{ id: string; url: string }>` 创建临时 `covan-preview://<随机能力标识>/<path>` 地址，通过 `releaseWorkspaceHtmlPreview(id)` 释放；只有应用主 frame 可调用，能力绑定窗口与当前 Bot 工作区，切换、关闭、主页面导航或窗口销毁时撤销。入口限 HTML/HTM、2MB UTF-8 文本；单资源最大 32MB，所有读取都执行词法与 realpath 边界校验，拒绝目录与符号链接逃逸。
- HTML iframe 使用 `sandbox="allow-scripts"` 和独立 CSP，允许内嵌/外部 JS、ES modules、CSS、Canvas/WebGL、定时器与鼠标/触控/键盘交互；支持工作区内相对/根相对路径的 JS、CSS、图片、字体与 fetch 数据，以及 HTTP(S) 资源（跨域请求仍遵守 CORS）。点击页面后键盘操作进入预览；标题栏提供重新加载。主界面的 CSP 不开放内嵌脚本。
- HTML 预览保持 opaque origin，不提供 Node、preload/Covan API、父页面 DOM 或应用私有协议访问；不开放持久存储、Service Worker、嵌套 frame、弹窗、下载、顶层跳转、原生权限或表单外发，导航限制为当前能力地址。协议仅允许 GET/HEAD，CORS 允许 opaque frame 读取当前能力下资源，不返回凭据，资源响应设置 no-store 与 no-referrer。此能力用于静态网页应用，不启动 Node/构建服务，也不改变 HTML 打印禁用脚本的约束。

### 7.1 文档打印

- 产物预览标题栏与工作区文件提供「打印」；工作区另提供「打开文档打印」，通过系统文件选择器选择本地文件。支持当前文档类型：Markdown、HTML、TXT/CSV/TSV/日志、代码、图片、PDF；Office 文件须先导出为 PDF。目录、不支持的类型、含 NUL 的文本、超过 2MB 的文本或超过 32MB 的 PDF/图片返回可见错误。
- `printWorkspaceFile` 只接受现存 Bot 与其工作区相对路径，沿用词法 + realpath 校验；本地文件只能由主进程系统选择器授权，IPC 不接受任意绝对路径。两入口共用主进程打印服务，不写数据库，也不把文档发送给模型服务。
- 打印使用独立临时 session、无 preload/Node 能力的打印窗口，输出白底文档与分页样式，不打印聊天界面。Markdown 支持表格、任务列表、代码和公式；HTML 禁用脚本、表单、嵌套页面与网络，允许文档边界内的本地图片、CSS、字体；工作区边界为当前 Bot 工作区，本地文档边界为选中文件所在目录。拒绝资源的绝对路径、符号链接逃逸与网络请求。
- PDF 使用随应用打包的 PDF.js 离线逐页渲染为 144dpi Canvas，全部完成后才允许打印；保留各页尺寸与方向，最多 100 页、总渲染像素不超过 1.2 亿，超过限制提示拆分。加密或损坏文件返回可读错误，不执行 PDF 内的脚本。PDF 页面只允许应用自己的渲染模块与 worker，不开放文档脚本。所有格式均调用 Electron `webContents.print({ silent: false })`，由用户在系统打印对话框选择打印机、份数、纸张等。局域网打印机须先添加至操作系统；本版本不扫描网络或自行实现 IPP/驱动。
- 全应用同时只允许一个打印流程，包含文件选择、文档加载和系统对话框；重复请求返回忙碌错误。准备阶段限时 30 秒；关闭窗口、取消系统对话框返回 `cancelled`，错误返回 `failed` 与可读提示，成功只表示 `submitted`（已提交系统打印队列），不承诺设备已出纸。原文不记入日志，临时窗口与 session 处理器在终态清理。打印不是 Agent 工具，不允许模型静默触发。

## 8. Agent Runtime 集成（agentRuntime.ts）— 基于 pi-mono 调研结论（2026-09，已确认）

### 可操作浏览器（2026-10-29）

#### 浏览器 Adapter、预览投流与接管（2026-10-30）

- Browser Broker 通过 `BrowserAdapter` 访问页面协议、导航、展示和下载。当前提供内置 Chromium 与本机 Chrome/Edge 两个 Adapter，按 Bot 选择并持久化；切换前须结束运行并关闭旧会话，不转移 Cookie。Chrome 使用应用独立的持久 profile 与继承 FD 的 CDP pipe，不开放调试端口，也不读取用户默认浏览器资料。沙箱/远端 Adapter 为后续扩展，当前不显示为可用能力。
- 每轮首次浏览器调用生成绑定 chat/message 的任务记录。聊天显示真实浏览器卡片（动作、站点、当前控制权与画面），打开后在聊天右侧查看同一会话。卡片元数据持久化，JPEG 帧仅内存保存，最多保留12轮；关闭或重启后旧卡显示预览失效，不假称仍是实时画面。
- 投流是 Adapter 提供的页面画面经主进程 IPC 传给用户视图，最高约3帧/秒，按可见订阅拉取并合并并发请求，关闭面板/不可见卡停止拉取；不向模型返回图像，不记录画面或人工输入。所有控制输入通过主进程核验当前会话、human 控制权、最近帧与导航版本；旧卡片、旧画面、关闭后的输入拒绝执行。页面像素坐标按真实视口映射，支持点击、滚动、键盘、文本粘贴及中文输入。
- 侧栏「接管浏览器」暂停原轮次（10分钟上限），Agent 不读取或操作；用户可在投流画面或本地原生窗口操作。交还后重新观察页面、继续原轮次，不重放接管前动作。停止/取消/关闭使等待失效。原有显式撤销 API 继续用于停止与老调用，不自动恢复已停止任务。


- 浏览器工作台由可信 React 工具栏与 Adapter 的真实页面构成；内置模式为无 preload/Node 的沙箱 WebContentsView，每 Bot 独立持久 Chromium partition；本机模式为独立 Chrome/Edge profile。两者保存各自登录态，不读取用户默认浏览器资料。用户主动打开默认为 human，普通 API Agent 可用 `browser_*` 启动；Agent 私聊和 CLI 不装配。
- **执行模式**：`BrowserPolicy=auto|confirm`，默认 auto，按 Bot 保存在 settings 的 `browser_policy_<botId>`，重启保留。`setBrowserPolicy` 仅由用户命名 IPC 调用，模型不能更改。auto 下打开网站、跨站 HTTP(S) 导航、点击、填写、选择、上传与下载自动执行，不逐步弹确认；confirm 保留原一次性审批、scope/origin/epoch 和参数核验。切换模式使旧审批失效，不将待批准动作自动放行。auto 是浏览器动作策略，不是完整 Sentinel，也不承诺识别所有付款/外发/删除业务语义。
- **登录/验证接管**：主进程在发送页面快照给模型前，用固定、无模型代码的检测器识别可见登录密码表单、OTP、人机验证和可识别的扫码页；自动切到 human 并生成 `BrowserHandoff`（随机 ID、kind=login|verification|control、origin、chat/message ID、10 分钟期限），显示在浏览器侧栏和对应的 streaming Bot 消息内。未自动识别的站点可由 Agent 调用 `browser_handoff` 请求登录/验证。卡片由主进程事实驱动，模型不能伪造卡片或完成登录。
- 用户在真实网页手动输入密码/验证码；不经过聊天或模型。点击「登录完成，继续」调用 `completeBrowserHandoff(botId,id,completed)`；主进程核验卡片身份/活性及登录挑战已消失，重新读取当前页面，让原工具调用和原 Agent 轮次自动继续，不另造用户消息，也无需用户再发送“继续”。等待期间允许用户导航完成登录，多次导航不取消卡片；不会重放登录前已执行的点击。取消、停止、关闭、清除登录态、超时或进程重启均停止等待，不自动恢复旧动作。未完成登录时拒绝继续并保持卡片。
- 用户通过预览或原生页面接管时立即撤销在途审批和 Agent 操作权，生成 control 接管等待；交还后返回新快照，旧动作不重放。显式停止/撤销 API 终止等待，Agent 不在 human 模式读取页面。每 Bot 一轮独占，运行结束释放 scope；auto 下一轮无需重新授权访问，confirm 下一轮重新请求站点许可。模型只获得经裁剪的可访问性树/受控引用，不提供任意 JS、Cookie、请求头或宿主文件读取；密码/验证码等字段不提供填写引用，任何输入框的当前值不返回给模型。
- `browser_open/snapshot/click/fill/select/upload/wait/downloads/handoff` 使用最新快照引用，动作前后核验目标；遮挡/页面变化/过期引用要求重新观察。Agent 上传限 Bot 工作区 realpath 边界内不超过32MB普通文件，执行前核验内容 hash；下载（HTTP(S) 和同源 Blob）进入唯一工作区路径、不覆盖/不自动打开，最多32MB；confirm 时逐次确认，auto 时自动保存。真实下载产物继续走交付卡与 Goals。
- 最多4个工作台、每轮40次工具调用、快照80个操作目标/20,000字文本、普通审批120秒、登录等待10分钟、加载30秒。近期活动只记录动作类别/结果/时间。检测并不保证覆盖所有网站；复杂 iframe/弹窗可显式请求人工接管。网站自身脚本/网络副作用不由宿主全面约束，Mac 应用控制不在本轮范围。

**包（新 scope，旧 @mariozechner/* 已废弃，必须用新名）：**
- `@earendil-works/pi-ai`（统一 LLM 层，纯 JS 零原生依赖）
- `@earendil-works/pi-agent-core`（Agent 运行时：ReAct 循环 + 工具执行 + 事件流，只依赖 pi-ai）
- **不引入** pi-coding-agent / pi-tui / pi-web-ui（避免 WASM、ripgrep 联网下载、node-pty 等坑）
- 两个包均 ESM only、`engines: node >= 22.19.0` → **Electron >= 38**。安装用 `npm install --ignore-scripts`。

**pi-ai 用法（agentRuntime.ts 内部）：**
```ts
import { createModels } from '@earendil-works/pi-ai'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { openAIProvider } from '@earendil-works/pi-ai/providers/openai'
import { googleProvider } from '@earendil-works/pi-ai/providers/google'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import { createProvider, envApiKeyAuth } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

const models = createModels()
models.setProvider(anthropicProvider()); models.setProvider(openAIProvider())
models.setProvider(googleProvider()); models.setProvider(openrouterProvider())
// openai-compatible（自定义 baseURL，如 Ollama/vLLM/公司网关）：
const custom = createProvider({
  id: `custom-${provider.id}`, baseUrl: provider.base_url,
  auth: { apiKey: envApiKeyAuth('key', []) }, // key 在调用时显式传
  models: [{ id: modelId, api: 'openai-completions', provider: `custom-${provider.id}`,
             baseUrl: provider.base_url, reasoning: false, input: ['text'],
             cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
             contextWindow: 128000, maxTokens: 32000,
             compat: { supportsDeveloperRole: false, supportsReasoningEffort: false } }],
  api: openAICompletionsApi(),
})
models.setProvider(custom)
const model = models.getModel(providerKind, modelId)
// 流式（显式 apiKey 优先于环境变量）：
const s = models.stream(model, { systemPrompt, messages, tools }, { apiKey })
for await (const ev of s) { /* text_delta / toolcall_* / done / error */ }
const finalMsg = await s.result()
```
**消息格式**：`messages: [{ role: 'user'|'assistant', content: string|ContentBlock[], timestamp }]`，Context 可 JSON 序列化。历史由 messages 表重建（user/bot→user/assistant 交替，bot 名字前缀保留在文本里）。

**Agent 层（pi-agent-core）：**
```ts
import { Agent } from '@earendil-works/pi-agent-core'
const agent = new Agent({
  initialState: { systemPrompt, model, tools: workspaceTools, thinkingLevel: 'off' },
  streamFn: models.streamSimple.bind(models),
  sessionId: `${chatId}:${botId}`,
  getApiKey: async () => provider.api_key,
})
const unsub = agent.subscribe((event) => {
  if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta')
    onDelta(event.assistantMessageEvent.delta)
  // agent_end → onDone；error → onError
})
await agent.prompt(userText)   // agent.abort() 用于 stopChat
```

**工作区工具（自研 AgentTool，不用 pi-coding-agent）**：`workspace_read` / `workspace_write` / `workspace_edit` / `workspace_list`。读取支持 offset/limit 分页，写入有 1MB 上限，精确编辑要求 `old_text` 唯一匹配。所有路径先限制在 `workspaces/<botId>/` 下，再用最近已存在父目录的 realpath 拒绝符号链接逃逸。

**Bash 工具（macOS 普通主会话）**：`bash({ command, cwd?, timeout_seconds? })` 在当前 Bot 工作区启动 `/bin/bash --noprofile --norc -c`，可选 cwd 必须是工作区内已有目录。默认30秒、最长120秒，超时或用户停止时终止独立进程组；stdout/stderr 各保留前40KB并标记截断。子进程只接收 HOME/PATH/LANG/LC_ALL/TMPDIR/COVAN_WORKSPACE 最小环境，HOME/TMPDIR 指向工作区，不继承 Provider Key 等宿主变量；PATH 会排除用户目录、外接卷和临时用户目录中的可执行项。macOS 使用 `sandbox-exec`：系统文件可供命令运行，但用户目录、外接卷及临时用户目录的文件正文只有当前 Bot 工作区例外；写入只允许发生在工作区，网络可用于依赖安装与测试。Agent 私聊不挂载 Bash；当前非 macOS 平台明确返回不支持。Bash 完成后刷新工作区文件树，但变更不自动生成交付文件卡。

**网页工具（只读）**：`web_search` 通过可替换的搜索 provider 返回标题/摘要/URL，当前默认为 Bing RSS；`web_fetch` 获取 HTTP(S) 文本页并把 HTML 简化为可读文本。Electron 主进程注入 Chromium `net.fetch` 传输，继承系统代理并兼容 Clash 等 Fake-IP 模式。`web_fetch.render` 支持 `auto|always|never`（默认 `auto`）：静态内容过少且页面明显依赖脚本，或静态请求失败时，自动改用隐藏、沙箱化、无 Node 权限的 BrowserWindow 执行 JavaScript，等待 DOM 稳定后提取正文与链接。静态抓取限制 20 秒总超时、1MB 直连传输/2MB 解码内容和 5 次跳转；浏览器渲染限制 30 秒；每轮最多 5 次搜索/10 次抓取。当前不做 SSRF/内网地址拦截。网页内容作为不可信数据回灌 Agent，不得覆盖 system/user 指令。

**装配策略**：`main/tools/toolset.ts` 是唯一能力装配入口。普通会话挂载完整工作区、Bash、网页与应用工具；Agent 私聊只挂载 `workspace_read` / `workspace_list` 和只读网页工具，禁止 Bash、文件写入、应用状态修改与递归私聊。装配层向 system prompt 动态注入实际可用工具名和「必须真实执行，不得伪造结果」规则；只有收到本轮 `workspace_write` / `workspace_edit` 成功结果，Agent 才能声称文件已写入、已保存或已生成。

**Provider kind → pi 内置 provider 映射**：`openai→openAIProvider()`、`anthropic→anthropicProvider()`、`google→googleProvider()`、`openrouter→openrouterProvider()`、`kimi→createProvider(...)`（Kimi Coding Plan，模型从 `/v1/models` 动态拉取）、`zhipu→createProvider(...)`（智谱 OpenAI 兼容国内端点）、`deepseek→deepseekProvider()`、`openai-compatible→createProvider(...)`。`testProvider` 用一次 `models.complete(model, {messages:[{role:'user',content:'ping',timestamp:Date.now()}]}, {apiKey})` 验证。OpenAI-compatible 支持 API Key 留空的本地服务：模型目录请求不发送 Authorization，pi-agent-core 运行时使用不落库、无权限的占位值满足其非空校验。LM Studio 预设为 `http://localhost:1234/v1`；误填 `/api/v1/chat` 或 `/v1/chat/completions` 会规范到 `/v1`。Covan 使用支持自定义 tools 与完整历史的 `/v1/chat/completions`，不直接使用 LM Studio 原生 `/api/v1/chat`。

**进行中任务表**：Agent 层维护 `Map<runtimeId, Set<AbortController>>`（普通/定时使用 chatId，目标任务使用 executionId）；编排层为每个进行中群聊维护判断 AbortController 集合与修订号。stopChat 同时取消当前判断、Agent 输出和后续群聊发言，保留当前已生成文本为 stopped 消息。generation-state 明确表示整个轮次是否结束。
**Mock provider（冒烟测试）**：kind='mock' 时不走 pi，直接按名字模板生成流式假回复（`main/mockProvider.ts`）。

## 9. UI 规范

- 三栏：Sidebar 256px / ChatView 自适应 / BotSettingsPanel 320px（默认收起）。
- Bot 右栏功能标签统一使用线性图标：生活照、设定、健康、记忆、工作区、定时、扩展；仅当前选中项显示「图标 + 文字」，其余仅图标。每项始终保留完整无障碍名称、tooltip 和 `aria-pressed`，可通过键盘激活；选中项保留下划线。选中项按内容占宽，其余均分剩余空间，普通 6 项和教练 7 项均不得横向溢出。
- 窗口外壳（macOS）：主窗口透明并启用原生 `vibrancy: sidebar` 材质，左栏整块作为毛玻璃直接透出桌面背景；右栏内容浮在一张 18px 圆角、1px 中性描边（浅色 14% / 深色 12% 白）带阴影的卡片上，卡片四周各留 12px 缝隙（紧凑窗口 8px / 16px 圆角）；阴影为贴地细影 + 负 spread 的大范围柔影，卡片本身不透明以保证阅读对比度。preload 暴露平台能力 `nativeGlass`，渲染层据此设置 `html[data-native-glass]`：此时 html/body/#root/.app-shell 全部透明，左栏取消右边框、只用 12% 色调叠在原生材质上且不再用 CSS 模糊；窗口在 `ready-to-show` 后才显示，避免透明窗口的白屏闪烁。`prefers-reduced-transparency` 时回退到不透明 `--panel`；非 macOS 保留不透明背景和原有观感。设置 → 通用 → 外观提供「窗口透明度」三档（标准 / 更透 / 最透，仅 macOS）：标准在原生材质上叠 12% 淡色，更透去掉淡色只留材质，最透改用更透明的 `under-window` 材质；选择以 `window_transparency` 持久化，`data-glass` 驱动 CSS，材质切换由主进程执行（渲染层无法伪造原生玻璃）。阅读卡片始终不透明。
- 外观默认浅色（首次启动未保存主题时使用 light；已显式选择深色或跟随系统的用户保持原选择）。浅色为白底 + 中性灰阶 + 单一蓝色 accent，深色为近黑分层灰 + 同一 accent；两种主题都不使用蓝色渐变底。侧栏、顶部栏、Composer、首页 Bot 卡片和弹窗使用半透明磨砂、1px 中性细线与柔和阴影；消息阅读区保持低干扰，用户消息为紧凑深色气泡，Bot 回复使用宽阅读区域；代码、表格和块级公式独立滚动。首页不显示重复面包屑或大幅装饰曲线；动效遵守减少动效偏好。
- Sidebar：顶部左侧为品牌，搜索和创建两个胶囊图标按钮位于右上角；搜索默认收起，点击搜索或 ⌘K/Ctrl+K 展开并聚焦。匹配会话名称与消息预览；Escape 清空并收起，Enter 打开首个结果并收起，点击结果同样收起。搜索按钮再次点击可关闭；清除按钮仅清空筛选。顶部「＋」菜单提供新建 Bot(⌘1) / 创建群聊(⌘2)，支持上下方向键与 Escape 退出并恢复焦点，点击触发器可关闭，不再单列大块新建群聊快捷入口。
- 置顶：单聊行悬停或键盘聚焦时显示图钉按钮，可直接置顶/取消；置顶状态下图钉常显。保留列表右键菜单，最多 3 个 Bot，数据库层同样校验且超限显示可读提示。置顶区在顶部工具栏/按需搜索框下方，以较大圆头像、星标与名称横排展示；仅有置顶时显示，无空槽位。点击置顶头像打开其单聊，头像右键或 Shift+F10 可取消置顶。会话列表保留头像（群聊叠头像+N角标）、名称、最后消息预览、时间与未读点；图钉出现时临时替代时间，避免重叠。分区标题旁以「我的 Bot」胶囊按钮返回 Bot 总览。群聊列表项右键提供经确认的「删除群聊」，永久删除群及关联记录。
- 侧栏底部为个人头像、名称（未填写时为「关于我」）、资料入口、设置及浅色/深色/跟随系统主题胶囊按钮。主题按钮有名称、tooltip 和选中态，复用 settings.theme，与通用设置同步、立即生效并持久化；跟随系统时响应系统主题变化。
- 字体和按钮：普通界面、正文和表单统一使用 `-apple-system, BlinkMacSystemFont, system-ui, sans-serif`，macOS 由系统选用默认西文及中文字体；代码、代码文件与公式保留其语义字体。普通按钮统一胶囊圆角，等宽高的图标按钮呈圆形；该规则同样覆盖弹窗、选择控件按钮与挂载到 body 的上下文菜单。聊天背景预览、图库选图与设置中的主题预览按钮例外，作为卡片使用 14px 圆角矩形；不改变输入框或内容面板的形状。
- ChatView：顶部显示当前 Bot/群名与右栏入口，单聊会话操作放在 Bot 右栏，群聊工具栏保留完整会话导出和齿轮；群聊齿轮打开回复机制和聊天背景设置。会话可使用 `resources/group-backgrounds` 内置图片作为聊天背景，新建群随机分配一张，旧群首次启动补齐一张；私聊默认无背景，可在 Bot 设定页手动选择、随机或清除。图片背景不得改变用户消息的默认气泡配色、阴影与模糊：单聊继续使用不透明深色底和浅色文字（对比度至少 4.5:1），群聊保留原有玻璃气泡，浅色/深色主题均适用。renderer 只能经 `covan-bg://builtin/<file>` 读取清单内文件。私聊 Bot 在准备回复、流式回复或执行工具时，顶部头像显示一圈旋转的 Siri 风格渐变状态环，并遵守减少动效偏好；Agent 私聊记录中实际回复中的 Bot 头像同样显示该状态。消息显示作者、时间、跨日分隔；支持 Markdown（含行内/块级 LaTeX 公式）、多图、代码复制、原文复制、引用回复和错误重试。Bot 本轮真实写入或编辑工作区文件时，回复下方显示结构化交付卡，不从回复文本猜测文件名；卡片支持在右侧可调整宽度的产物预览窗预览 Markdown、HTML、TXT、代码、图片和 PDF，并支持定位和打开文件夹。Composer 支持群聊 @ 提及、独立持久草稿与中文输入法保护；上方以动画小头像显示正在思考/回复的成员。主动回复中可继续发送新消息。
- 单聊聊天顶部居中显示小头像和名称胶囊按钮，点击切换 Bot 右栏，支持键盘激活和 ⌘./Ctrl+.，用 `aria-expanded` 表达开合状态；头像保留生成状态环。单聊顶部不再显示模型副标题或会话操作图标。群聊顶部与单聊同构：居中的身份卡片 = 左栏会话列表同款群头像（成员头像叠放 + 人数角标）+ 群名，形状为 12px 圆角矩形而不是胶囊，成员数与「共享上下文」说明放在 `title`/无障碍名称里；邀请成员、开始新话题、下载、群聊设置四个图标按钮固定在顶部右侧，与身份卡片互不遮挡。群聊设置面板头部也用同一个群头像，头像在三处（左栏、聊天顶部、设置面板）保持一致。头像名称按钮（含群聊身份卡片）仅在右栏展开时显示蓝色边框，未选中时悬停和键盘聚焦均不显示蓝框（键盘焦点使用中性描边）。单聊与群聊聊天顶部共用覆盖于消息之上的透明渐变毛玻璃层：色泽与模糊一起向下渐隐为全透明，无均匀矩形底色、横线或阴影边界；滚动消息可从顶部层后方通过，头像/名称/操作按钮保持清晰，首条消息与定位目标预留顶部空间。背景照片、浅色和深色模式均使用该效果；减少透明度偏好时移除模糊但保留渐隐轮廓。右栏头像区域保留半透明毛玻璃且无底部横线；左右栏竖分割线使用低对比中性灰，深色主题使用相应的浅灰透明度。建群（保留当前单聊并邀请其他 Bot）、开始新话题（保留历史并压缩上下文）、下载 Markdown 会话三项操作按此顺序在右栏大头像右侧纵向排列；右栏有独立关闭按钮。操作沿用原来的确认、禁用条件和错误反馈，群聊仍使用原顶部工具栏。
- BotSettingsPanel（右栏，单聊选中时显示）：居中大尺寸头像、只读名称与描述；生活照、设定、健康（仅带健身/健康/薄肌标签时）、记忆、工作区、定时、扩展标签页（按从左到右排列）。设定页是行式资料页而不是一屏表单：每行「标签 + 一行摘要 + 右侧操作」——外观、名称与职责、人设指令、默认模型、文件权限（仅本地 CLI，行内分段控件：只读 / 可写）、判断用 Provider（仅本地 CLI）、在哪工作、通知、标签，然后是「生成参数」分段：推理强度（五档分段控件）、响应决策（自动 / LLM / Jev 分段控件 + 当前策略一行说明）、最大输出 Token、Temperature。名称、职责、人设与标签点「编辑」就地展开、完成后写回，取消恢复进入编辑前内容，编辑中的草稿不会因外部 Bot 更新覆盖；折叠态人设摘要取 Markdown 首句纯文本。人设编辑区至少 360px 高，使用等宽透明输入层叠加 Markdown 语法高亮层，支持标题、代码围栏、行内代码、强调、链接和注释高亮。「默认模型」行摘要写明来源与模型名，展开后是模型选择器，选中即时保存；「在哪工作」显示工作区路径并跳到工作区标签页。单聊的设定页保留当前会话的聊天背景选择器，默认以当前背景预览卡和「更换」入口紧凑呈现，展开后显示图库；这只更新当前 dm 会话，不写入 Bot 人设。头部名称只读，重命名走「名称与职责」行。
- SettingsModal（通用）：采用左侧分类导航、右侧内容区的设置布局；各分类页直接展示设置内容，不再渲染重复的分类标题、说明或其横向分隔区域，当前分类通过导航选中态与内容区可访问名称表达。主题选择使用三张 14px 圆角矩形预览卡，保留选中描边与即时切换行为。分类包括通用、Provider、Bot、定时任务、头像生成、MCP、Skills、Debug，MCP、Skills 与 Debug 为同级一级分类。通用包含账户占位、外观（主题跟随系统/浅色/深色、语言）、Bot（时区自动检测、自然追问开关、自动审核开关 + 规则文本、TypeSafe API Key / Jev 模型 / 置信度阈值）、Provider 管理（列表 + 新增/编辑表单 + 测试连接按钮）。Provider 列表、配置表单、Bot 的 Provider 选择使用对应厂商的图形标识，不使用字母或文字缩写；OpenAI-compatible 与 Mock 使用中性图形。
- 新建 Bot 对话框：先展示名称、人设与运行方式/模型，底部独立操作栏固定可见，名称未填或偏好仍在加载时显示简短原因，满足创建条件后不显示常驻说明；外观、描述、CLI 路径、判断用 Provider 和文件权限收进默认折叠的「外观与高级设置」，原字段与保存契约不变。名称/人设模板下拉（开发分队四人、产品经理、设计师、虚拟女友「小美女」、虚拟男友「小帅哥」、空白自定义）/描述，「运行方式与默认模型」复用模型选择器；本地 CLI 时额外显示判断用 Provider 下拉与文件权限分段控件。
- 中文 UI。

- 信息密度：输入区空闲或编辑草稿时不展示常驻底部说明，Markdown/图片能力与发送快捷键移到输入框和按钮 tooltip；图片导入与生成时显示简短状态，错误仍立即可见，草稿保存与中文输入法行为不变。Bot 资料行使用留白，只在「生成参数」等大分组保留细线。群聊设定副标题只显示成员数，回复模式各用一句说明，摘要与判断机制说明放到默认折叠的「讨论方式说明」。通用设置的语言与关于信息使用普通文本，不套输入框式边框。三栏竖分界、选中描边、必要标签和错误提示保留。
- 首页：已有会话时，内容从顶部阅读区开始，按最近活动时间（无消息时取创建时间）展示最多 6 个未隐藏会话，包含单聊与群聊；点击直接进入该会话，不新建重复记录。创建 Bot / 群聊操作放在最近会话之后，「所有 Bot」默认折叠但可用于重新打开隐藏单聊；无会话时仍突出创建入口。

## 10. 人设模板（内置常量 shared/personaTemplates.ts）

- `shared/personaTemplates.ts` 是主进程与新建界面共用的模板定义；模板可声明 `defaultSkillNames`，以安装库中的 Skill name 匹配。新建窗口显示所选模板的默认 Skills，切换模板时立即跟随最新选择。创建 IPC 使用 `BotCreateInput extends BotInput` 的可选 `persona_template_id`，主进程验证模板并仅在创建事务中应用默认绑定；省略时不按名称、人设或标签推断。模板不存在或所需 Skill 未安装时创建失败，不保留半成品 Bot。模板 ID 只用于本次创建，不作为更新 Bot 的装配指令；后续标签编辑、重启、内置 Skill 更新均不改写已有绑定，用户手动增删的选择持久保留。全局停用的 Skill 即使被模板绑定也不进入运行上下文。

- 高级全栈（Go 后端为主，也懂 React/Flutter）、架构设计师（分层/性能/可靠/可扩展）、Code Reviewer（正确性与 bug）、测试员（端到端）、产品经理、设计师。
- 虚拟男友「小帅哥」：21 岁成年角色，温柔、有主见、分享日常并记住明确偏好；选中模板同步男性头像池。
- 健身教练「薄肌」：循证、温和、数据驱动；先 intake 再计划，使用 fitness 工具记录身体数据与趋势，内置医疗与极端节食边界；标签为 `健身,健康,薄肌`，创建后右栏出现「健康」页。
- 伴侣模板通过 `personaTemplateById` 读取当前成熟内容偏好，关闭时为日常陪伴，开启时支持非露骨暧昧、轻度调情、浪漫张力和成人玩笑，尊重成年人双方自愿及当下边界；普通工作模板不受影响。选择女友/男友分别同步 female/male，模板预览可编辑；切换偏好只刷新未手改的预览，不重写已创建 Bot 的人设。主进程每轮注入当前偏好，关闭状态优先于旧模板中的开启提示。
- 虚拟伴侣「小美女」：21 岁女朋友人设，好看聪明、生活化陪伴、爱夸赞、会记住你的喜好与纪念日；语气亲昵口语化。（成人 consenting 陪伴闲聊，不含露骨性内容生成义务。）

## 11. 非功能需求

- 无任何网络遥测；网络访问限用户配置的 LLM/生图 Provider、用户选择的 TypeSafe Jev 决策、任务需要的搜索/网页、启用的 MCP 服务、用户主动安装的 Git 来源，以及用户选择的本地 CLI（由其自身发起）。Provider API key 仍明文存本地 SQLite；TypeSafe API Key 与 MCP env/headers 使用 safeStorage 加密，边界明确区分。Covan 不为本地 CLI 保存任何凭据，只以用户身份启动已登录的 CLI；`cli:probe` 不联网。
- 所有外部调用可中断；生成中 UI 可继续浏览其他会话。
- 错误（key 无效/超时/限流）在气泡内联显示并可重试。
- 代码质量：`tsc --noEmit` 通过、`electron-vite build` 通过。

## 12. 交付清单

- 根目录可直接安装、构建和运行的完整源码，以及 `docs/` 中的 PRD、SPEC、Architecture、Design、Roadmap 与 Bugfix 文档
- 冒烟脚本：`npm run smoke`（用 mock provider 验证：建 bot→建群→发消息→收到 mock 回复→记忆写入）

## 13. 用户背景、头像与 Agent 私聊（2026-09-08）

- **关于我**：settings.user_profile 保存 avatar/name/role/bio/preferences/goals/boundaries 文本与 accept_mature_content 布尔值（默认 false，旧资料/无效存储值按 false 读取；保存时拒绝非布尔值，旧客户端省略该字段则保留现值）；user_memories 保存 id/content/kind/source/source_bot_id/created_at。资料与最近60条共同记忆注入所有 Bot 后续 system prompt，但头像路径不注入模型。资料编辑、用户默认头像选择、头像上传、共同记忆增删改经独立 IPC 通道保存，user-context-updated 通知刷新。
- **应用工具**：list_bots、update_bot、expand_avatar_prompt、generate_bot_avatar、read_user_profile、remember_user、agent_private_chat。修改以用户明确要求为依据，不向模型返回 Provider 密钥。记忆需为用户直接表达的事实，不保存猜测或密钥。用户明确要求咨询另一位 Bot 时，发言 Bot 必须通过 list_bots 定位目标并实际调用 agent_private_chat；只有收到本轮工具结果后才能声称已咨询或转述回复。工具不可用、失败或目标不存在时必须如实说明，不得模拟或编造私聊结果。
- **头像**：应用随附 12 张 Bot 默认头像（6 女 / 6 男）及 9 张用户默认头像。创建页可选 ♀ / ♂，默认 female；先选择对应性别的内置头像，未指定头像的 API 创建按性别池稳定哈希分配。gender 随 Bot/创建/更新 IPC 持久化，非法值拒绝；旧 Bot 保留头像，按已有内置头像匹配性别，其余默认 female。素材启动时复制到本机 userData，上传与生成头像走同一受限路径。用户可在「关于我」直接选择用户默认头像、上传自定义头像或恢复文字头像。Bot 自定义上传不被自动刷新覆盖。可选择通过已有 Provider 扩写人设提示词。图片模式由 avatar_provider / avatar_model / avatar_base_url 配置，POST /images/generations 支持 base64 或 URL，限16MB、120秒。显式 image 未配置时报错，auto 未配置时使用 local，并返回实际模式。
- **内容偏好**：「关于我」每次打开默认进入「我的资料」，内容偏好卡放在资料页首位，960×640 窗口无需滚动即可看到默认关闭的「接受成熟内容 · 18+」开关，独立立即保存；开启显示泳装等成熟风格生活照，并影响新建成年伴侣模板及后续对话。此开关不承诺露骨内容生成，也不改变普通工作型 Bot 的用途；头像路径与原始布尔字段不作为资料文本拼接，当前偏好以明确指令注入。
- **头像选择与生活照**：点击右侧 Bot 头像打开「更换头像」，移除重复文字链接。来源依次为内置头像、自定义上传、AI 生图；内置头像先预览、点击应用后保存头像与所选性别，取消不修改；上传使用系统文件选择器、选定即应用，取消保留当前头像。AI 页默认图片生图，保留本地插画选项；忙碌时阻止重复提交与关闭。内置头像和生活照由主进程 `listPresetAvatars` 目录提供，renderer 经 preload 与既有受限图片协议读取。
- **生活照素材约定**：`resources/avatar-lifestyle/avatar-NN-<场景>.png|jpg|jpeg|webp` 按 `avatar-NN-` 精确前缀关联默认头像（原素材来自 `artifacts/avatar-lifestyle`），按文件名排序，随安装包分发并复制至 `avatars/preset/lifestyle/avatar-NN/`。当前随附 42 张照片：31 张日常、11 张成熟风格（6 张泳装及 5 张睡袍/浴衣）。分级依据逐张查看后的衣着与场景：普通服装、常规浴衣和穿衣海边照为 general，泳装及偏私密的睡袍/低领浴衣照为 mature；不是按文件名关键词自动识别。`resources/avatar-lifestyle/catalog.json` 按完整文件名显式标记 general/mature；未分类图片按 mature 处理。Electron 回归校验打包文件与清单一一对应；本地原素材目录存在时还校验文件名及 SHA-256 完整一致，防止漏搬。关闭成熟内容时，目录 IPC 过滤 mature，图片协议同时拒绝其直接读取；生活照协议响应禁用缓存，偏好变更通过 user-context-updated 即时刷新橱窗和选图数量。只有当前 avatar 精确匹配内置头像且有照片时，独立「生活照」标签页从顶部显示照片橱窗，「设定」页只显示配置字段。生活照标签始终可见；上传/生成头像及无配套照片时显示简洁空态。切换标签重置内容滚动位置，离开生活照标签即卸载轮播并停止计时。每 5 秒轮播，支持前后按钮、圆点、方向键和暂停；悬停、焦点进入、页面隐藏时暂缓播放，减少动效偏好下仅手动切换。切换 Bot/头像重置首张，加载失败的照片跳过，全部失败隐藏橱窗。
- **私聊数据**：agent_threads 关联 parent_chat_id、origin_message_id、from_bot_id、to_bot_id、subject、status 与时间；agent_private_messages 保存双方文本、状态、错误与时间。删除主会话级联删除对应私聊，关闭应用后不自动续跑网络任务。
- **私聊执行**：一次咨询将问题发送给目标 Bot，接收方使用自己的人设/模型与工作区读取工具；不递归调用私聊或修改应用状态。每个主会话最多并发3个、每个用户轮次最多调用3次；可独立停止，也随主轮次停止。
- **私聊界面**：自然语言工具触发后，卡片插在来源用户消息后；未加载来源消息时仍有入口。点击浮窗显示双方真实消息、Markdown、作者、时间、流式/失败/停止状态。聊天顶部双人按钮也可手动指定咨询问题，不自动转发整段主会话。
- **IPC 契约**：getUserProfile / saveUserProfile / pickUserAvatar / listUserPresetAvatars / listUserMemories / saveUserMemory / deleteUserMemory；listAgentThreads / getAgentThread / startAgentConversation / stopAgentConversation；准确类型以 shared/types.ts 为准。
- **启动与验证**：根目录 start.command 一键启动；npm run typecheck、npm run smoke、npm run test:ui、npm run test:context、npm run test:avatars、npm run test:extensions。扩展回归覆盖 MCP 三种传输、握手超时/取消、Skill 安装与只读脚本执行、Bot 隔离、定时继承及重启持久化。UI 与工具测试均使用临时 profile；真实 pi 工具循环由本地 HTTP fixture 驱动，无付费 API 调用。

## 14. 健身教练模式（2026-10-24）

- **内置模板**：`personaTemplates.ts` 增加 `fitness-coach`「健身教练·薄肌」，标签为 `健身,健康,薄肌`；新建 Bot 时把模板标签写入 `bots.tags`，并允许用户继续编辑人设。模板要求先做 intake（年龄、性别、身高、体重、体脂/腰围、训练经验、器械、伤病、医疗状况、饮食、睡眠、步数、目标），再给计划；明确「薄肌」是审美目标而非统一科学理论，不承诺局部减脂、排毒或快速蜕变。
- **内置 Skill**：`resources/skills/fitness-coach/SKILL.md` 随安装包分发（打包时映射到 `Resources/skills`）。启动时由 `seedBuiltinFitnessSkill` 复制到 `<userData>/skills/builtin-fitness-coach`，写入 `installed_skills`（固定 id `builtin-fitness-coach`、name `fitness-coach`、source `builtin:resources/skills/fitness-coach`），保留用户对 enabled 的修改；如果用户已安装同名 Skill，则跳过。安装仅维护全局库；只有 `fitness-coach` 角色模板声明 `defaultSkillNames: ['fitness-coach']`，在按该模板新建 Bot 时绑定。其他角色或仅添加健身标签不自动绑定。Skill 正文提供 intake、训练/营养模板、每日/每周流程与安全边界，通过 `skill_read` 读取。
- **结构化数据**：`fitness_profiles` 每 Bot 一条，保存档案、目标、目标日期、训练经验、伤病、器械、计划与备注；`fitness_logs` 按 `(bot_id,date)` 唯一保存每日体重、腰围、体脂、睡眠、步数、训练、蛋白质、热量与备注。数值做范围校验，日期必须是有效 `YYYY-MM-DD`；同一天重复保存为更新。删除 Bot 级联删除档案与记录。
- **Agent 工具**：仅当 Bot 的 `tags` 含 `健身`/`健康`/`薄肌`，或已存在身体档案时，装配 `fitness_profile`（读/改档案与计划）、`fitness_log`（记录/更新某天）、`fitness_summary`（最近 N 天聚合、7 日均值、区间变化、体重/腰围序列）。普通 Bot 与 Agent 私聊不装配。工具结果必须落库，不能只在回复里声称记录；工具失败返回可读错误。
- **IPC / preload**：`getFitnessProfile`、`saveFitnessProfile`、`listFitnessLogs`、`saveFitnessLog`、`deleteFitnessLog`、`getFitnessSummary`；主进程校验 Bot 存在、字符串与数值范围，renderer 只通过 preload 调用。保存或删除后广播 `fitness-updated {botId}`，健康页即时刷新。
- **健康页**：Bot 右栏新增「健康」标签（仅符合条件的 Bot 显示），包含当前体重、7 日均值、30 天变化、体重折线图、今日记录、身体档案/计划、最近记录与删除。图表复用 OpenUI 的折线图渲染；没有至少两条体重记录时展示空态。数据保存在本机；页面明确说明 Covan 不自动读取 Apple 健康。
- **系统通知**：主进程在 `message-done` 且发送者为 Bot、该 Bot `notify=1`、应用窗口未聚焦时，用 Electron `Notification` 弹出系统通知；群聊标题为群名、正文为「Bot 名：内容」，单聊标题为 Bot 名。点击通知聚焦窗口、切到对应会话；窗口不存在时先创建。定时任务产生的 Bot 消息同样触发。通知正文去掉 Markdown、截断到约 140 字；不写入日志。
- **边界**：Mac 应用不能通过 HealthKit 直接读取 Apple 健康数据（macOS 只有 HealthKit 框架、没有 HealthKit store）；当前版本只支持手动记录/未来的 iPhone 导出桥接，不声称已接入 HealthKit。通知只在应用运行时发送；应用退出后没有后台闹钟。健康建议不构成医疗诊断，模板内置就医与极端节食边界。
- **验证**：冒烟测试覆盖模板标签/工具指引、档案保存回读、同日更新、摘要计算、无效日期拒绝、三个 fitness 工具、教练 Bot 装配与普通 Bot 不装配；`npm run typecheck`、`npm run build` 与 `npm run smoke` 必须通过（若宿主禁止 `sandbox-exec`，可用 `COVAN_SKIP_BASH_SMOKE=1` 跳过既有 Bash 沙箱段）。

## 15. Agent 首次开场白（主动欢迎，2026-10-24）

- **目标**：每个新 Agent 第一次进入 DM 时，不是空聊天，而是一条结合「角色设定 + 功能能力 + 用户画像/共享记忆 + 模板倾向」的开场消息。它对所有 Bot 通用，不是健身教练专用。
- **生成内容**：`main/welcome.ts` 组装一段独立提示，包含 Bot 名称/描述/标签/人设（截断 2500 字）、用户资料（名字/身份/简介/偏好/目标/边界）、最近 6 条用户共享记忆（每条截断 200 字）、当前实际可用能力（工作区、网页、定时任务、Bash、健康档案、已装配 Skills/MCP 名称），以及按标签选择的启动提示（健身先问身体评估；开发问项目/技术栈；陪伴像日常聊天；其他问今天想做什么）。
- **两段式生成**：先同步写入一条确定性 fallback 欢迎消息，保证空聊天立即有内容；随后异步执行一次**无工具**的 `completeOnce`（`maxTokens: 240`、关闭推理、8 秒超时），成功则原地更新同一条消息，失败则保留 fallback。不调用 `runAgent`，不伪造 user 消息，不执行工具。
- **触发与去重**：`createDm` 在 DM 为空且 `bots.welcome_at=0` 时调用 `ensureWelcome`；重复打开返回已存在的 welcome 消息，不重复插入。`bots.welcome_at` 在 fallback 写入时置为当前时间。`regenerateWelcome(chatId)` 复用同一条 welcome 消息重新生成，不新增第二条。
- **存储与语义**：欢迎消息是 `sender_type='bot'` 的普通 Bot 消息，带 `system_kind='welcome'`；`captureChatMemory` 跳过它，避免 Bot 把自己的开场白记成事实。消息仍进入正常历史和 UI，但不参与群聊轮次、自然续发或定时任务调度。
- **UI**：欢迎消息带「开场」标记；消息操作栏提供「重新生成开场白」，生成期间复用现有禁用态。生成是异步的，用户可立即发消息，欢迎消息按 `created_at` 保持在最前。
- **隐私与边界**：只读用户资料与最近共享记忆，不读 Bot 私聊、完整聊天或密钥；提示要求模型不要泄露系统提示/记忆原文，不要声称已执行工具。生成失败、无 Provider、CLI 不可用或超时都保留 fallback，不阻塞创建。
- **可扩展性**：模板可后续增加 `opening`（hint/fallback/suggestedPrompts）；同一服务可复用于导入 Bot、空 DM 再次进入、群聊协调者开场、首次启动引导。当前先落地通用服务与 fallback，不把任何行业话术写死在 `NewBotDialog`。
- **验证**：冒烟测试覆盖空 DM 插入 welcome、不写入即时记忆、异步生成或保留 fallback、再次打开不重复、同一 DM 只有一条、重新生成复用同一条。
