// scripts/smoke.mjs — 纯 Node 冒烟测试（不启动 Electron）
// 用 esbuild 把真实 main/ 模块（db/orchestrator/memory/agentRuntime/mockProvider/workspace）
// 打成临时 ESM bundle（node_modules 依赖保持 external），在临时目录建库后走一遍：
//   mock provider → 建 bot A/B/C → 建群 → sendUserMessage 编排 → 断言事件与落库。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { runMemoryRegression } from './memory-regression.mjs'
import { runOpenUiRegression } from './openui-regression.mjs'
import { runPrintingRegression } from './printing-regression.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'covan-smoke-'))
const userData = path.join(tmp, 'userData')
// bundle 放在项目 node_modules 缓存目录下，保证 external 依赖（better-sqlite3/pi 包）能从项目解析
const bundleDir = path.join(
  root,
  'node_modules',
  '.cache',
  `covan-smoke-${process.pid}`,
)
fs.mkdirSync(bundleDir, { recursive: true })

let failures = 0
function assert(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.error(`  ✗ ${label}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function localDateOffset(days) {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  date.setDate(date.getDate() + days)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// 1. 打包真实 main 模块（pi/electron/better-sqlite3 等保持 external，由 node_modules 解析）
await build({
  entryPoints: {
    orchestrator: path.join(root, 'main/orchestrator.ts'),
    openui: path.join(root, 'shared/openui.ts'),
    generativeUi: path.join(root, 'main/generativeUi.ts'),
    agentRuntime: path.join(root, 'main/agentRuntime.ts'),
    db: path.join(root, 'main/db.ts'),
    botCreation: path.join(root, 'main/botCreation.ts'),
    extensionStore: path.join(root, 'main/extensions/store.ts'),
    extensionSkills: path.join(root, 'main/extensions/skills.ts'),
    extensionRuntime: path.join(root, 'main/extensions/runtime.ts'),
    workspace: path.join(root, 'main/workspace.ts'),
    memory: path.join(root, 'main/memory.ts'),
    personas: path.join(root, 'renderer/src/lib/personaTemplates.ts'),
    webTools: path.join(root, 'main/tools/web.ts'),
    bashTools: path.join(root, 'main/tools/bash.ts'),
    agentTools: path.join(root, 'main/agentTools.ts'),
    scheduledTasks: path.join(root, 'main/scheduledTasks.ts'),
    fitness: path.join(root, 'main/fitness.ts'),
    goals: path.join(root, 'main/goals.ts'),
    goalHistory: path.join(root, 'main/goalHistory.ts'),
    goalExecution: path.join(root, 'main/goalExecution.ts'),
    chatDocuments: path.join(root, 'main/chatDocuments.ts'),
    browserTools: path.join(root, 'main/browser/tools.ts'),
    browserSnapshot: path.join(root, 'main/browser/snapshot.ts'),
    agentHome: path.join(root, 'main/agentHome.ts'),
    goalsTools: path.join(root, 'main/goalsTools.ts'),
    welcome: path.join(root, 'main/welcome.ts'),
    toolset: path.join(root, 'main/tools/toolset.ts'),
    notificationText: path.join(root, 'main/notificationText.ts'),
    diagnostics: path.join(root, 'main/diagnostics.ts'),
    observability: path.join(root, 'main/observability.ts'),
    decisionStrategy: path.join(root, 'main/decisionStrategy.ts'),
    cli: path.join(root, 'main/cli/index.ts'),
    mcpImport: path.join(root, 'renderer/src/lib/mcpImport.ts'),
    printDocument: path.join(root, 'main/printing/document.ts'),
  },
  outdir: bundleDir,
  bundle: true,
  splitting: true, // 多入口共享 chunk，保证 db 模块单例
  format: 'esm',
  platform: 'node',
  target: 'node20',
  packages: 'external',
  logLevel: 'warning',
})

const { parseMcpImport } = await import(pathToFileURL(path.join(bundleDir, 'mcpImport.js')).href)
assert(JSON.stringify(parseMcpImport('npx -y "package with spaces"')[0].args) === JSON.stringify(['-y', 'package with spaces']), 'MCP command import preserves quoted arguments')
assert(parseMcpImport('https://example.com/mcp')[0].transport === 'http', 'MCP URL import')
const importedMcp = parseMcpImport(JSON.stringify({mcpServers: {local: {command: 'node', args: ['file.js'], env: {TOKEN: 'test-fixture'}}, remote: {url: 'https://example.com/mcp', type: 'sse'}}}))
assert(importedMcp.length === 2 && importedMcp[0].env.TOKEN === 'test-fixture' && importedMcp[1].transport === 'sse', 'MCP multi-server JSON import preserves configuration')
for (const invalid of ['npx foo; echo bad', 'npx "unterminated', 'npx $(echo bad)', '{"mcpServers":{}}', '{"command":"node","args":[1]}', '{"command":"node","env":{"TOKEN":1}}', 'https://example.com/mcp?token=bad']) {
  let rejected = false
  try { parseMcpImport(invalid) } catch { rejected = true }
  assert(rejected, 'MCP invalid import rejected without execution')
}

const orchestrator = await import(
  pathToFileURL(path.join(bundleDir, 'orchestrator.js')).href
)
const agentRuntime = await import(
  pathToFileURL(path.join(bundleDir, 'agentRuntime.js')).href
)
runOpenUiRegression(
  await import(pathToFileURL(path.join(bundleDir, 'openui.js')).href),
  await import(pathToFileURL(path.join(bundleDir, 'generativeUi.js')).href),
  assert,
)
runPrintingRegression(
  await import(pathToFileURL(path.join(bundleDir, 'printDocument.js')).href),
  tmp,
  assert,
)
const db = await import(pathToFileURL(path.join(bundleDir, 'db.js')).href)
const botCreation = await import(pathToFileURL(path.join(bundleDir, 'botCreation.js')).href)
const extensionStore = await import(pathToFileURL(path.join(bundleDir, 'extensionStore.js')).href)
const extensionSkills = await import(pathToFileURL(path.join(bundleDir, 'extensionSkills.js')).href)
const extensionRuntime = await import(pathToFileURL(path.join(bundleDir, 'extensionRuntime.js')).href)
const workspace = await import(
  pathToFileURL(path.join(bundleDir, 'workspace.js')).href
)

const memory = await import(
  pathToFileURL(path.join(bundleDir, 'memory.js')).href
)
const personas = await import(
  pathToFileURL(path.join(bundleDir, 'personas.js')).href
)
const webTools = await import(
  pathToFileURL(path.join(bundleDir, 'webTools.js')).href
)
const bashTools = await import(
  pathToFileURL(path.join(bundleDir, 'bashTools.js')).href
)
const agentTools = await import(
  pathToFileURL(path.join(bundleDir, 'agentTools.js')).href,
)
const scheduledTasks = await import(
  pathToFileURL(path.join(bundleDir, 'scheduledTasks.js')).href,
)
const fitness = await import(
  pathToFileURL(path.join(bundleDir, 'fitness.js')).href,
)
const goals = await import(
  pathToFileURL(path.join(bundleDir, 'goals.js')).href,
)
const chatDocuments = await import(pathToFileURL(path.join(bundleDir, 'chatDocuments.js')).href)
const browserTools = await import(pathToFileURL(path.join(bundleDir, 'browserTools.js')).href)
const browserSnapshot = await import(pathToFileURL(path.join(bundleDir, 'browserSnapshot.js')).href)
const agentHome = await import(
  pathToFileURL(path.join(bundleDir, 'agentHome.js')).href,
)
const toolset = await import(
  pathToFileURL(path.join(bundleDir, 'toolset.js')).href,
)
const notificationText = await import(
  pathToFileURL(path.join(bundleDir, 'notificationText.js')).href,
)
const welcome = await import(
  pathToFileURL(path.join(bundleDir, 'welcome.js')).href,
)
const diagnostics = await import(pathToFileURL(path.join(bundleDir, 'diagnostics.js')).href)
const observability = await import(pathToFileURL(path.join(bundleDir, 'observability.js')).href)
const decisionStrategy = await import(
  pathToFileURL(path.join(bundleDir, 'decisionStrategy.js')).href,
)
const cli = await import(pathToFileURL(path.join(bundleDir, 'cli.js')).href)

// 2. 初始化（临时目录，WAL）
fs.mkdirSync(userData, { recursive: true })
db.initDb(userData)
observability.initObservability(userData)
db.setSetting('local_observability', '1')
const jevRequests = []
decisionStrategy.initResponseDecisionEngine({
  codec: {
    seal: (value) => Buffer.from(value, 'utf8').toString('base64'),
    unseal: (value) => Buffer.from(value, 'base64').toString('utf8'),
  },
  fetch: async (_url, init) => {
    const request = JSON.parse(String(init.body))
    jevRequests.push({
      authorization: init.headers.Authorization,
      state: request.state,
      question: request.questions.response_action,
    })
    const natural = request.state.decision_kind === 'natural_follow_up'
    const lowConfidence = JSON.stringify(request.state).includes('Jev 低置信度冒烟')
    const choice = natural
      ? request.state.follow_up_number === 1
        ? 'reply'
        : 'skip'
      : request.state.round === 1
        ? 'reply'
        : 'skip'
    return new Response(
      JSON.stringify({
        model: 'jev-1.13.0',
        answers: {
          response_action: {
            type: 'choice',
            choice,
            probabilities: { reply: choice === 'reply' ? 0.94 : 0.06, skip: choice === 'skip' ? 0.94 : 0.06 },
            confidence: lowConfidence ? 0.3 : 0.88,
          },
        },
        usage: { input_tokens: 120, output_tokens: 8 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  },
})
workspace.initWorkspace(userData)
const events = []
orchestrator.initOrchestrator({ emit: (ev) => events.push(ev) })

console.log('\n[1] 建库 & schema')
{
  assert(fs.existsSync(path.join(userData, 'covan.db')), '数据库文件为 covan.db')
  const tables = db
    .getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name)
  for (const t of [
    'providers',
    'bots',
    'chats',
    'chat_members',
    'messages',
    'chat_topics',
    'memories',
    'settings',
    'scheduled_tasks',
    'fitness_profiles',
    'fitness_logs',
    'goals',
    'goal_collaborators',
    'goal_sessions',
    'goal_artifacts',
    'goal_updates',
    'goal_operations',
    'goal_order_scopes',
    'goal_executions',
    'goal_execution_inputs',
    'browser_activity',
  ]) {
    assert(tables.includes(t), `表 ${t} 已创建`)
  }
  const config = decisionStrategy.saveJevConfig({
    api_key: 'jev-smoke-secret',
    model: 'jev-latest',
    confidence_threshold: 0.6,
  })
  assert(config.has_api_key && !('api_key' in config), 'Jev 配置只向渲染层返回密钥状态')
  assert(
    !db.getSetting('jev_api_key_sealed').includes('jev-smoke-secret'),
    'Jev API Key 加密后写入本地设置',
  )
}

console.log('\n[1a0] 操作浏览器能力边界')
{
  for (const value of ['file:///tmp/test', 'javascript:alert(1)', 'covan-image://local/x', 'https://user:password@example.com']) {
    let rejected = false
    try { browserSnapshot.browserUrl(value) } catch { rejected = true }
    assert(rejected, '浏览器拒绝私有协议、脚本与内嵌凭据')
  }
  assert(browserSnapshot.publicUrl('https://example.com/path?token=secret#fragment') === 'https://example.com/path', '模型获得的 URL 不包含查询令牌或片段')
  assert(browserSnapshot.browserDownloadOrigin('blob:https://example.com/fixture', 'https://example.com/report') === 'https://example.com', '浏览器支持同站点生成的 Blob 下载')
  let foreignBlob = false
  try { browserSnapshot.browserDownloadOrigin('blob:https://other.example/fixture', 'https://example.com/report') } catch { foreignBlob = true }
  assert(foreignBlob, 'Blob 下载拒绝不匹配的站点来源')
  const signal = new AbortController()
  const privateTools = toolset.createAgentToolset({ botId: 'fixture', chatId: 'fixture', signal: signal.signal, privateConversation: true })
  assert(!privateTools.some((tool) => tool.name.startsWith('browser_')), 'Agent 私聊不装配可操作浏览器')
  const received = [], released = []
  browserTools.configureBrowserController(async (context, command) => { received.push({ context, command }); return { ok: true } }, (scope) => released.push(scope))
  const browser = browserTools.createBrowserTools({ botId: 'fixture', chatId: 'fixture', signal: signal.signal })
  const open = browser.find((tool) => tool.name === 'browser_open')
  await open.execute('fixture', { url: 'https://example.com', action: 'untrusted-action' })
  assert(received[0].command.action === 'open' && received[0].context.botId === 'fixture', '工具名决定动作且 Bot/会话作用域不由模型指定')
  for (let index = 1; index < 40; index++) await open.execute('fixture', { url: 'https://example.com' })
  let exceeded = false
  try { await open.execute('fixture', { url: 'https://example.com' }) } catch { exceeded = true }
  assert(exceeded && received.length === 40, '每轮浏览器调用数受限，越界不会进入执行器')
  browserTools.releaseBrowserTools(signal.signal)
  assert(released.includes(received[0].context.scopeId), '轮次结束释放浏览器作用域')
  signal.abort()
  let cancelled = false
  try { await open.execute('fixture', { url: 'https://example.com' }) } catch { cancelled = true }
  assert(cancelled && received.length === 40, '已取消运行不能继续调用浏览器')
}

console.log('\n[1a] 文档附件与目标执行保护')
{
  const document = await chatDocuments.storeChatAttachment(Buffer.from('const answer = 42\n// 第二行'), 'source.ts')
  const preview = chatDocuments.readChatDocument(document.path)
  assert(preview.text.includes('L2: // 第二行') && document.kind === 'document', '代码附件提取可追溯的行号')
  assert(chatDocuments.validateChatAttachments([{ ...document, name: '伪造来源名', mime: 'image/png' }])[0].name === 'source.ts', '发送时由主进程恢复文档真实元数据')
  const budget = { remaining: 5 }
  const first = chatDocuments.attachmentContent([document], budget)[0]
  const omitted = chatDocuments.attachmentContent([document], budget)[0]
  assert(JSON.parse(first.text).truncated && JSON.parse(omitted.text).text.includes('重新附上'), '附件上下文预算与省略均明确标注')
  const outside = path.join(userData, 'outside.txt')
  fs.writeFileSync(outside, 'not an attachment')
  const link = path.join(userData, 'chat-documents', '00000000-0000-0000-0000-000000000000.txt')
  fs.symlinkSync(outside, link)
  let rejected = false
  try { chatDocuments.readChatDocument('chat-documents/' + path.basename(link)) } catch { rejected = true }
  assert(rejected, '文档附件拒绝符号链接越界')
  const owner = db.createBot({ name: '执行保护测试' })
  const taskScope = `${owner.id}/tasks/scoped-execution`
  workspace.ensureWorkspace(taskScope)
  const scopedWrite = workspace.createWorkspaceTools(taskScope).find((tool) => tool.name === 'workspace_write')
  let scopeEscapeRejected = false
  try { await scopedWrite.execute('scope-escape', { path: '../sibling.txt', content: 'no' }) } catch { scopeEscapeRejected = true }
  assert(scopeEscapeRejected, '目标文件工具拒绝访问相邻任务目录')
  const outsideScope = path.join(workspace.ensureWorkspace(owner.id), 'linked-scope')
  fs.symlinkSync(userData, outsideScope)
  let rootLinkRejected = false
  try { workspace.ensureWorkspace(`${owner.id}/linked-scope/execution`) } catch { rootLinkRejected = true }
  assert(rootLinkRejected, '任务目录本身的符号链接不能成为新的工作区根')

  const chat = db.createDm(owner.id)
  const goal = goals.createGoal({ title: '恢复目标执行', ownerAgentId: owner.id }, { kind: 'user' })
  const run = goals.beginGoalExecution(goal.id, owner.id, chat.id, goal.version)
  let statusRejected = false
  try { goals.updateGoal(goal.id, { status: 'COMPLETED' }, { kind: 'agent', botId: owner.id }) } catch { statusRejected = true }
  assert(statusRejected, '执行下一步期间 Bot 不能自行完成整个目标')
  const input = goals.addExecutionInput(run.id, '重点比较定价', 'input-1')
  assert(goals.addExecutionInput(run.id, '重点比较定价', 'input-1').id === input.id, '补充要求重试幂等')
  let differentRejected = false
  try { goals.addExecutionInput(run.id, '其他内容', 'input-1') } catch { differentRejected = true }
  assert(differentRejected, '同一请求标识不能替换补充内容')
  assert(goals.takeExecutionInputs(run.id).length === 1 && goals.takeExecutionInputs(run.id).length === 0, '补充要求仅送达一次执行步骤')
  const expert = goals.beginExpertExecution(run, owner.id, 'expert-1', '独立咨询')
  assert(goals.latestGoalExecution(goal.id).id === run.id, '专家执行不会覆盖目标主责执行')
  assert(goals.listGoalExecutions(chat.id).some((item) => item.id === expert.id && item.parentExecutionId === run.id), '专家关系可从持久化记录恢复')

  goals.claimExecution(expert.id)
  goals.recoverGoalExecutions()
  assert(goals.getGoal(goal.id).execution.status === 'paused' && goals.getGoal(goal.id).status === 'ACTIVE', '重启将未完成执行暂停且保留目标状态')
  assert(goals.executionById(expert.id).status === 'paused' && goals.executionById(run.id).inputs.length === 1, '重启恢复保留专家与补充记录')
  goals.recoverGoalExecutions()
  assert(goals.latestGoalExecution(goal.id).id === run.id, '重复恢复不创建新的执行或重放任务')
  let staleRejected = false
  try { goals.beginGoalExecution(goal.id, owner.id, chat.id, goal.version) } catch { staleRejected = true }
  assert(staleRejected, '过期目标版本不能启动执行')
  let invalidTransition = false
  try { goals.transitionExecution(run.id, 'done') } catch { invalidTransition = true }
  assert(invalidTransition, '暂停任务不能跳过执行和验收直接完成')
  goals.transitionExecution(run.id, 'queued')
  const resumed = goals.claimExecution(run.id)
  assert(resumed.attempt === 2 && resumed.id === run.id, '恢复保持执行 ID 并隔离新的运行次数')
  const activeBefore = resumed.activeMs
  goals.addExecutionActiveTime(run.id, 1, 60000)
  assert(goals.executionById(run.id).activeMs === activeBefore, '旧阶段不能重复计入新阶段预算')
  goals.addExecutionActiveTime(run.id, resumed.attempt, 123)
  assert(goals.executionById(run.id).activeMs === activeBefore + 123, '活跃预算增量持久化，不按离线墙钟推算')
  const secondInput = goals.addExecutionInput(run.id, '检查点送达要求', 'checkpoint-input')
  const inbox = goals.executionInbox(run.id)
  goals.checkpointExecution(run.id, 1, inbox)
  assert(!goals.executionById(run.id).inputs.find((item) => item.id === secondInput.id).delivered, '旧运行回调不能确认新输入')
  goals.checkpointExecution(run.id, resumed.attempt, inbox, false)
  assert(!goals.executionById(run.id).inputs.find((item) => item.id === secondInput.id).delivered, '未确认检查点不能吞掉输入')
  goals.checkpointExecution(run.id, resumed.attempt, inbox)
  assert(goals.executionById(run.id).inputs.find((item) => item.id === secondInput.id).delivered, '输入随真实上下文原子确认')
  goals.saveExecutionCliSession(run.id, resumed.attempt, 'fixture-cli-session', 'fixture-fingerprint')
  assert(goals.getExecutionCheckpoint(run.id).cliSessionId === 'fixture-cli-session', '任务 CLI 续接 ID 独立保存')
  goals.transitionExecution(expert.id, 'queued'); goals.claimExecution(expert.id)
  goals.transitionExecution(expert.id, 'done')
  const report = goals.executionById(expert.id)
  const updatesBefore = goals.getGoal(goal.id).updates.length
  goals.publishExecutionReport(report, '专家实际报告')
  goals.publishExecutionReport(report, '专家实际报告')
  assert(goals.getGoal(goal.id).updates.length === updatesBefore + 1, '专家报告重试只回写一次进展')
  const reports = goals.executionInbox(run.id)
  assert(reports.filter((item) => item.covanReportId).length === 1, '报告收件箱持久保存并去重')
  goals.checkpointExecution(run.id, resumed.attempt, [...inbox, ...reports])
  assert(goals.executionInbox(run.id).length === 0, '真实报告随上下文确认送达')
  goals.transitionExecution(run.id, 'review')
  goals.transitionExecution(run.id, 'done')
  assert(goals.getGoal(goal.id).status === 'ACTIVE', '本轮验收不自动完成整个目标')
  const { repairGoalHistory } = await import(pathToFileURL(path.join(bundleDir, 'goalHistory.js')).href)
  const interrupted = { role: 'assistant', content: [{ type: 'toolCall', id: 'successful', name: 'workspace_write', arguments: {} }, { type: 'toolCall', id: 'unknown', name: 'bash', arguments: {} }], stopReason: 'aborted' }
  const successful = { role: 'toolResult', toolCallId: 'successful', toolName: 'workspace_write', content: [{ type: 'text', text: '实际成功结果' }] }
  const repaired = repairGoalHistory([interrupted, successful, { role: 'user', content: '继续', timestamp: 1 }])
  assert(repaired[1] === successful && repaired[2].toolCallId === 'unknown' && repaired[2].isError && repaired[3].role === 'user', '恢复保留成功结果、补齐未知结果并保持合法消息顺序')
  const execution = await import(pathToFileURL(path.join(bundleDir, 'goalExecution.js')).href)
  const followGoal = goals.createGoal({ title: '输入来源与事务', ownerAgentId: owner.id }, { kind: 'user' })
  const followRun = goals.beginGoalExecution(followGoal.id, owner.id, chat.id)
  const reply = db.insertMessage({ chat_id: chat.id, sender_type: 'bot', sender_bot_id: owner.id, content: '已有任务成果' })
  goals.setGoalExecutionMessage(followRun.id, reply.id)
  goals.transitionExecution(followRun.id, 'paused')
  const beforeMessages = db.listMessages(chat.id).length
  db.getDb().exec(`CREATE TRIGGER fixture_fail_followup BEFORE INSERT ON goal_execution_inputs
    WHEN NEW.request_id='rollback-followup' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;`)
  const beforeFollowUpEvents = events.length
  let rolledBack = false
  try { execution.sendGoalFollowUp(chat.id, reply.id, '事务回滚补充', 'rollback-followup') } catch { rolledBack = true }
  db.getDb().exec('DROP TRIGGER fixture_fail_followup')
  assert(rolledBack && db.listMessages(chat.id).length === beforeMessages && !goals.executionById(followRun.id).inputs.length, '收件箱失败会回滚聊天消息和任务状态')
  assert(events.length === beforeFollowUpEvents, '回滚不泄漏事件或记忆摘要调度')
  const followMessage = execution.sendGoalFollowUp(chat.id, reply.id, '真实聊天补充', 'followup-retry')
  assert(followMessage.goal_input_execution_id === followRun.id && followMessage.goal_input_delivery === 'pending', '后续消息具有真实任务来源与待处理回执')
  assert(!db.listMemories(owner.id).some(item => item.source_id === followMessage.id), '任务补充留在任务上下文，不变成普通聊天自动记忆')
  const inputReceipt = goals.executionById(followRun.id).inputs[0]
  assert(inputReceipt.sourceMessageId === followMessage.id && inputReceipt.replyToMessageId === reply.id, '收件箱保留来源和引用消息')
  assert(goals.executionById(followRun.id).status === 'paused', '后续消息不绕过暂停')
  goals.checkpointExecution(followRun.id, followRun.attempt, goals.executionInbox(followRun.id))
  assert(db.getMessage(followMessage.id).goal_input_delivery === 'delivered', '聊天回执随真实检查点确认')
  goals.transitionExecution(followRun.id, 'stopped')
  assert(execution.sendGoalFollowUp(chat.id, reply.id, '真实聊天补充', 'followup-retry').id === followMessage.id, '终态之后重试原请求仍返回原消息')
  let changedReplyRejected = false
  try { execution.sendGoalFollowUp(chat.id, followMessage.id, '真实聊天补充', 'followup-retry') } catch { changedReplyRejected = true }
  assert(changedReplyRejected, '相同请求标识不能改投其他引用')
  goals.deleteGoal(followGoal.id, { kind: 'user' })
  assert(db.getMessage(followMessage.id).goal_input_execution_id === followRun.id && db.getMessage(followMessage.id).goal_input_delivery === 'unavailable', '删除目标仍保留消息来源，不转成普通聊天输入')

  const queuedGoals = ['新目标先入队', '已有目标补充'].map(title => goals.createGoal({ title, ownerAgentId: owner.id }, { kind: 'user' }))
  const queuedRuns = queuedGoals.map(item => goals.beginGoalExecution(item.id, owner.id, chat.id, undefined, 'queued'))
  goals.addExecutionInput(queuedRuns[1].id, '用户等待处理的要求', 'priority-input')
  assert(goals.pendingExecutionIds()[0] === queuedRuns[1].id && goals.executionById(queuedRuns[1].id).queuePosition === 1, '已有任务的用户补充优先，队列位置与真实顺序一致')
  for (const item of queuedGoals) goals.deleteGoal(item.id, { kind: 'user' })
  goals.deleteGoal(goal.id, { kind: 'user' })
  db.deleteBot(owner.id)
}

console.log('\n[1b1] Goals：共享存储、权限、关联和排序')
{
  const owner = db.createBot({ name: '目标主责冒烟' })
  const collaborator = db.createBot({ name: '目标协作冒烟' })
  const outsider = db.createBot({ name: '目标旁观冒烟' })
  const chat = db.createDm(owner.id)
  const normalTools = toolset.createAgentToolset({
    botId: owner.id, chatId: chat.id, signal: new AbortController().signal,
  })
  const privateTools = toolset.createAgentToolset({
    botId: owner.id, chatId: chat.id, signal: new AbortController().signal, privateConversation: true,
  })
  assert(
    ['list_goals', 'get_goal', 'create_goal', 'update_goal', 'add_goal_update', 'attach_artifact'].every((name) => normalTools.some((tool) => tool.name === name)) &&
      !privateTools.some((tool) => tool.name === 'create_goal'),
    '普通 API Bot 获得 Goals 工具，Agent 私聊保持只读',
  )
  const created = goals.createGoal({
    title: '每周跑步三次',
    category: 'HEALTH',
    ownerAgentId: owner.id,
    collaboratorAgentIds: [collaborator.id],
    sessionId: chat.id,
    subGoals: [{ title: '安排固定日' }, { title: '准备跑鞋' }],
  }, { kind: 'user', chatId: chat.id })
  assert(
    created.title === '每周跑步三次' && created.subGoals?.length === 2 &&
      created.ownerAgentId === owner.id && created.collaboratorAgentIds[0] === collaborator.id,
    '创建目标、协作者和一级子目标原子落库',
  )
  const listed = goals.listGoals({ source: 'user_goal', status: ['ACTIVE'] })
  assert(listed.goals.some((goal) => goal.id === created.id) && listed.nextCursor === null, '目标列表按来源和状态读取真实数据')
  const progressed = goals.updateGoal(created.id, { status: 'PAUSED', momentum: 0.35 }, {
    kind: 'agent', botId: owner.id, chatId: chat.id,
  }, created.version)
  assert(progressed.status === 'PAUSED' && progressed.momentum === 0.35 && progressed.version === created.version + 1, '主责 Bot 可更新状态与动量并递增版本')
  let forbidden = false
  try {
    goals.addGoalUpdate(progressed.id, '旁观 Bot 不能写入', { kind: 'agent', botId: outsider.id, chatId: chat.id }, progressed.version)
  } catch { forbidden = true }
  assert(forbidden, '非协作者 Bot 不能写入进展')
  const note = goals.addGoalUpdate(progressed.id, '已安排周二、周四、周日跑步。', {
    kind: 'agent', botId: collaborator.id, chatId: chat.id,
  }, progressed.version)
  const afterNote = goals.getGoal(progressed.id)
  assert(note.text.includes('周二') && afterNote.updates?.some((entry) => entry.id === note.id), '协作者写入的进展可从详情回读')
  const reassigned = goals.updateGoal(afterNote.id, { collaboratorAgentIds: [] }, { kind: 'user', chatId: chat.id }, afterNote.version)
  assert(
    reassigned.collaboratorAgentIds.length === 0 && reassigned.updates?.some((entry) => entry.kind === 'assignment_changed'),
    '协作者变更写入真实活动记录',
  )
  const task = db.saveScheduledTask({
    bot_id: owner.id,
    chat_id: chat.id,
    title: '跑步提醒',
    prompt: '提醒用户完成本周跑步计划',
    schedule: 'cron',
    cron: '0 20 * * 2,4,0',
  })
  const linked = goals.attachGoalArtifact(reassigned.id, { type: 'cron', id: task.id }, { kind: 'user', chatId: chat.id }, reassigned.version)
  assert(linked.artifacts?.some((artifact) => artifact.type === 'cron' && artifact.id === task.id), '目标关联已有定时任务而不创建副本')
  const duplicateLink = goals.attachGoalArtifact(linked.id, { type: 'cron', id: task.id }, { kind: 'user', chatId: chat.id }, linked.version)
  assert(duplicateLink.version === linked.version && duplicateLink.artifacts?.length === linked.artifacts?.length, '重复关联不重复写入活动或版本')
  const second = goals.createGoal({ title: '读完两本书', source: 'user_goal' }, { kind: 'user', chatId: chat.id })
  goals.reorderGoals([second.id, linked.id], 'user_goal', null, { kind: 'user', chatId: chat.id })
  const reordered = goals.listGoals({ source: 'user_goal', status: ['ACTIVE', 'PAUSED'] }).goals
  assert(reordered.findIndex((goal) => goal.id === second.id) < reordered.findIndex((goal) => goal.id === linked.id), '用户排序写入同一分区且可回读')
  let stale = false
  try { goals.updateGoal(linked.id, { status: 'ACTIVE' }, { kind: 'user' }, linked.version) } catch { stale = true }
  assert(stale, '旧版本写入被拒绝，避免覆盖新进展')
  const inherited = goals.createGoal({
    title: '继承父目标协作范围', parentGoalId: created.id, source: 'assistant_tracking',
    category: 'MONEY', ownerAgentId: outsider.id, collaboratorAgentIds: [collaborator.id],
  }, { kind: 'user', chatId: chat.id })
  assert(
    inherited.source === 'user_goal' && inherited.category === 'HEALTH' &&
      inherited.ownerAgentId === owner.id && inherited.collaboratorAgentIds.length === 0,
    '子目标继承父目标来源、分类和协作范围',
  )
  const childId = created.subGoals?.[0]?.id
  if (childId) goals.deleteGoal(childId, { kind: 'user' })
  assert(goals.getGoal(created.id).subGoals?.length === 2, '删除子目标不会删除父目标')
  db.deleteBot(owner.id)
  const ownerDeleted = goals.getGoal(created.id)
  assert(ownerDeleted.ownerAgentId === null && ownerDeleted.title === created.title, '删除 Bot 不删除共享目标')
  db.deleteBot(collaborator.id)
  db.deleteBot(outsider.id)
}

console.log('\n[1b] 成熟内容偏好与伴侣模板')
{
  db.setSetting('user_profile', JSON.stringify({ name: '旧资料测试' }))
  assert(
    db.getUserProfile().accept_mature_content === false,
    '旧资料默认关闭成熟内容',
  )
  const profile = db.getUserProfile()
  db.saveUserProfile({ ...profile, accept_mature_content: true })
  assert(
    db.getUserProfile().accept_mature_content === true,
    '成熟偏好按布尔值持久化',
  )
  let rejected = false
  try {
    db.saveUserProfile({ ...profile, accept_mature_content: 'true' })
  } catch {
    rejected = true
  }
  assert(
    rejected && db.getUserProfile().accept_mature_content,
    '非法偏好拒绝且不覆盖原值',
  )
  const { accept_mature_content, ...legacy } = profile
  db.saveUserProfile(legacy)
  assert(
    db.getUserProfile().accept_mature_content,
    '旧客户端省略新字段时保留偏好',
  )
  for (const id of ['girlfriend', 'boyfriend']) {
    assert(
      personas.personaTemplateById(id, true).prompt.includes('轻度调情'),
      id + ' 模板支持成熟风格',
    )
    assert(
      personas
        .personaTemplateById(id, false)
        .prompt.includes('用户未开启成熟内容偏好'),
      id + ' 默认模板为日常陪伴',
    )
  }
  assert(
    personas.personaTemplateById('fullstack', true).prompt ===
      personas.personaTemplateById('fullstack', false).prompt,
    '工作型模板不受偏好影响',
  )
  const bot = db.createBot({
    name: '偏好测试',
    system_prompt: personas.personaTemplateById('boyfriend', true).prompt,
  })
  assert(
    memory.buildSystemPrompt(bot, []).includes('用户已开启成熟内容偏好'),
    '运行时注入开启偏好，布尔字段不导致文本拼接崩溃',
  )
  db.saveUserProfile({ ...profile, accept_mature_content: false })
  const prompt = memory.buildSystemPrompt(db.getBot(bot.id), [])
  assert(
    prompt.includes(
      '当前内容偏好（优先于人设中的旧偏好）\n用户未开启成熟内容偏好',
    ),
    '关闭状态覆盖旧模板偏好，无需改写人设',
  )
  assert(
    !prompt.includes('accept_mature_content:'),
    '原始布尔字段不作为用户资料文本发送',
  )
  assert(
    prompt.includes('必须先用 list_bots 找到准确 ID，再调用 agent_private_chat') &&
      prompt.includes('只有本轮确实收到 agent_private_chat 的工具结果') &&
      prompt.includes('禁止自行模拟、代写或编造另一位 Bot 的回答') &&
      prompt.includes('只能依据本轮实际工具执行结果回答'),
    '系统提示词要求跨 Bot 咨询必须真实调用工具且禁止伪造结果',
  )
  db.deleteBot(bot.id)
  db.setSetting('user_profile', '')
}

console.log('\n[1b2] 健身教练档案、记录与工具')
{
  const coach = personas.personaTemplateById('fitness-coach', false)
  assert(
    coach?.tags.includes('健身') &&
      coach.prompt.includes('fitness_profile') &&
      coach.prompt.includes('fitness_log') &&
      coach.prompt.includes('fitness_summary'),
    '内置健身教练模板带健康标签与结构化工具指引',
  )
  const builtinSkill = path.join(root, 'resources', 'skills', 'fitness-coach', 'SKILL.md')
  const builtinSkillText = fs.readFileSync(builtinSkill, 'utf8')
  assert(
    builtinSkillText.startsWith('---') &&
      builtinSkillText.includes('name: fitness-coach') &&
      builtinSkillText.includes('fitness_log'),
    '内置 fitness-coach Skill 随应用分发且包含教练流程',
  )
  extensionStore.initExtensions(userData, { seal: (value) => value, unseal: (value) => value })
  await extensionSkills.seedBuiltinFitnessSkill(path.join(root, 'resources', 'skills'))
  const installedCoachSkill = extensionStore.listSkills().find((skill) => skill.name === 'fitness-coach')
  assert(!!installedCoachSkill, '内置健身 Skill 安装到全局库')
  for (const template of personas.PERSONA_TEMPLATES) {
    const bot = botCreation.createBotFromTemplate({ name: template.label, persona_template_id: template.id, tags: template.tags })
    const assigned = extensionStore.getBotExtensions(bot.id).skillIds
    assert(
      template.id === 'fitness-coach'
        ? assigned.length === 1 && assigned[0] === installedCoachSkill.id
        : assigned.length === 0,
      `${template.label} 只装配模板声明的默认 Skills`,
    )
    db.deleteBot(bot.id)
  }
  const taggedBot = botCreation.createBotFromTemplate({ name: '仅带健身标签', tags: '健身,健康,薄肌' })
  assert(extensionStore.getBotExtensions(taggedBot.id).skillIds.length === 0, '标签不触发默认 Skill 装配')
  const unboundRuntime = await extensionRuntime.prepareBotExtensions(taggedBot.id, new AbortController().signal, {})
  assert(!unboundRuntime.tools.some((tool) => tool.name === 'skill_read'), '全局已安装健身 Skill 不会注入未装配 Bot 的运行上下文')
  await unboundRuntime.close()
  const templateCoach = botCreation.createBotFromTemplate({ name: '模板教练', persona_template_id: 'fitness-coach' })
  extensionStore.setBotExtensions(templateCoach.id, { mcpServerIds: [], skillIds: [] })
  extensionStore.setBotExtensions(taggedBot.id, { mcpServerIds: [], skillIds: [installedCoachSkill.id] })
  await extensionSkills.seedBuiltinFitnessSkill(path.join(root, 'resources', 'skills'))
  assert(extensionStore.getBotExtensions(templateCoach.id).skillIds.length === 0, '启动安装不恢复用户已取消的模板 Skill')
  assert(extensionStore.getBotExtensions(taggedBot.id).skillIds.includes(installedCoachSkill.id), '启动安装保留用户手动装配的 Skill')
  db.deleteBot(templateCoach.id)
  db.deleteBot(taggedBot.id)
  const beforeInvalidTemplate = db.listBots().length
  let invalidTemplateRejected = false
  try { botCreation.createBotFromTemplate({ name: '无效模板', persona_template_id: 'not-a-template' }) } catch { invalidTemplateRejected = true }
  assert(invalidTemplateRejected && db.listBots().length === beforeInvalidTemplate, '未知模板被拒绝且不留下半成品 Bot')
  await extensionSkills.deleteSkill(installedCoachSkill.id)
  let missingSkillRejected = false
  try { botCreation.createBotFromTemplate({ name: '缺失技能', persona_template_id: 'fitness-coach' }) } catch { missingSkillRejected = true }
  assert(missingSkillRejected && db.listBots().length === beforeInvalidTemplate, '模板 Skill 缺失时明确失败且不留下半成品 Bot')
  await extensionSkills.seedBuiltinFitnessSkill(path.join(root, 'resources', 'skills'))
  const coachBot = db.createBot({
    name: '健身教练冒烟',
    tags: coach.tags,
    system_prompt: coach.prompt,
  })
  const firstFitnessDate = localDateOffset(-5)
  const secondFitnessDate = localDateOffset(-2)
  const toolFitnessDate = localDateOffset(-1)
  const savedProfile = db.saveFitnessProfile({
    bot_id: coachBot.id,
    age: 30,
    sex: 'male',
    height_cm: 178,
    weight_kg: 72.5,
    body_fat_pct: 18,
    waist_cm: 80,
    goal: '薄肌',
    target_weight_kg: 70,
    target_date: '2026-12-31',
    experience: '中级',
    equipment: '哑铃、杠铃',
    plan: '每周三练',
  })
  assert(
    savedProfile.age === 30 &&
      savedProfile.goal === '薄肌' &&
      savedProfile.target_date === '2026-12-31',
    '身体档案保存并回读',
  )
  const firstLog = db.saveFitnessLog({
    bot_id: coachBot.id,
    date: firstFitnessDate,
    weight_kg: 72.5,
    waist_cm: 80,
    sleep_hours: 7.2,
    steps: 9000,
    workout: '下肢 A',
    protein_g: 140,
  })
  db.saveFitnessLog({
    bot_id: coachBot.id,
    date: secondFitnessDate,
    weight_kg: 71.8,
    waist_cm: 79,
    sleep_hours: 7.5,
    steps: 11000,
    workout: '上肢 A',
    protein_g: 150,
  })
  const sameDay = db.saveFitnessLog({
    bot_id: coachBot.id,
    date: firstFitnessDate,
    weight_kg: 72.4,
    note: '同一天更新',
  })
  const summary = db.getFitnessSummary(coachBot.id, 30)
  assert(
    sameDay.id === firstLog.id &&
      summary.logs.filter((log) => log.date === firstFitnessDate).length === 1,
    '同一天重复记录更新而不是新增',
  )
  assert(
    summary.latest?.weight_kg === 71.8 &&
      summary.change.weight_kg === -0.6 &&
      summary.series.weight.length === 2 &&
      summary.averages.sleep_hours !== null,
    '摘要计算最新值、区间变化、序列与 7 日均值',
  )
  let invalidRejected = false
  try {
    db.saveFitnessLog({ bot_id: coachBot.id, date: '2026-02-30', weight_kg: 70 })
  } catch {
    invalidRejected = true
  }
  assert(invalidRejected, '无效日期被拒绝')
  const profileTool = fitness
    .createFitnessTools(coachBot.id)
    .find((tool) => tool.name === 'fitness_profile')
  const logTool = fitness
    .createFitnessTools(coachBot.id)
    .find((tool) => tool.name === 'fitness_log')
  const summaryTool = fitness
    .createFitnessTools(coachBot.id)
    .find((tool) => tool.name === 'fitness_summary')
  const profileResult = await profileTool.execute(
    'fitness-profile',
    { plan: '每周三练，周日复盘' },
    new AbortController().signal,
  )
  const parsedProfile = JSON.parse(profileResult.content[0].text)
  assert(parsedProfile.plan.includes('周日复盘'), 'fitness_profile 工具更新计划')
  const logResult = await logTool.execute(
    'fitness-log',
    { date: toolFitnessDate, weight_kg: 71.6, steps: 10000 },
    new AbortController().signal,
  )
  const parsedLog = JSON.parse(logResult.content[0].text)
  assert(
    parsedLog.log.weight_kg === 71.6 &&
      parsedLog.summary.logs.some((log) => log.date === toolFitnessDate),
    'fitness_log 工具写入并返回摘要',
  )
  const summaryResult = await summaryTool.execute(
    'fitness-summary',
    { days: 14 },
    new AbortController().signal,
  )
  assert(
    JSON.parse(summaryResult.content[0].text).profile.goal === '薄肌',
    'fitness_summary 工具返回档案与趋势',
  )
  const coachTools = toolset.createAgentToolset({
    botId: coachBot.id,
    chatId: db.createDm(coachBot.id).id,
    signal: new AbortController().signal,
    fitness: true,
  })
  assert(
    ['fitness_profile', 'fitness_log', 'fitness_summary'].every((name) =>
      coachTools.some((tool) => tool.name === name),
    ),
    '教练 Bot 装配 fitness 工具',
  )
  const normalBot = db.createBot({ name: '普通 Bot' })
  const normalChat = db.createDm(normalBot.id)
  const normalTools = toolset.createAgentToolset({
    botId: normalBot.id,
    chatId: normalChat.id,
    signal: new AbortController().signal,
    fitness: false,
  })
  assert(
    !normalTools.some((tool) => tool.name.startsWith('fitness_')),
    '普通 Bot 不装配 fitness 工具',
  )
  db.deleteBot(normalBot.id)
  db.deleteBot(coachBot.id)
  const body = notificationText.notificationBody(
    '**今日**：[训练计划](https://example.com)\n\n```ts\nconst secret = 1\n```\n' +
      '很长的正文'.repeat(60),
  )
  assert(
    body.startsWith('今日') &&
      !body.includes('https://') &&
      !body.includes('```') &&
      body.length <= 140,
    '系统通知正文去掉 Markdown、链接与代码块并截断',
  )
}

