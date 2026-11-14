// Deterministic Electron regression: isolated background goals, steering, experts and recovery.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { expect } from '@playwright/test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'covan-goal-tasks-'))
const artifacts = path.join(root, 'artifacts', 'goal-tasks')
fs.mkdirSync(artifacts, { recursive: true })
const errors = [], requests = [], gates = new Map(), issued = [], failedOnce = new Set()
const textOf = (content) => typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('\n')
let app, page, fixture
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'fixture' }] }))
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw || '{}'); requests.push(body)
    const messages = body.messages ?? []
    const initial = messages.find((message) => message.role === 'user')
    const source = textOf(initial?.content)
    const user = textOf(messages.findLast((message) => message.role === 'user')?.content)
    const tools = messages.filter((message) => message.role === 'tool')
    const calls = messages.flatMap((message) => message.tool_calls ?? []).map((tool) => tool.function.name)
    const isGoal = source.startsWith('目标下一步「')
    const isExpert = source.startsWith('专家任务「')
    const title = source.match(/「([^」]+)」/)?.[1] ?? ''
    if (isGoal && title === '重试本轮错误' && !failedOnce.has(title)) { failedOnce.add(title); res.writeHead(400); return res.end(JSON.stringify({ error: { message: 'fixture retry failure' } })) }
    const call = (name, args, id) => ({ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
    let tool, content = '前台聊天正常回复。'
    if (isExpert) {
      if (source.includes('失败专家')) { res.writeHead(400); return res.end(JSON.stringify({ error: { message: 'fixture failure' } })) }
      if (!tools.length) tool = call('workspace_write', { path: 'expert.md', content: '# 专家定价报告\n需要核对的数据。' }, 'expert-file')
      else content = '专家已实际生成 expert.md，定价结论待核对。'
    } else if (isGoal) {
      const snapshot = JSON.parse(source.slice(source.indexOf('\n') + 1))
      if (title === '多专家队列' && calls.filter((name) => name === 'consult_goal_expert').length < 4) {
        const next = calls.filter((name) => name === 'consult_goal_expert').length + 1
        tool = call('consult_goal_expert', { bot_id: fixture.expert.id, request: `慢速专家/gated-${next}` }, `fanout-${next}`)
      }
      else if (title.includes('专家') && !tools.length) tool = call('consult_goal_expert', {
        bot_id: title.includes('越权') ? fixture.outsider.id : fixture.expert.id,
        request: title.includes('失败专家') ? '失败专家' : title.includes('慢速专家') ? '慢速专家' : '比较定价并生成报告',
      }, 'expert-request')
      else if (title.includes('重复专家') && tools.length === 1) tool = call('consult_goal_expert', { bot_id: fixture.expert.id, request: '比较定价并生成报告' }, 'expert-request')
      else if (title.includes('显式等待') && !calls.includes('wait_goal_experts')) tool = call('wait_goal_experts', {}, 'wait-experts')
      else if (!calls.includes('workspace_write')) tool = call('workspace_write', { path: 'research.md', content: `# ${snapshot.title}\n${user.includes('重点') ? user : '本任务独立成果'}` }, 'goal-file')
      else if (title.includes('等待补充') && !calls.includes('request_goal_input')) tool = call('request_goal_input', { question: '请补充预算上限' }, 'ask-input')
      else if (title.includes('阻塞任务') && !calls.includes('block_goal_task')) tool = call('block_goal_task', { reason: '需要用户提供可用数据' }, 'blocked-task')
      else content = title.includes('越权') ? '未配置的专家被拒绝，已完成可独立执行部分。' : '已保存 research.md；本轮结束，结论待核对。'
    } else if (user.includes('显示目标')) content = '```openui-lang\nroot = Card("目标", [board])\nboard = GoalsBoard()\n```'
    if (isGoal && messages.some((message) => textOf(message.content).includes('系统投递的真实专家报告')) && !tool) content = '主责已汇总真实专家报告与文件。'
    if (body.stream === false) {
      res.setHeader('Content-Type', 'application/json')
      return res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }))
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    send({ role: 'assistant' })
    const finish = () => { if (!res.destroyed) { if (tool) issued.push({ title, name: tool.function.name }); send(tool ? { tool_calls: [tool] } : { content }); send({}, tool ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n') } }
    const key = isGoal && title === '多专家队列' && calls.filter((name) => name === 'consult_goal_expert').length === 3 && !messages.some((message) => textOf(message.content).startsWith('系统恢复当前任务')) ? 'fanout-owner' : isGoal && title.startsWith('检查点') && tools.length && !messages.some((message) => textOf(message.content).startsWith('系统恢复当前任务')) ? `checkpoint:${title}` : isExpert && source.includes('慢速专家') && !tools.length ? `expert:${title}${source.match(/\/gated-\d/)?.[0] ?? ''}`
      : isGoal && title.startsWith('慢速') && !tools.length && user === source ? title
        : !isGoal && !isExpert && user === '前台慢速回复' ? 'foreground' : ''
    if (key) { gates.set(key, finish); res.on('close', () => gates.delete(key)) }
    else finish()
  } catch (error) { errors.push(String(error)); res.statusCode = 500; res.end() }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/v1`
async function launch() {
  const env = { ...process.env, ELECTRON_RENDERER_URL: '', COVAN_USER_DATA_DIR: profile, COVAN_FAKE_CLI_LOG: path.join(profile, 'fake-cli.jsonl'), COVAN_FAKE_CLI_DELAY_MS: '1500' }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [root], env })
  app.process().stderr.on('data', (chunk) => { if (/Uncaught Exception|UnhandledPromiseRejection|Unhandled rejection/.test(chunk.toString())) errors.push('Unexpected main-process exception') })
  page = await app.firstWindow(); page.on('pageerror', (error) => errors.push(error.message))
  await page.waitForFunction(() => !!window.covan)
  await page.emulateMedia({ reducedMotion: 'reduce' })
}
const goal = (id) => page.evaluate((id) => window.covan.getGoal(id), id)
const runs = () => page.evaluate((id) => window.covan.listGoalExecutions(id), fixture.chat.id)
const waitGoal = (id, state) => expect.poll(async () => (await goal(id)).execution?.status, { timeout: 20000 }).toBe(state)
const make = (title, experts = false) => page.evaluate(({ title, fixture, experts }) => window.covan.createGoal({ title, ownerAgentId: fixture.bot.id, collaboratorAgentIds: experts ? [fixture.expert.id] : [], sessionId: fixture.chat.id }), { title, fixture, experts })
const start = (id) => page.evaluate((id) => window.covan.runGoalNextStep(id), id)
const stop = (id) => page.evaluate((id) => window.covan.stopGoalExecution(id), id)
const waitGate = (key) => expect.poll(() => gates.has(key)).toBe(true)
const release = (key) => { assert.ok(gates.has(key), `gate exists: ${key}`); gates.get(key)() }

const quoteMessage = async (messageId) => {
  const row = page.locator(`[data-message-id="${messageId}"]`)
  await row.hover()
  await row.getByRole('button', { name: '引用回复', exact: true }).click()
  await expect(page.getByLabel('引用内容')).toContainText('继续此任务')
}
const sendQuoted = async (messageId, text) => {
  await quoteMessage(messageId)
  await page.getByRole('textbox', { name: '输入消息' }).fill(text)
  await page.getByRole('button', { name: '发送给此任务', exact: true }).click()
}
const followUp = (replyToMessageId, text, requestId, chatId = fixture.chat.id) => page.evaluate(
  ({ chatId, replyToMessageId, text, requestId }) => window.covan.sendGoalFollowUp(chatId, replyToMessageId, text, requestId),
  { chatId, replyToMessageId, text, requestId })
const foregroundRequests = () => requests.filter((body) => body.stream !== false && !['目标下一步「', '专家任务「'].some((prefix) => textOf(body.messages?.find((message) => message.role === 'user')?.content).startsWith(prefix))).length

try {
  await launch()
  fixture = await page.evaluate(async (base) => {
    await window.covan.setSetting('natural_follow_up', '0')
    const provider = await window.covan.saveProvider({ name: '本地模拟', kind: 'openai-compatible', base_url: base, default_model: 'fixture' })
    const bot = await window.covan.createBot({ name: '任务助手', provider_id: provider.id })
    const expert = await window.covan.createBot({ name: '定价专家', provider_id: provider.id })
    const outsider = await window.covan.createBot({ name: '未授权专家', provider_id: provider.id })
    const chat = await window.covan.createDm(bot.id)
    return { bot, expert, outsider, chat }
  }, base)
  await page.reload()
  await page.locator('aside').first().getByRole('button', { name: '任务助手', exact: true }).click()
  const priority = await make('已有任务优先响应')
  await start(priority.id); await waitGoal(priority.id, 'review')
  const priorityReply = (await goal(priority.id)).execution.messageId
  const first = await make('慢速任务甲'), second = await make('慢速任务乙')
  const runA = await start(first.id), runB = await start(second.id)
  assert.equal((await start(first.id)).id, runA.id)
  await waitGate(first.title); await waitGate(second.title)
  const duplicateEnv = { ...process.env, ELECTRON_RENDERER_URL: '', COVAN_USER_DATA_DIR: profile }
  delete duplicateEnv.ELECTRON_RUN_AS_NODE
  const duplicate = spawn(createRequire(import.meta.url)('electron'), [root], { env: duplicateEnv, stdio: 'ignore' })
  let duplicateTimer
  try {
    await new Promise((resolve, reject) => {
      duplicate.once('error', reject)
      duplicate.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Duplicate instance exited ${code}`)))
      duplicateTimer = setTimeout(() => reject(new Error('Duplicate instance did not exit')), 15000)
    })
  } finally { clearTimeout(duplicateTimer); if (duplicate.exitCode === null) duplicate.kill('SIGKILL') }
  assert.equal((await goal(first.id)).execution.status, 'running', 'Duplicate instance must not recover/pause the active profile')
  assert.equal((await goal(second.id)).execution.status, 'running')
  console.log('✓ Same-profile duplicate exits before database recovery and leaves original tasks running')
  const overCapacity = await make('容量保护')
  const queuedRun = await start(overCapacity.id)
  assert.equal(queuedRun.status, 'queued')
  assert.equal((await goal(overCapacity.id)).execution.queuePosition, 1)
  const priorityRequestIndex = requests.length
  await followUp(priorityReply, '已有任务的用户补充优先响应', 'priority-followup')
  assert.equal((await goal(priority.id)).execution.queuePosition, 1)
  assert.equal((await goal(overCapacity.id)).execution.queuePosition, 2)
  const canceledQueue = await make('取消队列不应开工')
  const canceledQueuedRun = await start(canceledQueue.id)
  assert.equal(canceledQueuedRun.status, 'queued')
  await page.evaluate((id) => window.covan.controlGoalExecution(id, 'stop'), canceledQueuedRun.id)
  await waitGoal(canceledQueue.id, 'stopped')
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '输入消息' }).fill('正常前台提问')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.locator('.message-bot').last()).toContainText('前台聊天正常回复')
  assert.equal((await goal(first.id)).execution.status, 'running')
  const inputA = page.getByLabel(`补充给${first.title}`, { exact: true })
  await inputA.fill('重点比较定价甲')
  await page.locator(`[data-execution-id="${runA.id}"]`).getByRole('button', { name: '补充要求', exact: true }).click()
  const extra = await page.evaluate(async (id) => {
    const first = await window.covan.sendGoalExecutionInput(id, '仅任务乙的要求', 'retry-input')
    const second = await window.covan.sendGoalExecutionInput(id, '仅任务乙的要求', 'retry-input')
    return [first, second]
  }, runB.id)
  assert.equal(extra[0].id, extra[1].id)
  await assert.rejects(() => page.evaluate((id) => window.covan.sendGoalExecutionInput(id, '不同内容', 'retry-input'), runB.id), /不同内容/)
  await page.reload()
  await expect(page.getByLabel(`补充给${first.title}`, { exact: true })).toBeVisible()
  await page.screenshot({ path: path.join(artifacts, 'concurrent-tasks.png') })
  release(first.title); await waitGoal(first.id, 'review')
  await waitGoal(priority.id, 'review')
  await waitGoal(overCapacity.id, 'review')
  const queuedPayloads = requests.slice(priorityRequestIndex)
  assert.ok(queuedPayloads.findIndex((body) => JSON.stringify(body.messages).includes(priority.id)) < queuedPayloads.findIndex((body) => JSON.stringify(body.messages).includes(overCapacity.id)), 'Human follow-up is processed before new queued goal')
  assert.equal((await goal(overCapacity.id)).execution.id, queuedRun.id)
  assert.equal((await goal(second.id)).execution.status, 'running')
  const firstPayloads = requests.filter((body) => JSON.stringify(body.messages).includes(first.id))
  assert.ok(firstPayloads.some((body) => JSON.stringify(body.messages).includes('重点比较定价甲')))
  assert.ok(firstPayloads.every((body) => !JSON.stringify(body.messages).includes('仅任务乙的要求')))
  assert.equal((await goal(first.id)).execution.status, 'review')
  await stop(second.id); await waitGoal(second.id, 'stopped')
  const result = await goal(first.id)
  assert.ok(result.artifacts.some((item) => item.path === `tasks/${runA.id}/research.md`))
  assert.ok((await runs()).find((run) => run.id === runA.id).inputs.every((input) => input.delivered))
  console.log('✓ Concurrent goals, available Composer, reload, targeted inputs, idempotence and isolated artifacts')

  const foregroundBefore = foregroundRequests()
  await quoteMessage(result.execution.messageId)
  await page.getByRole('textbox', { name: '输入消息' }).fill('引用补充只处理任务甲')
  await page.getByLabel('选择附件').setInputFiles([{ name: 'follow-up.txt', mimeType: 'text/plain', buffer: Buffer.from('Do not silently discard this attachment') }])
  await page.getByRole('button', { name: '发送给此任务', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('暂只支持文字')
  await expect(page.locator('.composer-document')).toHaveCount(1)
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue('引用补充只处理任务甲')
  await page.getByRole('button', { name: '移除附件：follow-up.txt', exact: true }).click()
  await page.getByRole('button', { name: '发送给此任务', exact: true }).click()
  await expect.poll(async () => (await goal(first.id)).execution.inputs.some((input) => input.text === '引用补充只处理任务甲' && input.delivered)).toBe(true)
  await waitGoal(first.id, 'review')
  const linkedMessages = await page.evaluate((id) => window.covan.listMessages(id), fixture.chat.id)
  const linked = linkedMessages.filter((message) => message.goal_input_execution_id === runA.id)
  assert.equal(linked.length, 1)
  assert.equal(linked[0].content, '引用补充只处理任务甲', 'Quoted body is not copied into new authorization')
  await expect(page.locator(`[data-message-id="${linked[0].id}"]`)).toContainText('任务补充 · 已送达')
  assert.equal(foregroundRequests(), foregroundBefore, 'Task follow-up starts no foreground generation')
  await quoteMessage(linked[0].id)
  await page.screenshot({ path: path.join(artifacts, 'task-followup-mode.png') })
  await page.getByRole('button', { name: '取消引用', exact: true }).click()
  const chain = await followUp(linked[0].id, '沿引用链补充第二条', 'chained-followup')
  await waitGoal(first.id, 'review')
  const attempt = (await goal(first.id)).execution.attempt
  assert.equal((await followUp(linked[0].id, '沿引用链补充第二条', 'chained-followup')).id, chain.id)
  assert.equal((await goal(first.id)).execution.attempt, attempt, 'Response retry must not restart work')
  await assert.rejects(() => followUp(linked[0].id, '不同正文', 'chained-followup'), /不同内容/)
  await assert.rejects(() => followUp(result.execution.messageId, '沿引用链补充第二条', 'chained-followup'), /不同内容或引用/)
  const otherChat = await page.evaluate((id) => window.covan.createDm(id), fixture.outsider.id)
  await assert.rejects(() => followUp(result.execution.messageId, '跨会话错误投递', 'wrong-chat', otherChat.id), /当前会话/)
  const ordinary = linkedMessages.find((message) => message.sender_type === 'user' && !message.goal_input_execution_id)
  await assert.rejects(() => followUp(ordinary.id, '伪造引用', 'ordinary-as-task'), /未关联/)
  await sendQuoted((await goal(second.id)).execution.messageId, '已停止任务不能复活')
  await expect(page.getByRole('alert')).toContainText('此任务已结束')
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue('已停止任务不能复活')
  await page.getByRole('button', { name: '取消引用', exact: true }).click()
  await page.getByRole('textbox', { name: '输入消息' }).fill('')
  assert.equal((await goal(second.id)).execution.status, 'stopped')
  await page.screenshot({ path: path.join(artifacts, 'task-followup-receipts.png') })
  console.log('✓ Quoted task replies route directly, retain receipts, deduplicate retries and reject stale/cross-chat targets')

  const third = await make('慢速任务丙'), fourth = await make('慢速任务丁')
  await start(third.id); await start(fourth.id); await waitGate(third.title); await waitGate(fourth.title)
  const foreground = page.getByRole('textbox', { name: '输入消息' })
  await foreground.fill('前台慢速回复'); await page.getByRole('button', { name: '发送', exact: true }).click()
  await waitGate('foreground')
  const foregroundPayload = requests.findLast((body) => textOf(body.messages?.findLast((message) => message.role === 'user')?.content) === '前台慢速回复')
  assert.ok(foregroundPayload.messages.every((message) => !textOf(message.content).includes('引用补充只处理任务甲')), 'Routed input does not become foreground chat history or automatic memory')
  await sendQuoted(result.execution.messageId, '前台正在生成也能补充原任务')
  await expect.poll(async () => (await goal(first.id)).execution.inputs.some((input) => input.text === '前台正在生成也能补充原任务')).toBe(true)
  assert.ok(gates.has('foreground'), 'Task follow-up must not stop foreground generation')
  await stop(third.id); await waitGoal(third.id, 'stopped')
  assert.equal((await goal(fourth.id)).execution.status, 'running')
  assert.ok(gates.has('foreground'), 'Stopping goal does not cancel foreground')
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  assert.equal((await goal(fourth.id)).execution.status, 'running', 'Stopping foreground does not cancel goal')
  await stop(fourth.id); await waitGoal(fourth.id, 'stopped')
  await waitGoal(first.id, 'review')
  console.log('✓ Goal stop, other goal and foreground stop have independent cancellation scopes')

  await page.getByRole('textbox', { name: '输入消息' }).fill('显示目标看板')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const board = page.locator('.goals-board')
  await expect(board).toBeVisible()
  const expertGoal = await make('重复专家协作')
  await board.locator('.goal-board-row').filter({ hasText: expertGoal.title }).click()
  const detail = board.locator('.goal-detail-card')
  await detail.getByRole('checkbox', { name: '定价专家', exact: true }).click()
  await expect(detail.getByRole('checkbox', { name: '定价专家', exact: true })).toBeChecked()
  await detail.getByRole('button', { name: '执行下一步', exact: true }).click()
  await waitGoal(expertGoal.id, 'review')
  const expertRuns = (await runs()).filter((run) => run.goalId === expertGoal.id)
  assert.equal(expertRuns.filter((run) => run.parentExecutionId).length, 1, 'Duplicate consultation reuses expert execution')
  const expertRun = expertRuns.find((run) => run.parentExecutionId)
  assert.equal(expertRun.status, 'done')
  const expertResult = await goal(expertGoal.id)
  assert.ok(expertResult.artifacts.some((item) => item.path === `tasks/${expertRun.id}/expert.md`))
  assert.equal(expertResult.updates.filter((update) => update.authorAgentId === fixture.expert.id && update.text.includes('专家')).length, 1)
  const expertPayload = requests.find((body) => body.messages?.some((message) => textOf(message.content).startsWith('专家任务「')))
  assert.ok(expertPayload)
  assert.ok(!expertPayload.tools.some((tool) => ['consult_goal_expert', 'agent_private_chat', 'update_goal', 'configure_extensions'].includes(tool.function.name)))
  assert.ok(!JSON.stringify(expertPayload.messages).includes('正常前台提问'))
  const unauthorized = await make('越权专家')
  await start(unauthorized.id); await waitGoal(unauthorized.id, 'review')
  assert.equal((await runs()).filter((run) => run.goalId === unauthorized.id && run.parentExecutionId).length, 0)
  const failedExpert = await make('失败专家协作', true)
  await start(failedExpert.id); await waitGoal(failedExpert.id, 'review')
  assert.ok((await runs()).some((run) => run.goalId === failedExpert.id && run.parentExecutionId && run.status === 'error'))
  console.log('✓ Expert permissions, no recursive delegation, real files/report authorship and duplicate/failure handling')

  const heldOwner = await make('慢速并发占位')
  await start(heldOwner.id); await waitGate(heldOwner.title)
  const fanout = await make('多专家队列', true)
  const fanoutRoot = await start(fanout.id); await waitGate('fanout-owner')
  const fanoutChildren = (await runs()).filter((run) => run.parentExecutionId === fanoutRoot.id)
  assert.equal(fanoutChildren.length, 3)
  assert.equal(fanoutChildren.filter((run) => run.status === 'queued').length, 1)
  assert.equal((await runs()).filter((run) => run.status === 'running').length, 4)
  release('fanout-owner'); await waitGoal(fanout.id, 'waiting_experts')
  for (let index = 1; index <= 3; index++) { await waitGate(`expert:${fanout.title}/gated-${index}`); release(`expert:${fanout.title}/gated-${index}`) }
  await waitGoal(fanout.id, 'review')
  assert.equal((await runs()).filter((run) => run.parentExecutionId === fanoutRoot.id).length, 3, 'Fourth expert request is rejected without creating work')
  await stop(heldOwner.id)
  console.log('✓ Global four-worker limit, durable expert queue and per-owner dispatch budget')

  // Expert dispatch returns immediately. The owner can write and yield while
  // the expert's model request remains held by the deterministic gate.
  const asynchronous = await make('异步慢速专家协作', true)
  const asyncRoot = await start(asynchronous.id)
  await waitGate(`expert:${asynchronous.title}`)
  await waitGoal(asynchronous.id, 'waiting_experts')
  assert.ok((await goal(asynchronous.id)).artifacts.some((item) => item.path === `tasks/${asyncRoot.id}/research.md`))
  const spare = await make('等待专家时仍能开工')
  await start(spare.id); await waitGoal(spare.id, 'review')
  const waitingAttempt = (await goal(asynchronous.id)).execution.attempt
  await followUp((await goal(asynchronous.id)).execution.messageId, '等待专家时先处理用户新要求', 'waiting-expert-human')
  await expect.poll(async () => (await goal(asynchronous.id)).execution.inputs.some((input) => input.text === '等待专家时先处理用户新要求' && input.delivered)).toBe(true)
  await waitGoal(asynchronous.id, 'waiting_experts')
  assert.ok((await goal(asynchronous.id)).execution.attempt > waitingAttempt)
  assert.ok(gates.has(`expert:${asynchronous.title}`), 'User follow-up is handled before slow expert returns')
  release(`expert:${asynchronous.title}`)
  await waitGoal(asynchronous.id, 'review')
  assert.equal((await goal(asynchronous.id)).execution.id, asyncRoot.id)
  const aggregateMessages = await page.evaluate((id) => window.covan.listMessages(id), fixture.chat.id)
  assert.match(aggregateMessages.find((message) => message.id === (asyncRoot.messageId || (aggregateMessages.find((message) => message.goal_execution_id === asyncRoot.id)?.id))).content, /主责已汇总真实专家报告/)
  const waiting = await make('显式等待慢速专家', true)
  await start(waiting.id); await waitGate(`expert:${waiting.title}`); await waitGoal(waiting.id, 'waiting_experts')
  release(`expert:${waiting.title}`); await waitGoal(waiting.id, 'review')
  console.log('✓ Expert dispatch is asynchronous, waiting releases slots and reports automatically resume owner aggregation')

  const independent = await make('单独暂停慢速专家', true)
  const independentRoot = await start(independent.id)
  await waitGate(`expert:${independent.title}`); await waitGoal(independent.id, 'waiting_experts')
  const independentChild = (await runs()).find((run) => run.parentExecutionId === independentRoot.id)
  await page.evaluate((id) => window.covan.controlGoalExecution(id, 'pause'), independentChild.id)
  await page.evaluate((id) => window.covan.controlGoalExecution(id, 'pause'), independentRoot.id)
  await page.evaluate((id) => window.covan.controlGoalExecution(id, 'resume'), independentRoot.id)
  await waitGoal(independent.id, 'waiting_experts')
  assert.equal((await runs()).find((run) => run.id === independentChild.id).status, 'paused', 'Owner resume must not revive independently paused expert')
  await page.evaluate((id) => window.covan.controlGoalExecution(id, 'resume'), independentChild.id)
  await waitGate(`expert:${independent.title}`); release(`expert:${independent.title}`)
  await waitGoal(independent.id, 'review')

  const needsUser = await make('等待补充慢速专家', true)
  const needsUserRoot = await start(needsUser.id)
  await waitGate(`expert:${needsUser.title}`); await waitGoal(needsUser.id, 'waiting_input')
  release(`expert:${needsUser.title}`)
  await expect.poll(async () => (await runs()).find((run) => run.parentExecutionId === needsUserRoot.id)?.status).toBe('done')
  assert.equal((await goal(needsUser.id)).execution.status, 'waiting_input', 'Expert report does not bypass user-input wait')
  await page.evaluate((id) => window.covan.sendGoalExecutionInput(id, '预算一万元', 'needed-budget'), needsUserRoot.id)
  await waitGoal(needsUser.id, 'review')
  const inputGoal = await make('等待补充任务')
  const inputRun = await start(inputGoal.id); await waitGoal(inputGoal.id, 'waiting_input')
  await assert.rejects(() => page.evaluate((id) => window.covan.controlGoalExecution(id, 'resume'), inputRun.id), /先填写/)
  await page.evaluate((id) => window.covan.sendGoalExecutionInput(id, '预算一万元', 'budget'), inputRun.id)
  await waitGoal(inputGoal.id, 'review')
  assert.equal(issued.filter((item) => item.title === inputGoal.title && item.name === 'workspace_write').length, 1)
  await page.evaluate((id) => window.covan.sendGoalExecutionInput(id, '请调整格式', 'revision'), inputRun.id)
  await waitGoal(inputGoal.id, 'review')
  await page.evaluate((id) => window.covan.controlGoalExecution(id, 'accept'), inputRun.id)
  await waitGoal(inputGoal.id, 'done')
  assert.equal((await goal(inputGoal.id)).status, 'ACTIVE')
  const blocker = await make('阻塞任务')
  const blockedRun = await start(blocker.id); await waitGoal(blocker.id, 'blocked')
  await page.evaluate((id) => window.covan.sendGoalExecutionInput(id, '提供可用数据', 'unblock'), blockedRun.id)
  await waitGoal(blocker.id, 'review')

  const retryGoal = await make('重试本轮错误')
  const retryRun = await start(retryGoal.id); await waitGoal(retryGoal.id, 'error')
  await page.locator(`[data-execution-id="${retryRun.id}"]`).getByRole('button', { name: '重试本轮', exact: true }).click()
  await waitGoal(retryGoal.id, 'review')
  assert.equal((await goal(retryGoal.id)).execution.id, retryRun.id)
  assert.equal((await goal(retryGoal.id)).execution.attempt, 2)

  const checkpointGoal = await make('检查点暂停')
  const checkpointRun = await start(checkpointGoal.id); await waitGate(`checkpoint:${checkpointGoal.title}`)
  await page.locator(`[data-execution-id="${checkpointRun.id}"]`).getByRole('button', { name: '暂停执行', exact: true }).click()
  await waitGoal(checkpointGoal.id, 'paused')
  await sendQuoted((await goal(checkpointGoal.id)).execution.messageId, '暂停时保存的要求')
  await expect.poll(async () => (await goal(checkpointGoal.id)).execution.inputs.some((input) => input.text === '暂停时保存的要求')).toBe(true)
  await page.reload()
  assert.equal((await goal(checkpointGoal.id)).execution.status, 'paused')
  await page.locator(`[data-execution-id="${checkpointRun.id}"]`).getByRole('button', { name: '继续执行', exact: true }).click()
  await waitGoal(checkpointGoal.id, 'review')
  assert.equal((await goal(checkpointGoal.id)).execution.id, checkpointRun.id)
  assert.equal(issued.filter((item) => item.title === checkpointGoal.title && item.name === 'workspace_write').length, 1)
  assert.ok((await goal(checkpointGoal.id)).execution.inputs.every((input) => input.delivered))
  await page.locator(`[data-execution-id="${checkpointRun.id}"]`).getByRole('button', { name: '验收本轮', exact: true }).click()
  await waitGoal(checkpointGoal.id, 'done')
  console.log('✓ Input wait, blocking, review edits/acceptance, and pause/resume preserve successful tool results')

  const slowExpert = await make('慢速专家协作', true)
  // Root fixture also waits; allow it to dispatch the slow expert.
  await start(slowExpert.id); await waitGate(slowExpert.title); release(slowExpert.title)
  await waitGate(`expert:${slowExpert.title}`)
  await stop(slowExpert.id); await waitGoal(slowExpert.id, 'stopped')
  await expect.poll(async () => (await runs()).filter((run) => run.goalId === slowExpert.id).every((run) => run.status === 'stopped')).toBe(true)

  const deletedExpert = await make('慢速专家删除', true)
  await start(deletedExpert.id); await waitGate(deletedExpert.title); release(deletedExpert.title)
  await waitGate(`expert:${deletedExpert.title}`)
  await page.evaluate((id) => window.covan.deleteBot(id), fixture.expert.id)
  await waitGoal(deletedExpert.id, 'stopped')
  await expect.poll(async () => (await runs()).filter((run) => run.goalId === deletedExpert.id).every((run) => run.status === 'stopped')).toBe(true)
  const deletedChatGoal = await page.evaluate(async (fixture) => {
    const chat = await window.covan.createDm(fixture.outsider.id)
    const goal = await window.covan.createGoal({ title: '慢速删除会话', ownerAgentId: fixture.outsider.id, sessionId: chat.id })
    await window.covan.runGoalNextStep(goal.id)
    return { goal, chat }
  }, fixture)
  await waitGate(deletedChatGoal.goal.title)
  await page.evaluate((id) => window.covan.deleteChat(id), deletedChatGoal.chat.id)
  await waitGoal(deletedChatGoal.goal.id, 'stopped')
  console.log('✓ Deleting an executing expert or its delivery chat leaves no running execution')

  const cli = await page.evaluate(async (cliPath) => {
    const bot = await window.covan.createBot({ name: '本地任务助手', backend: 'codex-cli', cli_path: cliPath, cli_access: 'workspace-write' })
    const chat = await window.covan.createDm(bot.id)
    await window.covan.sendUserMessage(chat.id, '建立前台 CLI 会话', [])
    const a = await window.covan.createGoal({ title: 'CLI任务甲', ownerAgentId: bot.id, sessionId: chat.id })
    const b = await window.covan.createGoal({ title: 'CLI任务乙', ownerAgentId: bot.id, sessionId: chat.id })
    return { bot, chat, a, b, runA: await window.covan.runGoalNextStep(a.id), runB: await window.covan.runGoalNextStep(b.id) }
  }, path.join(root, 'scripts', 'fixtures', 'fake-cli.mjs'))
  const cliCalls = () => fs.existsSync(path.join(profile, 'fake-cli.jsonl')) ? fs.readFileSync(path.join(profile, 'fake-cli.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : []
  await expect.poll(() => cliCalls().some((call) => call.prompt.includes('CLI任务甲'))).toBe(true)
  await page.evaluate(async (id) => {
    await window.covan.sendGoalExecutionInput(id, 'CLI本轮补充要求', 'cli-input')
    await window.covan.sendGoalExecutionInput(id, 'CLI第二条也要处理', 'cli-input-2')
  }, cli.runA.id)
  await waitGoal(cli.a.id, 'review'); await waitGoal(cli.b.id, 'review')
  assert.ok((await goal(cli.a.id)).artifacts.some((item) => item.path === `tasks/${cli.runA.id}/cli-note.txt`))
  const taskCliCalls = cliCalls().filter((call) => call.cwd.includes('/tasks/'))
  assert.equal(taskCliCalls.filter((call) => !call.isResume).length, 2)
  assert.ok(taskCliCalls.some((call) => call.isResume && call.prompt.includes('CLI本轮补充要求') && call.prompt.includes('CLI第二条也要处理')))
  assert.ok(taskCliCalls.every((call) => call.cwd.endsWith(cli.runA.id) || call.cwd.endsWith(cli.runB.id)))
  await page.evaluate((id) => window.covan.sendUserMessage(id, '前台继续', []), cli.chat.id)
  await expect.poll(() => cliCalls().at(-1)?.prompt).toBe('前台继续')
  assert.equal(cliCalls().at(-1).isResume, true, 'Task CLI sessions do not overwrite foreground mapping')
  assert.ok(!cliCalls().at(-1).cwd.includes('/tasks/'))
  await expect.poll(() => page.evaluate(async (id) => (await window.covan.listMessages(id)).some((message) => message.status === 'streaming'), cli.chat.id)).toBe(false)
  console.log('✓ CLI tasks isolate directories/sessions, process queued inputs and preserve foreground continuation')

  const checkpointCrash = await make('检查点重启')
  const checkpointCrashRun = await start(checkpointCrash.id); await waitGate(`checkpoint:${checkpointCrash.title}`)
  const interrupted = await make('慢速重启任务')
  const interruptedRun = await start(interrupted.id); await waitGate(interrupted.title)
  await page.evaluate((id) => window.covan.sendGoalExecutionInput(id, '重启前已保存要求', 'restart-input'), interruptedRun.id)
  const crashFollowUp = await followUp((await goal(interrupted.id)).execution.messageId, '重启前聊天路由的要求', 'restart-followup')
  const firstRunAfterRestart = await make('重启队列首次运行')
  assert.equal((await start(firstRunAfterRestart.id)).status, 'queued')
  const crashed = new Promise((resolve) => app.process().once('exit', resolve))
  app.process().kill('SIGKILL'); await crashed; app = undefined
  await launch()
  await waitGoal(interrupted.id, 'paused')
  await waitGoal(firstRunAfterRestart.id, 'review')
  const restored = (await runs()).find((run) => run.id === interruptedRun.id)
  assert.equal(restored.inputs.length, 2)
  assert.equal(restored.inputs[0].delivered, false)
  const receiptAfterRestart = await page.evaluate((id) => window.covan.listMessages(id), fixture.chat.id)
  assert.equal(receiptAfterRestart.find((message) => message.id === crashFollowUp.id)?.goal_input_delivery, 'pending')
  assert.equal((await followUp((await goal(interrupted.id)).execution.messageId, '重启前聊天路由的要求', 'restart-followup')).id, crashFollowUp.id)
  const before = requests.length
  await page.reload()
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible()
  assert.equal(requests.length, before, 'Restart does not replay external actions')
  assert.ok((await runs()).every((run) => run.status !== 'running'))
  await waitGoal(checkpointCrash.id, 'paused')
  await page.evaluate((id) => window.covan.controlGoalExecution(id, 'resume'), checkpointCrashRun.id)
  await waitGoal(checkpointCrash.id, 'review')
  assert.equal(issued.filter((item) => item.title === checkpointCrash.title && item.name === 'workspace_write').length, 1, 'Crash recovery must retain successful tool results')
  await page.evaluate((id) => window.covan.sendGoalExecutionInput(id, '重启后 CLI 延续要求', 'cli-after-restart'), cli.runA.id)
  await waitGoal(cli.a.id, 'review')
  assert.ok(cliCalls().some((call) => call.isResume && call.cwd.endsWith(cli.runA.id) && call.prompt.includes('重启后 CLI 延续要求')), 'Task CLI session survives app restart')
  await page.evaluate((id) => window.covan.controlGoalExecution(id, 'resume'), interruptedRun.id)
  await waitGoal(interrupted.id, 'review')
  assert.ok((await goal(interrupted.id)).execution.inputs.every((input) => input.delivered))
  const messages = await page.evaluate((id) => window.covan.listMessages(id, undefined, 200), fixture.chat.id)
  assert.ok(messages.every((message) => message.status !== 'streaming'))
  assert.ok(messages.filter((message) => message.goal_execution_id).every((message) => message.sender_type === 'bot'))
  assert.deepEqual(errors, [])
  console.log('✓ Expert cancellation and restart preserve inputs/history without automatic replay')
  console.log('Goal task UI regression passed.')
} catch (error) {
  await page?.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await app?.close()
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve))
  fs.rmSync(profile, { recursive: true, force: true })
}