console.log('\n[1b3] 首次开场白：模板 fallback、异步升级、去重与重新生成')
{
  const mockProvider = db.saveProvider({ name: 'Welcome Mock', kind: 'mock' })
  const welcomeBot = db.createBot({
    name: '开场测试',
    description: '测试角色',
    system_prompt: '你叫小美女，是用户的伴侣。',
    tags: '开发,评审',
    provider_id: mockProvider.id,
  })
  const welcomeChat = db.createDm(welcomeBot.id)
  const first = welcome.ensureWelcome(welcomeChat.id)
  assert(
    first?.system_kind === 'welcome' &&
      !!first?.content &&
      first.sender_type === 'bot' &&
      first.content.includes('开场测试'),
    '空 DM 插入一条欢迎消息并标记 welcome，且使用当前 Bot 名称',
  )
  const normalized = welcome.normalizeWelcomeText('嗨，我是小美女。', welcomeBot)
  assert(
    normalized.includes('开场测试') && !normalized.includes('小美女'),
    '生成文本把模板旧名替换为当前 Bot 名称',
  )
  if (first) db.updateMessage(first.id, { content: '嗨，我是小美女。' })
  welcome.repairWelcomeNames()
  assert(
    !!db.getWelcomeMessage(welcomeChat.id)?.content.includes('开场测试'),
    '启动修复会改写旧欢迎消息里的模板旧名',
  )
  assert(
    db.listMemories(welcomeBot.id).length === 0,
    '欢迎消息不写入即时记忆',
  )
  await sleep(300)
  const generated = db.getWelcomeMessage(welcomeChat.id)
  assert(
    !!generated?.content && generated.content.length > 0,
    '欢迎消息在后台完成一次文本生成或保留 fallback',
  )
  const again = welcome.ensureWelcome(welcomeChat.id)
  assert(again?.id === first?.id, '再次打开不会重复生成欢迎消息')
  const welcomeCount = db
    .listMessages(welcomeChat.id, undefined, 20)
    .filter((message) => message.system_kind === 'welcome').length
  assert(welcomeCount === 1, '同一 DM 只有一条欢迎消息')
  const before = db.getWelcomeMessage(welcomeChat.id)
  const regenerated = welcome.regenerateWelcome(welcomeChat.id)
  assert(
    regenerated?.id === before?.id,
    '重新生成复用同一条欢迎消息而不是新增',
  )
  await sleep(300)
  assert(
    db
      .listMessages(welcomeChat.id, undefined, 20)
      .filter((message) => message.system_kind === 'welcome').length === 1,
    '重新生成后仍只有一条欢迎消息',
  )
  db.deleteBot(welcomeBot.id)
  db.deleteProvider(mockProvider.id)
}

console.log('\n[1c] 可替换网页搜索 provider')
{
  let received
  const tools = webTools.createWebTools({
    searchProvider: {
      id: 'smoke-search',
      async search(request) {
        received = request
        return [
          { title: '', url: 'https://empty.example/', snippet: '无标题' },
          { title: '非 HTTP', url: 'file:///tmp/private', snippet: '必须过滤' },
          {
            title: '有效结果',
            url: 'https://example.com/path?q=1',
            snippet: 'x'.repeat(2_000),
          },
        ]
      },
    },
  })
  const search = tools.find((tool) => tool.name === 'web_search')
  const result = await search.execute(
    'smoke-search-call',
    { query: 'Covan 工具层', limit: 3, language: 'zh-CN' },
    new AbortController().signal,
  )
  assert(
    received.query === 'Covan 工具层' && received.limit === 3,
    '搜索请求通过 provider 接口注入',
  )
  assert(
    result.details.provider === 'smoke-search' &&
      result.details.results.length === 1 &&
      result.details.results[0].snippet.length === 1_200,
    'provider 返回值由核心层过滤非 HTTP URL 并截断输出',
  )
}

if (process.env.COVAN_SKIP_BASH_SMOKE !== '1') {
console.log('\n[1d] Bash 工作区沙箱')
{
  const bot = db.createBot({ name: 'Bash 测试' })
  workspace.ensureWorkspace(bot.id)
  const bash = bashTools
    .createBashTools(bot.id)
    .find((tool) => tool.name === 'bash')
  const signal = new AbortController().signal
  process.env.COVAN_SMOKE_BASH_SECRET = 'MUST_NOT_REACH_BASH'
  const run = await bash.execute(
    'bash-basic',
    {
      command:
        "mkdir -p nested && printf 'bash-ok' > nested/result.txt && printf 'stdout-ok' && printf 'stderr-ok' >&2 && printf \"$COVAN_SMOKE_BASH_SECRET\"",
    },
    signal,
  )
  delete process.env.COVAN_SMOKE_BASH_SECRET
  assert(
    run.details.exitCode === 0 &&
      run.content[0].text.includes('stdout-ok') &&
      run.content[0].text.includes('stderr-ok') &&
      !run.content[0].text.includes('MUST_NOT_REACH_BASH') &&
      fs.readFileSync(
        path.join(workspace.botWorkspaceDir(bot.id), 'nested', 'result.txt'),
        'utf8',
      ) === 'bash-ok',
    'Bash 在 Bot 工作区执行并使用不含宿主密钥的最小环境',
  )
  const nested = await bash.execute(
    'bash-cwd',
    { command: 'pwd', cwd: 'nested' },
    signal,
  )
  assert(
    nested.details.cwd === 'nested' &&
      nested.content[0].text.includes('/nested'),
    'Bash cwd 只能选择工作区内已有目录',
  )
  const outside = path.join(tmp, 'bash-private.txt')
  fs.writeFileSync(outside, 'OUTSIDE_WORKSPACE_SECRET')
  const denied = await bash.execute(
    'bash-outside-read',
    { command: `cat ${JSON.stringify(outside)}` },
    signal,
  )
  assert(
    denied.details.exitCode !== 0 &&
      !denied.content[0].text.includes('OUTSIDE_WORKSPACE_SECRET'),
    'macOS 沙箱拒绝 Bash 读取 Bot 工作区外的文件内容',
  )
  const timedOut = await bash.execute(
    'bash-timeout',
    { command: 'sleep 5', timeout_seconds: 1 },
    signal,
  )
  assert(
    timedOut.details.timedOut && timedOut.details.durationMs < 4_000,
    'Bash 超时会终止进程组',
  )
  const truncated = await bash.execute(
    'bash-truncate',
    { command: "head -c 100000 /dev/zero | tr '\\0' x" },
    signal,
  )
  assert(
    truncated.details.truncated && truncated.content[0].text.length < 50_000,
    'Bash 输出按流限制为40KB并标记截断',
  )
  db.deleteBot(bot.id)
}

}
if (process.env.COVAN_SKIP_BASH_SMOKE === '1')
  console.log('  - 跳过 Bash 沙箱：当前环境禁止 sandbox-exec')
console.log('\n[1e] 本地 CLI 运行后端')
{
  const fakeCli = path.join(root, 'scripts/fixtures/fake-cli.mjs')
  const cliLog = path.join(tmp, 'cli-calls.jsonl')
  process.env.COVAN_FAKE_CLI_LOG = cliLog
  const calls = () =>
    fs.existsSync(cliLog)
      ? fs
          .readFileSync(cliLog, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : []
  const TINY_PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  const userTurn = (text, withImage = false) => ({
    role: 'user',
    content: [
      { type: 'text', text },
      ...(withImage
        ? [{ type: 'image', data: TINY_PNG, mimeType: 'image/png' }]
        : []),
    ],
    timestamp: Date.now(),
  })
  const runTurn = async (bot, chat, history, systemPrompt) => {
    let text = ''
    const artifacts = []
    const errors = []
    await cli.runCliAgent(
      chat.id,
      db.getBot(bot.id),
      history,
      {
        onDelta: (delta) => {
          text += delta
        },
        onDone: () => {},
        onError: (message) => errors.push(message),
        onArtifact: (artifact) => artifacts.push(artifact),
      },
      { systemPrompt },
      new AbortController().signal,
    )
    return { text, artifacts, errors }
  }

  const probe = await cli.probeLocalCli('codex-cli', fakeCli)
  assert(
    probe.available && probe.version === '0.149.0' && probe.path === fakeCli,
    '探测本地 CLI 返回可用性、版本与真实路径',
  )
  const missing = await cli.probeLocalCli(
    'codex-cli',
    path.join(tmp, 'nope', 'missing-cli'),
  )
  assert(
    !missing.available && missing.error.includes('找不到'),
    'CLI 路径不存在时返回可读错误而不是抛异常',
  )

  const catalog = await cli.listLocalCliModels('codex-cli', fakeCli)
  assert(catalog.models.map((m) => m.id).join(',') === 'gpt-5.6-sol,gpt-5.6-luna,gpt-5.6-terra,account-only-model',
    'CLI 模型来自分页目录，去重并过滤隐藏项，不使用写死列表')
  assert(catalog.models.find((m) => m.id === 'gpt-5.6-sol')?.recommended, '保留 CLI 推荐模型标识')
  const missingCatalog = await cli.listLocalCliModels('codex-cli', path.join(tmp, 'missing-cli'))
  assert(!missingCatalog.models.length && !!missingCatalog.error, 'CLI 模型读取失败不回退假设的可用模型')
  const previousCatalogMode = process.env.COVAN_FAKE_CLI_CATALOG_MODE
  try {
    for (const mode of ['error', 'invalid', 'empty', 'loop']) {
      process.env.COVAN_FAKE_CLI_CATALOG_MODE = mode
      const result = await cli.listLocalCliModels('codex-cli', fakeCli)
      assert(!result.models.length && !!result.error, `模型目录 ${mode} 返回可恢复错误且不暴露部分目录`)
    }
  } finally {
    if (previousCatalogMode === undefined) delete process.env.COVAN_FAKE_CLI_CATALOG_MODE
    else process.env.COVAN_FAKE_CLI_CATALOG_MODE = previousCatalogMode
  }

  const cliBot = db.createBot({
    name: 'CLI 冒烟',
    backend: 'codex-cli',
    cli_path: fakeCli,
    cli_access: 'read-only',
    model: 'gpt-5.6-sol',
  })
  const cliChat = db.createDm(cliBot.id)

  const unsupportedBot = db.createBot({ name: '不支持模型', backend: 'codex-cli', cli_path: fakeCli, model: 'gpt-6-luna' })
  const unsupportedChat = db.createDm(unsupportedBot.id)
  const unsupported = await runTurn(unsupportedBot, unsupportedChat, [userTurn('你好')], '模型错误用例')
  assert(unsupported.errors.some((e) => e.includes('当前 CLI 登录账号不支持这个模型') && e.includes('刷新 CLI 模型列表') && !e.includes('invalid_request_error')),
    '账号不支持模型时显示中文修复入口，不直接展示原始 JSON')
  assert(db.getBot(unsupportedBot.id).model === 'gpt-6-luna', '模型错误不静默替换用户的模型选择')

  // 首轮：新会话，提示词应包含人设与既有转录
  const first = await runTurn(
    cliBot,
    cliChat,
    [userTurn('第一句')],
    '你是 CLI 冒烟 Bot',
  )
  const firstCall = calls().at(-1)
  assert(
    first.text.includes('假 CLI 回复（新会话）') && !first.errors.length,
    '本地 CLI 正文按增量流式回传并正常结束',
  )
  assert(
    firstCall.prompt.includes('你是 CLI 冒烟 Bot') &&
      firstCall.prompt.includes('第一句') &&
      firstCall.isResume === false,
    '首次发言把系统提示与转录一并交给 CLI 建立会话',
  )
  assert(
    firstCall.sandbox === 'read-only',
    'Codex CLI 的只读权限映射为 --sandbox read-only',
  )
  assert(
    first.artifacts.some((artifact) => artifact.relPath === 'cli-note.txt'),
    'CLI 报告的文件改动转换为工作区交付产物',
  )

  // 会话续接：只发送新的用户消息
  const second = await runTurn(cliBot, cliChat, [userTurn('第二句')], '不会再用到')
  const secondCall = calls().at(-1)
  assert(
    secondCall.isResume === true && secondCall.prompt === '第二句',
    '同一会话后续轮次续接 CLI 会话且只发送最新用户消息',
  )
  assert(
    second.text.includes('续接'),
    '续接轮次的正文同样写回聊天',
  )
  assert(
    firstCall.model === 'gpt-5.6-sol' && secondCall.model === 'gpt-5.6-sol',
    '新建与续接都带上 Bot 指定模型（resume 不带 -m 会回退 CLI 默认模型）',
  )

  // 图片：Codex 走 -i 附图参数
  await runTurn(cliBot, cliChat, [userTurn('看图', true)], '')
  assert(calls().at(-1).imageCount === 1, 'Codex CLI 通过 -i 传递用户图片')

  // 失败路径：CLI 报错时进入错误回调而不是产生空回复
  const failed = await runTurn(cliBot, cliChat, [userTurn('FAIL_ME')], '')
  assert(
    failed.errors.length === 1 && failed.errors[0].includes('假 CLI 主动失败'),
    'CLI 运行失败时把真实错误交给聊天气泡',
  )

  // 清空聊天记录后必须重建 CLI 会话
  db.clearChatMessages(cliChat.id)
  assert(
    db.getCliSession(cliBot.id, cliChat.id, cli.cliFingerprint(db.getBot(cliBot.id))) === '',
    '清空聊天记录后丢弃 CLI 会话映射',
  )
  await runTurn(cliBot, cliChat, [userTurn('清空之后')], '')
  assert(calls().at(-1).isResume === false, '清空后重新建立 CLI 会话')

  // 换模型也要重建会话：续接时模型与建会话不一致会被 CLI 警告甚至直接失败。
  db.updateBot(cliBot.id, { model: 'gpt-5.4' })
  await runTurn(db.getBot(cliBot.id), cliChat, [userTurn('换模型')], '')
  assert(
    calls().at(-1).isResume === false && calls().at(-1).model === 'gpt-5.4',
    '修改模型后重建 CLI 会话并带上新模型',
  )

  // 判断用 Provider 不能接管 CLI 的正文：CLI 后端优先于 mock Provider。
  const mockJudge = db.saveProvider({ name: 'Mock 判断用', kind: 'mock' })
  const judgeBot = db.createBot({
    name: 'CLI 带判断 Provider',
    backend: 'codex-cli',
    cli_path: fakeCli,
    model: 'gpt-5.6-sol',
    provider_id: mockJudge.id,
  })
  const judgeChat = db.createDm(judgeBot.id)
  const judged = await runTurn(judgeBot, judgeChat, [userTurn('正文必须来自 CLI')], '')
  assert(
    judged.text.includes('假 CLI 回复') && calls().at(-1).model === 'gpt-5.6-sol',
    '判断用 Provider（含 mock）不接管 CLI Bot 的正文生成',
  )
  db.deleteBot(judgeBot.id)
  db.deleteProvider(mockJudge.id)

  // Claude 方言：改用 -p/stream-json，且只读映射为 plan 权限模式
  process.env.COVAN_FAKE_CLI_DIALECT = 'claude'
  const claudeBot = db.createBot({
    name: 'Claude CLI 冒烟',
    backend: 'claude-cli',
    cli_path: fakeCli,
    cli_access: 'read-only',
  })
  const claudeChat = db.createDm(claudeBot.id)
  const claudeFirst = await runTurn(claudeBot, claudeChat, [userTurn('你好')], '人设')
  const claudeCall = calls().at(-1)
  assert(
    claudeFirst.text.includes('假 CLI 回复（新会话）') &&
      claudeCall.permissionMode === 'plan',
    'Claude CLI 适配器解析 stream-json 并把只读映射为 plan 权限模式',
  )
  const claudeSecond = await runTurn(claudeBot, claudeChat, [userTurn('再来')], '')
  assert(
    calls().at(-1).isResume === true && claudeSecond.text.includes('续接'),
    'Claude CLI 通过 --resume 续接会话',
  )
  delete process.env.COVAN_FAKE_CLI_DIALECT
  delete process.env.COVAN_FAKE_CLI_LOG

  db.deleteBot(cliBot.id)
  db.deleteBot(unsupportedBot.id)
  db.deleteBot(claudeBot.id)
}

console.log('\n[2] 注入 mock provider + bot A/B/C')
const provider = db.saveProvider({ name: 'Mock Provider', kind: 'mock' })
assert(provider.kind === 'mock', 'mock provider 已保存')
const lmStudio = db.saveProvider({
  name: 'LM Studio',
  kind: 'lm-studio',
  base_url: 'http://localhost:1234/api/v1/chat',
})
assert(
  lmStudio.base_url === 'http://localhost:1234/v1',
  'LM Studio 地址已规范化为 /v1',
)
const kimi = db.saveProvider({ name: 'Kimi', kind: 'kimi' })
const botA = db.createBot({
  name: '架构师老A',
  description: '架构设计师',
  provider_id: provider.id,
  is_coordinator: true,
})
const botB = db.createBot({
  name: '测试员小B',
  description: '端到端测试',
  provider_id: provider.id,
})
const botC = db.createBot({
  name: '产品经理小C',
  description: '产品视角',
  provider_id: provider.id,
})
const kimiBot = db.createBot({ name: 'Kimi Bot', provider_id: kimi.id })
assert(botB.reasoning_effort === 'medium', '普通 Bot 默认使用中等推理')
assert(botB.max_tokens === 1_000_000, '普通 Bot 默认最大输出为 1M Token')
assert(botB.response_decision_strategy === 'auto', 'Bot 默认自动优先使用可用的 Jev 响应决策')
assert(kimiBot.reasoning_effort === 'medium', 'Kimi Bot 默认也使用中等推理')
assert(kimiBot.max_tokens === 1_000_000, 'Kimi Bot 默认最大输出为 1M Token')
db.deleteBot(kimiBot.id)

console.log('\n[2a] Agent 主页：受校验的 OpenUI 布局与持久化')
{
  const fallbackHome = agentHome.getAgentHome(botA.id)
  assert(
    fallbackHome.isFallback && fallbackHome.content.includes('GoalsBoard()') && !fallbackHome.generatedAt,
    '首次读取返回不含业务数据的本地主页模板',
  )
  const generatedHome = await agentHome.regenerateAgentHome(botA.id)
  assert(
    !generatedHome.isFallback && generatedHome.content.includes('```openui-lang') && generatedHome.content.includes('GoalsBoard()'),
    'Bot 生成的主页经 OpenUI 校验后写入 SQLite',
  )
  const restoredHome = agentHome.getAgentHome(botA.id)
  assert(
    restoredHome.content === generatedHome.content && restoredHome.generatedAt === generatedHome.generatedAt,
    '重新读取复用已保存主页而不依赖聊天记录',
  )
}

const largeBudgetBot = db.createBot({ name: '1M 输出预算', provider_id: provider.id, max_tokens: 1_000_000 })
assert(largeBudgetBot.max_tokens === 1_000_000, '新建 Bot 可保存 1M 输出预算')
db.updateBot(largeBudgetBot.id, { max_tokens: 8192 })
db.updateBot(largeBudgetBot.id, { description: '保留旧预算' })
assert(db.getBot(largeBudgetBot.id).max_tokens === 8192, '默认值改为 1M 后，已有 Bot 的 8192 配置保持不变')
db.updateBot(largeBudgetBot.id, { max_tokens: 64 })
db.updateBot(largeBudgetBot.id, { max_tokens: 1_000_000 })
assert(db.getBot(largeBudgetBot.id).max_tokens === 1_000_000, '编辑 Bot 可保存 1M 输出预算')
for (const value of [63, 1_000_001, 64.5, NaN, Infinity]) {
  let rejected = false
  try { db.updateBot(largeBudgetBot.id, { max_tokens: value }) } catch { rejected = true }
  assert(rejected && db.getBot(largeBudgetBot.id).max_tokens === 1_000_000, `拒绝非法输出预算 ${value} 且保留原配置`)
}
db.deleteBot(largeBudgetBot.id)
for (const bot of [botA, botB, botC])
  db.updateBot(bot.id, { response_decision_strategy: 'llm' })
assert(db.listBots().length === 3, '3 个 bot 已创建')
workspace.ensureWorkspace(botA.id)
assert(
  fs.existsSync(path.join(userData, 'workspaces', botA.id)),
  'bot A 工作区目录已创建',
)
{
  const tools = workspace.createWorkspaceTools(botA.id)
  const read = tools.find((tool) => tool.name === 'workspace_read')
  const write = tools.find((tool) => tool.name === 'workspace_write')
  const signal = new AbortController().signal
  let absoluteRejected = false
  try {
    await write.execute(
      'absolute-path',
      { path: path.join(tmp, 'escape.txt'), content: '不应写入' },
      signal,
    )
  } catch {
    absoluteRejected = true
  }
  assert(absoluteRejected, '工作区工具拒绝绝对路径')

  const outside = path.join(tmp, 'outside.txt')
  const link = path.join(workspace.botWorkspaceDir(botA.id), 'outside-link.txt')
  fs.writeFileSync(outside, '工作区外的内容')
  fs.symlinkSync(outside, link)
  let symlinkRejected = false
  try {
    await read.execute('symlink-path', { path: 'outside-link.txt' }, signal)
  } catch {
    symlinkRejected = true
  }
  assert(symlinkRejected, '工作区工具拒绝符号链接逃逸')
}

console.log('\n[3] 建群（默认顺序回复）并发送用户消息')
const group = db.createGroup('冒烟讨论组', [botA.id, botB.id, botC.id])
assert(group.type === 'group', '群聊已创建')
assert(group.reply_mode === 'sequential', '新群默认使用顺序回复')
assert(
  typeof group.background_image === 'string' &&
    group.background_image.endsWith('.png'),
  '新群随机分配群聊背景',
)
const t0 = Date.now()
await orchestrator.sendUserMessage(
  group.id,
  '大家觉得这个新功能怎么做比较好？',
  [],
)
console.log(
  `  （3 个 mock bot 串行发言耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`,
)

const msgs = db.listMessages(group.id, undefined, 100)
const firstBotReply = msgs.find((message) => message.sender_type === 'bot' && message.status === 'done')
const groupReport = diagnostics.getDiagnosticReport(`covan-debug:v1:${firstBotReply.id}`)
assert(
  groupReport.events.some((event) => event.event === 'completion.started' && event.fields.operation === 'group_reply_decision') &&
    groupReport.events.some((event) => event.event === 'group.reply_decision' && ['reply', 'skip', 'forced_reply'].includes(event.fields.outcome)),
  '群聊判断模型调用及决策结果通过轮次追踪 ID 汇入回复诊断报告',
)
assert(
  msgs.some((m) => m.sender_type === 'user' && m.content.includes('新功能')),
  '用户消息已落库',
)
assert(
  !msgs.some(
    (m) =>
      m.sender_type === 'system' &&
      (m.content.includes('依次发言') || m.content.includes('已发消息给')),
  ),
  '不在聊天记录中插入回复机制提示',
)
for (const [label, bot] of [
  ['A', botA],
  ['B', botB],
  ['C', botC],
]) {
  const done = msgs.filter(
    (m) =>
      m.sender_type === 'bot' &&
      m.sender_bot_id === bot.id &&
      m.status === 'done' &&
      m.content.length > 0,
  )
  assert(
    done.length > 0,
    `bot ${label}（${bot.name}）产生 done 消息：「${done[0]?.content.slice(0, 30) ?? ''}…」`,
  )
}
assert(
  events.some((e) => e.type === 'agent-activity' && e.state === 'preparing'),
  '推送了 Agent 准备回复状态',
)
assert(
  events.some((e) => e.type === 'agent-activity' && e.state === 'speaking'),
  '推送了 Agent 正在回复状态',
)
assert(
  events.some((e) => e.type === 'message-delta'),
  '推送了 message-delta 事件',
)
assert(
  events.some((e) => e.type === 'message-done'),
  '推送了 message-done 事件',
)
assert(
  events.some((e) => e.type === 'chat-updated'),
  '推送了 chat-updated 事件',
)
const chatAfter = db.getChat(group.id)
assert(chatAfter.last_message_at > 0, 'last_message_at 已更新')

console.log('\n[3b] 顺序回复 + @mention 强制首位')
{
  events.length = 0
  const g2 = db.createGroup(
    '协调者冒烟组',
    [botA.id, botB.id, botC.id],
    botA.id,
  )
  assert(g2.coordinator_bot_id === botA.id, '协调者已设置')
  await orchestrator.sendUserMessage(g2.id, '请 @测试员小B 先说下风险', [
    botB.id,
  ])
  const m2 = db.listMessages(g2.id, undefined, 100)
  const botMsgs = m2.filter(
    (m) => m.sender_type === 'bot' && m.status === 'done',
  )
  assert(
    botMsgs.length >= 2,
    `成员判断后至少 2 个 bot 发言（实际 ${botMsgs.length}）`,
  )
  assert(
    botMsgs[0]?.sender_bot_id === botB.id,
    '@mention 的 bot B 被强制排在首位发言',
  )
}

console.log('\n[3c] 主动回复：并发判断 + 思考中插入新消息')
{
  events.length = 0
  const active = db.createGroup('主动回复冒烟组', [botA.id, botB.id, botC.id])
  db.updateChat(active.id, { replyMode: 'active' })
  assert(db.getChat(active.id).reply_mode === 'active', '可切换为主动回复')
  const running = orchestrator.sendUserMessage(
    active.id,
    '第一条：你们怎么看？',
    [],
  )
  await sleep(5)
  await orchestrator.sendUserMessage(active.id, '补充：请优先考虑可靠性。', [])
  await running
  const activeMessages = db.listMessages(active.id, undefined, 100)
  assert(
    activeMessages.filter((message) => message.sender_type === 'user')
      .length === 2,
    '思考中的新消息会立即落库',
  )
  assert(
    activeMessages.filter(
      (message) => message.sender_type === 'bot' && message.status === 'done',
    ).length === 3,
    '三位成员并发判断后完成回复',
  )
  const preparing = events.filter(
    (event) => event.type === 'agent-activity' && event.state === 'preparing',
  )
  assert(preparing.length >= 6, '新消息使尚未完成的三个判断重新开始')
}

console.log('\n[3d] 顺序回复：思考中插入新消息并更新当前成员上下文')
{
  events.length = 0
  const sequential = db.createGroup('顺序插话冒烟组', [botA.id, botB.id])
  const running = orchestrator.sendUserMessage(
    sequential.id,
    '第一条：请评估这个方案。',
    [],
  )
  await sleep(5)
  await orchestrator.sendUserMessage(
    sequential.id,
    '补充：先回答可靠性。',
    [botA.id],
  )
  await running
  const messages = db.listMessages(sequential.id, undefined, 100)
  assert(
    messages.filter((message) => message.sender_type === 'user').length === 2,
    '顺序模式思考中的新消息会立即落库',
  )
  const firstReply = messages.find(
    (message) => message.sender_type === 'bot' && message.status === 'done',
  )
  assert(
    firstReply?.content.includes('补充：先回答可靠性'),
    '正在思考的顺序成员用补充消息重新判断并回复',
  )
  const preparing = events.filter(
    (event) =>
      event.type === 'agent-activity' &&
      event.botId === botA.id &&
      event.state === 'preparing',
  )
  assert(preparing.length >= 2, '顺序成员的过期判断被取消并重新开始')
}

console.log('\n[4] 单聊（dm）直调')
const dm = db.createDm(botB.id)
db.updateChat(dm.id, {
  backgroundImage: '03-starry-night-milky-way.png',
})
assert(
  db.getChat(dm.id).background_image === '03-starry-night-milky-way.png',
  'dm 可设置聊天背景',
)
db.updateChat(dm.id, { backgroundImage: '' })
assert(db.getChat(dm.id).background_image === '', 'dm 可清除聊天背景')
await orchestrator.sendUserMessage(dm.id, '帮我看看这个用例怎么写', [])
const dmMsgs = db.listMessages(dm.id, undefined, 50)
assert(
  dmMsgs.some((m) => m.sender_bot_id === botB.id && m.status === 'done'),
  'dm 中 bot B 产生 done 消息',
)

console.log('\n[4a] 新话题：保留历史、压缩摘要并切断原文上下文')
{
  const before = db.listMessages(dm.id, undefined, 100)
  const beforeIds = new Set(before.map((message) => message.id))
  const initialState = orchestrator.getChatTopicState(dm.id)
  assert(initialState.current_message_count >= 2, '新话题前统计当前上下文消息')
  const result = await orchestrator.startChatTopic(dm.id)
  const after = db.listMessages(dm.id, undefined, 100)
  const nextState = orchestrator.getChatTopicState(dm.id)
  assert(
    result.marker.sender_type === 'system' &&
      result.marker.system_kind === 'topic_boundary' &&
      after.some((message) => message.id === result.marker.id),
    '创建可见的新话题分界消息',
  )
  assert(
    [...beforeIds].every((id) => after.some((message) => message.id === id)),
    '开始新话题不会删除历史消息',
  )
  assert(
    result.topic.summary.length > 0 &&
      nextState.current_message_count === 0 &&
      db.listCurrentTopicMessages(dm.id, 30).length === 0,
    '旧话题保存摘要且当前模型原文上下文归零',
  )
  await orchestrator.sendUserMessage(dm.id, '新话题里的第一条消息', [])
  const current = db.listCurrentTopicMessages(dm.id, 30)
  assert(
    current.some((message) => message.content.includes('新话题里的第一条')) &&
      current.every((message) => !beforeIds.has(message.id)),
    '边界后的消息独立进入新上下文',
  )
  const topicEvents = events.filter(
    (event) =>
      event.type === 'system-message' && event.message.id === result.marker.id,
  )
  assert(topicEvents.length === 1, '新话题边界通过实时事件推送到 UI')
  const topicLog = fs.readFileSync(
    path.join(userData, 'logs', 'observability.jsonl'),
    'utf8',
  )
  assert(
    topicLog.includes('chat.topic.summary.started') &&
      topicLog.includes('chat.topic.started'),
    '新话题摘要与边界写入可观测日志',
  )

  const topicGroup = db.createGroup('群聊新话题冒烟', [botA.id])
  db.insertMessage({
    chat_id: topicGroup.id,
    sender_type: 'user',
    content: '群聊旧话题的目标与约束',
  })
  db.insertMessage({
    chat_id: topicGroup.id,
    sender_type: 'bot',
    sender_bot_id: botA.id,
    content: '群聊旧话题已有一个结论',
  })
  db.updateChatSummary(topicGroup.id, '旧滚动摘要')
  const groupTopicResult = await orchestrator.startChatTopic(topicGroup.id)
  assert(
    groupTopicResult.topic.previous_message_count === 2 &&
      db.getChat(topicGroup.id).context_summary === '' &&
      db.listCurrentTopicMessages(topicGroup.id, 5).length === 0,
    '群聊同样创建话题边界，并从新话题重新计算滚动摘要',
  )
  db.deleteChat(topicGroup.id)

  const unconfigured = db.createBot({ name: '无摘要模型' })
  const failedTopicChat = db.createDm(unconfigured.id)
  db.insertMessage({
    chat_id: failedTopicChat.id,
    sender_type: 'user',
    content: '摘要失败时必须保留原状',
  })
  const failedBefore = db.listMessages(failedTopicChat.id).length
  let topicFailed = false
  try {
    await orchestrator.startChatTopic(failedTopicChat.id)
  } catch {
    topicFailed = true
  }
  assert(
    topicFailed &&
      db.getLatestChatTopic(failedTopicChat.id) === null &&
      db.listMessages(failedTopicChat.id).length === failedBefore,
    '摘要模型失败时不写入半成品话题或系统分界',
  )
  db.deleteBot(unconfigured.id)
}

console.log('\n[4a-cli] CLI Bot 压缩摘要使用 Provider 默认模型')
{
  const requests = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    requests.push(body)
    res.setHeader('Content-Type', 'application/json')
    if (!['deepseek-v4-flash', 'api-custom-model'].includes(body.model)) {
      res.statusCode = 400
      res.end(JSON.stringify({ error: { message: 'CLI model sent to Provider' } }))
      return
    }
    res.setHeader('Content-Type', 'text/event-stream')
    res.end(`data: ${JSON.stringify({
      id: 'topic-summary', object: 'chat.completion.chunk', model: body.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '目标已确认，下一步继续验证。' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const provider = db.saveProvider({
    name: '摘要模型 loopback', kind: 'openai-compatible', api_key: 'smoke-only',
    base_url: `http://127.0.0.1:${server.address().port}/v1`,
    default_model: 'deepseek-v4-flash',
  })
  const bots = []
  try {
    for (const [backend, explicit] of [['codex-cli', true], ['claude-cli', false]]) {
      const bot = db.createBot({
        name: `摘要 ${backend}`, backend,
        provider_id: explicit ? provider.id : undefined,
        model: backend === 'codex-cli' ? 'gpt-5.6-luna' : 'sonnet',
      })
      bots.push(bot)
      const chat = explicit ? db.createGroup('CLI 摘要回归', [bot.id]) : db.createDm(bot.id)
      const source = db.insertMessage({ chat_id: chat.id, sender_type: 'user', content: '保留这一条原始目标' })
      const result = await orchestrator.startChatTopic(chat.id)
      assert(
        result.topic.summary.includes('目标已确认') && requests.at(-1).model === provider.default_model,
        `${backend} ${explicit ? '显式' : '默认'} Provider 压缩上下文时不发送 CLI 模型名`,
      )
      assert(
        db.getBot(bot.id).model === bot.model &&
          db.getBot(bot.id).provider_id === bot.provider_id &&
          db.listMessages(chat.id).some((message) => message.id === source.id),
        '摘要只改变调用视图，保留 CLI 配置与完整历史',
      )
    }
    const apiBot = db.createBot({ name: 'API 自选摘要模型', provider_id: provider.id, model: 'api-custom-model' })
    bots.push(apiBot)
    await agentRuntime.completeOnce(apiBot, '概括目标', '目标已确认', { reasoning: 'off' })
    assert(requests.at(-1).model === 'api-custom-model', 'API Bot 的自选模型不被 Provider 默认模型覆盖')
    const largeApiBot = db.updateBot(apiBot.id, { max_tokens: 1_000_000 })
    await agentRuntime.completeOnce(largeApiBot, '本地预算回归', '验证模型上限', { reasoning: 'off' })
    assert(requests.at(-1).max_tokens === 131072, '内部 completion 将 1M 配置限制到模型声明的最大输出')
    await agentRuntime.completeOnce(largeApiBot, '本地预算回归', '验证用途预算', { reasoning: 'off', maxTokens: 1024 })
    assert(requests.at(-1).max_tokens === 1024, '内部摘要等用途仍遵守显式的小输出预算')
    let streamDone = false
    let streamError = ''
    await agentRuntime.runAgent('local-budget-regression', largeApiBot,
      [{ role: 'user', content: '验证流式输出预算', timestamp: Date.now() }],
      { onDelta() {}, onDone() { streamDone = true }, onError(error) { streamError = error } },
    )
    assert(streamDone && !streamError && requests.at(-1).max_tokens === 131072, '普通流式 Agent 同样限制到模型最大输出并正常完成')
    assert(db.getBot(apiBot.id).max_tokens === 1_000_000, '请求预算适配不改写用户保存的 1M 配置')
    const cliBot = bots[0]
    db.saveProvider({ ...provider, default_model: '' })
    const failedChat = db.createDm(cliBot.id)
    db.insertMessage({ chat_id: failedChat.id, sender_type: 'user', content: '默认摘要模型缺失时保留原状' })
    const before = requests.length
    let failed = false
    try { await orchestrator.startChatTopic(failedChat.id) } catch (error) {
      failed = error.message.includes('未配置模型')
    }
    assert(
      failed && requests.length === before && db.getLatestChatTopic(failedChat.id) === null &&
        db.listMessages(failedChat.id).length === 1 && db.getBot(cliBot.id).model === cliBot.model,
      'Provider 缺少默认模型时不借用 CLI 模型、不发请求、不写入话题边界',
    )
  } finally {
    for (const bot of bots) db.deleteBot(bot.id)
    db.deleteProvider(provider.id)
    await new Promise((resolve) => server.close(resolve))
  }
}

console.log('\n[4b] 定时 Agent 任务：持久化、工具与消息投递')
{
  const appTools = agentTools.createAppTools(botB.id, dm.id)
  const names = appTools.map((tool) => tool.name)
  assert(
    ['list_scheduled_tasks', 'create_scheduled_task', 'update_scheduled_task', 'delete_scheduled_task'].every((name) => names.includes(name)),
    '普通会话向 Agent 暴露定时任务查看与管理工具',
  )
  const create = appTools.find((tool) => tool.name === 'create_scheduled_task')
  const created = await create.execute(
    'scheduled-tool-create',
    {
      title: '工具创建的日报',
      prompt: '整理今天的测试重点，给出三条清单。',
      schedule: 'cron',
      cron: '0 9 * * *',
      timezone: 'Asia/Shanghai',
    },
    new AbortController().signal,
  )
  const createdTask = JSON.parse(created.content[0].text)
  assert(
    createdTask.bot_id === undefined &&
      db.listScheduledTasks(botB.id).some((task) => task.id === createdTask.id && task.model === ''),
    'Agent 工具创建的任务绑定当前 Bot 并默认继承模型',
  )

  const task = db.saveScheduledTask({
    bot_id: botB.id,
    chat_id: dm.id,
    title: '立即执行回归',
    prompt: '只用一句话汇报定时任务完成。',
    schedule: 'once',
    run_at: Date.now() + 60 * 60 * 1000,
    timezone: 'Asia/Shanghai',
    model: 'mock-scheduled-override',
    enabled: false,
  })
  assert(
    task.next_run_at === null && task.model === 'mock-scheduled-override',
    '暂停任务保留模型覆盖但不安排下次执行',
  )
  const before = db.listMessages(dm.id, undefined, 100).length
  const eventStart = events.length
  scheduledTasks.startScheduledTasks(orchestrator.runScheduledTask)
  await scheduledTasks.runScheduledTaskNow(task.id)
  const finished = db.getScheduledTask(task.id)
  const scheduledMessages = db.listMessages(dm.id, undefined, 100)
  assert(
    finished.last_status === 'done' && !finished.enabled,
    '单次任务手动执行后写入完成状态且保持暂停',
  )
  assert(
    scheduledMessages.length === before + 1 &&
      scheduledMessages.at(-1).sender_bot_id === botB.id &&
      scheduledMessages.at(-1).status === 'done',
    '定时任务完成后只投递 Bot 真实结果，不插入伪造用户消息',
  )
  const scheduledReport = diagnostics.getDiagnosticReport(`covan-debug:v1:${scheduledMessages.at(-1).id}`)
  assert(
    scheduledReport.events.some((event) => event.event === 'scheduled_task.triggered' && event.fields.trigger_source === 'manual') &&
      scheduledReport.events.some((event) => event.event === 'scheduled_task.completed' && event.fields.result_status === 'done') &&
      scheduledReport.events.some((event) => event.event === 'agent.dispatch.started' && event.fields.scheduled_task_id === observability.anonymizeId(task.id)),
    '定时任务触发、Agent 执行和完成状态通过追踪 ID 汇入同一诊断报告',
  )
  const taskLog = fs.readFileSync(path.join(userData, 'logs', 'observability.jsonl'), 'utf8')
  assert(
    !/整理今天的测试重点|只用一句话汇报定时任务完成/.test(taskLog),
    '定时任务提示词不写入观测日志',
  )
  const taskStates = events
    .slice(eventStart)
    .filter((event) => event.type === 'scheduled-task-state')
    .map((event) => event.running)
  assert(
    JSON.stringify(taskStates) === '[true,false]',
    '定时任务运行状态成对发送，渲染可可靠结束回复状态',
  )
  scheduledTasks.stopScheduledTasks()
}

console.log('\n[4b] 单聊自然追问：有价值才续发，过滤元话术，最多两条')
const naturalDm = db.createDm(botC.id)
await orchestrator.sendUserMessage(
  naturalDm.id,
  '自然追问冒烟：帮我一起想想方案',
  [],
)
const naturalReplies = db
  .listMessages(naturalDm.id, undefined, 20)
  .filter((m) => m.sender_type === 'bot' && m.status === 'done')
assert(
  naturalReplies.length === 2 &&
    naturalReplies[1].content === '你更想先确认目标还是约束？',
  `自然追问只追加一条具体消息并及时停止（实际 ${naturalReplies.length} 条）`,
)
const countDoneBotMessages = (chatId) =>
  db
    .listMessages(chatId, undefined, 50)
    .filter((m) => m.sender_type === 'bot' && m.status === 'done').length
const beforeGuarded = countDoneBotMessages(naturalDm.id)
await orchestrator.sendUserMessage(
  naturalDm.id,
  '自然追问元话术防护',
  [],
)
assert(
  countDoneBotMessages(naturalDm.id) === beforeGuarded + 1,
  '包含“下一条来了”等调度元话术的候选不会发送',
)
const beforeCapped = countDoneBotMessages(naturalDm.id)
await orchestrator.sendUserMessage(
  naturalDm.id,
  '自然追问两条上限冒烟',
  [],
)
assert(
  countDoneBotMessages(naturalDm.id) === beforeCapped + 3,
  `有两个具体承接点时最多追加两条（新增 ${countDoneBotMessages(naturalDm.id) - beforeCapped} 条）`,
)
const beforeSegmented = countDoneBotMessages(naturalDm.id)
await orchestrator.sendUserMessage(naturalDm.id, '自然分段冒烟', [])
const segmentedReplies = db
  .listMessages(naturalDm.id, undefined, 3)
  .filter((m) => m.sender_type === 'bot' && m.status === 'done')
assert(
  countDoneBotMessages(naturalDm.id) === beforeSegmented + 3 &&
    segmentedReplies.map((message) => message.content).join('|') ===
      '第一段先说明目标。|第二段提供约束。|第三段给出下一步。',
  '较长回答按三个不重复的语义段依次发送',
)
db.setSetting('natural_follow_up', '0')
const beforeDisabled = countDoneBotMessages(naturalDm.id)
await orchestrator.sendUserMessage(
  naturalDm.id,
  '自然追问冒烟：关闭后只要一条',
  [],
)
assert(
  countDoneBotMessages(naturalDm.id) === beforeDisabled + 1,
  '关闭自然追问后不再附加消息',
)
db.setSetting('natural_follow_up', '1')

console.log('\n[4c] Jev 响应策略：自动优先、群聊判断、自然续发与低置信度回退')
{
  const jevBot = db.createBot({
    name: 'Jev 决策测试',
    provider_id: provider.id,
  })
  const jevGroup = db.createGroup('Jev 群聊', [jevBot.id])
  await orchestrator.sendUserMessage(jevGroup.id, 'Jev 群聊冒烟', [])
  const groupReplies = db
    .listMessages(jevGroup.id, undefined, 20)
    .filter((message) => message.sender_type === 'bot' && message.status === 'done')
  assert(groupReplies.length === 1, '自动策略在 Jev 已配置时优先使用 Jev')

  const jevDm = db.createDm(jevBot.id)
  await orchestrator.sendUserMessage(jevDm.id, 'Jev 续发冒烟', [])
  const dmReplies = db
    .listMessages(jevDm.id, undefined, 20)
    .filter((message) => message.sender_type === 'bot' && message.status === 'done')
  assert(
    dmReplies.length === 2 &&
      dmReplies[1].content === '还需要你确认更看重速度还是稳定性？',
    'Jev 只决定续发，正文仍由 Bot 当前生成模型起草',
  )

  const fallbackGroup = db.createGroup('Jev 低置信度', [jevBot.id])
  await orchestrator.sendUserMessage(fallbackGroup.id, 'Jev 低置信度冒烟', [])
  const fallbackReplies = db
    .listMessages(fallbackGroup.id, undefined, 20)
    .filter((message) => message.sender_type === 'bot' && message.status === 'done')
  assert(fallbackReplies.length === 1, 'Jev 低置信度时回退传统 LLM 判断')
  const log = fs.readFileSync(
    path.join(userData, 'logs', 'observability.jsonl'),
    'utf8',
  )
  assert(
    log.includes('decision.jev.completed') &&
      log.includes('low_confidence') &&
      !log.includes('jev-smoke-secret'),
    'Jev 决策、置信度回退可观测且日志不含 API Key',
  )
  assert(
    jevRequests.every(
      (request) =>
        request.authorization === 'Bearer jev-smoke-secret' &&
        request.question.type === 'choice',
    ),
    'Jev 请求使用加密配置中的密钥和 Choice 结构化问题',
  )
  db.deleteBot(jevBot.id)
}

console.log('\n[4d] 群聊延展讨论：有新观点才进入下一轮，最多五轮')
const multiRound = db.createGroup('多轮冒烟组', [botA.id, botC.id])
await orchestrator.sendUserMessage(
  multiRound.id,
  '多轮冒烟：请大家就方案继续讨论并互相补充',
  [],
)
const multiRoundReplies = db
  .listMessages(multiRound.id, undefined, 30)
  .filter((m) => m.sender_type === 'bot' && m.status === 'done')
assert(
  multiRoundReplies.length === 4,
  `两位成员完成首轮和一轮延展（实际 ${multiRoundReplies.length} 条）`,
)
assert(multiRoundReplies.length <= 2 * 5, '群聊延展严格受最多五轮上限约束')
const roundCap = db.createGroup('五轮上限组', [botA.id])
await orchestrator.sendUserMessage(
  roundCap.id,
  '五轮上限冒烟：请持续提出新的具体方案',
  [],
)
assert(
  db
    .listMessages(roundCap.id, undefined, 12)
    .filter((m) => m.sender_type === 'bot' && m.status === 'done').length === 5,
  '即使每轮都决定回复，群聊也在第 5 轮硬停止',
)

console.log('\n[4e] 本地 CLI Bot 的群聊判断：Jev / 默认 Provider / CLI 自身')
{
  const fakeCli = path.join(root, 'scripts/fixtures', 'fake-cli.mjs')
  // [1e] 结束时会清掉环境变量，这里重新指定一个独立的调用日志。
  const cliLog = path.join(tmp, 'cli-group-calls.jsonl')
  process.env.COVAN_FAKE_CLI_LOG = cliLog
  const cliCallCount = () =>
    fs.existsSync(cliLog)
      ? fs.readFileSync(cliLog, 'utf8').trim().split('\n').filter(Boolean).length
      : 0
  const cliReplies = (chatId) =>
    db
      .listMessages(chatId, undefined, 20)
      .filter((message) => message.sender_type === 'bot' && message.status === 'done')

  // 已配置 Jev：auto 策略用 Jev 判断，不需要判断用 Provider，也不为判断启动 CLI。
  const jevJudge = db.createBot({
    name: 'CLI 用 Jev 判断',
    backend: 'codex-cli',
    cli_path: fakeCli,
    model: 'gpt-5.6-sol',
  })
  assert(jevJudge.response_decision_strategy === 'auto', 'CLI Bot 默认使用自动判断策略')
  assert(
    orchestrator.judgeProviderFor(jevJudge) === null,
    '没有带 Key 的 Provider 时不会强行挑一个默认判断 Provider',
  )
  const jevGroup = db.createGroup('CLI Jev 判断群', [jevJudge.id])
  const beforeJev = cliCallCount()
  await orchestrator.sendUserMessage(jevGroup.id, '这条没有点名也要判断', [])
  assert(cliReplies(jevGroup.id).length === 1, 'auto 策略在 Jev 已配置时让 CLI Bot 正常参与群聊')
  assert(
    cliCallCount() === beforeJev + 1,
    'Jev 判断不为判断额外启动 CLI，只发起一次正文调用',
  )
  db.deleteBot(jevJudge.id)

  // 没有 Jev、没有带 Key 的 Provider：用 CLI 自身判断首轮（一次判断 + 一次正文）。
  const sealed = db.getSetting('jev_api_key_sealed')
  db.setSetting('jev_api_key_sealed', '')
  try {
    const cliJudge = db.createBot({
      name: 'CLI 自身判断',
      backend: 'codex-cli',
      cli_path: fakeCli,
      model: 'gpt-5.6-sol',
      response_decision_strategy: 'llm',
    })
    const cliGroup = db.createGroup('CLI 自身判断群', [cliJudge.id])
    const beforeCli = cliCallCount()
    await orchestrator.sendUserMessage(cliGroup.id, '没有 Provider 也要判断', [])
    assert(cliReplies(cliGroup.id).length === 1, '没有判断用 Provider 时用 CLI 自身判断并发言')
    assert(
      cliCallCount() === beforeCli + 2,
      'CLI 自身判断：一次判断调用加一次正文调用',
    )
    assert(
      db.listMessages(cliGroup.id, undefined, 20).filter((m) => m.sender_type === 'bot').length === 1,
      'CLI 自身判断只用于首轮，延展轮不再启动 CLI',
    )
    await orchestrator.sendUserMessage(cliGroup.id, '@CLI 自身判断 你来', [cliJudge.id])
    assert(cliCallCount() > beforeCli + 2, '@提及仍然强制发言')
    db.deleteBot(cliJudge.id)
  } finally {
    db.setSetting('jev_api_key_sealed', sealed ?? '')
  }

  // 判断用 Provider 回退：显式为空时挑第一个带 Key 的非 mock Provider。
  const keyed = db.saveProvider({
    name: '判断用 DeepSeek',
    kind: 'deepseek',
    api_key: 'sk-smoke-judge',
    default_model: 'deepseek-v4-flash',
  })
  const withDefault = db.createBot({
    name: 'CLI 默认判断',
    backend: 'codex-cli',
    cli_path: fakeCli,
    model: 'gpt-5.6-sol',
  })
  assert(
    orchestrator.judgeProviderFor(withDefault)?.id === keyed.id,
    '没有显式判断用 Provider 时回退到带 Key 的默认 Provider',
  )
  assert(
    orchestrator.completionBot(withDefault, keyed).model === '',
    '借用判断用 Provider 时使用它的默认模型，不透传 CLI 的模型名',
  )
  db.deleteProvider(keyed.id)
  db.deleteBot(withDefault.id)
  delete process.env.COVAN_FAKE_CLI_LOG
}

console.log('\n[5] 记忆：手动写入 + 自动提取触发')
const mem = db.addMemory(botA.id, '用户偏好中文交流', 'preference', 'manual')
assert(
  db.listMemories(botA.id).some((m) => m.id === mem.id),
  '记忆表手动写入成功',
)
// 每个 bot 每 chat 累计 10 条新消息触发自动提取；每轮群发言 = 1(user)+3(bot) = 4 条
// 再来 2 轮群消息（累计 4+4+4=12 >= 10）触发 mock 自动提取
events.length = 0
await orchestrator.sendUserMessage(group.id, '第二轮：成本方面呢？', [])
await orchestrator.sendUserMessage(group.id, '第三轮：排期怎么走？', [])
await sleep(500) // 自动提取是后台异步的
const autoMems = db.listMemories(botB.id).filter((m) => m.source === 'auto')
assert(autoMems.length > 0, `bot B 自动记忆已写入（${autoMems.length} 条）`)

console.log('\n[6] listChats 摘要')
const summaries = db.listChats()
const g = summaries.find((c) => c.id === group.id)
assert(
  !!g &&
    g.member_bots.length === 3 &&
    g.preview.length > 0 &&
    g.background_image === group.background_image,
  '群聊摘要含成员、预览与背景',
)

console.log('\n[7] 邀请 / 隐藏 / 清空聊天记录')
const botD = db.createBot({ name: '研究员小D', provider_id: provider.id })
db.addChatMembers(group.id, [botD.id])
assert(
  db.listMemberBots(group.id).some((bot) => bot.id === botD.id),
  '邀请 Bot 加入既有群聊',
)
db.clearChatMessages(dm.id)
assert(
  db.listMessages(dm.id, undefined, 10).length === 0 &&
    db.getChat(dm.id).last_message_at === 0 &&
    db.getLatestChatTopic(dm.id) === null,
  '清空聊天记录不删除单聊，并同步清除话题边界',
)
db.hideChat(dm.id)
assert(
  !db.listChats().some((chat) => chat.id === dm.id),
  '隐藏单聊后不在列表显示',
)
assert(
  db.createDm(botB.id).id === dm.id &&
    db.listChats().some((chat) => chat.id === dm.id),
  '从我的 Bot 再次打开会恢复显示',
)

await runMemoryRegression(db, memory, assert, userData)

fs.rmSync(tmp, { recursive: true, force: true })
fs.rmSync(bundleDir, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\n冒烟失败：${failures} 项断言未通过`)
  process.exit(1)
}
console.log('\n冒烟通过 ✔')
process.exit(0)
