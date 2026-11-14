// Deterministic real-Electron coverage for Goals execution and mixed document inputs.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { expect } from '@playwright/test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'covan-productivity-'))
const artifacts = path.join(root, 'artifacts', 'productivity')
fs.mkdirSync(artifacts, { recursive: true })
const errors = [], requests = []
let app, page, fixture
const textOf = (content) => typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('\n')

function pdfFixture(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  for (let i = 0; i < pages.length; i++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`)
    const stream = `BT /F1 12 Tf 50 700 Td (${pages[i]}) Tj ET`
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  }
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const offset = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size ${offsets.length} >>\nstartxref\n${offset}\n%%EOF\n`
  return Buffer.from(pdf)
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'fixture' }] }))
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw || '{}')
    requests.push(body)
    const messages = body.messages ?? []
    const lastUserIndex = messages.findLastIndex((message) => message.role === 'user')
    const user = textOf(messages[lastUserIndex]?.content)
    const goalRun = user.startsWith('目标下一步「')
    const fail = goalRun && user.includes('失败目标')
    const slow = goalRun && user.includes('慢速目标')
    if (fail) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture failure', type: 'invalid_request_error' } })); return }
    let content = '收到。'
    let tool
    if (goalRun) {
      if (!messages.slice(lastUserIndex + 1).some((message) => message.role === 'tool'))
        tool = { index: 0, id: 'deliver-file', type: 'function', function: { name: 'workspace_write', arguments: JSON.stringify({ path: 'research.md', content: '# 本轮调研\n已完成三个竞品的对比。' }) } }
      else content = '已完成竞品对比并保存 research.md。下一步：核对结论。'
    } else if (user.includes('显示目标')) content = '```openui-lang\nroot = Card("目标工作台", [board])\nboard = GoalsBoard()\n```'
    else if (user.includes('比较附件')) content = '收入为 120，成本为 80。[report.pdf，第 2 页]；代码常量为 42。[sample.ts，L1-L2]'
    if (body.stream === false) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 20 } }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    send({ role: 'assistant' })
    if (slow) {
      send({ content: '正在处理，请稍候。' })
      const timer = setTimeout(() => { if (!res.destroyed) { send({}, 'stop'); res.end('data: [DONE]\n\n') } }, 30000)
      res.on('close', () => clearTimeout(timer))
      return
    }
    send(tool ? { tool_calls: [tool] } : { content })
    send({}, tool ? 'tool_calls' : 'stop')
    res.end('data: [DONE]\n\n')
  } catch (error) { errors.push(String(error)); res.statusCode = 500; res.end() }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/v1`

async function launch() {
  const env = { ...process.env, ELECTRON_RENDERER_URL: '', COVAN_USER_DATA_DIR: profile }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [root], env })
  app.process().stderr.on('data', (chunk) => {
    if (/Uncaught Exception|UnhandledPromiseRejection|Unhandled rejection/.test(chunk.toString())) errors.push('Unexpected main-process exception')
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.waitForFunction(() => !!window.covan)
  await page.emulateMedia({ reducedMotion: 'reduce' })
}
const getGoal = (id) => page.evaluate((id) => window.covan.getGoal(id), id)
const waitGoal = async (id, status) => {
  await expect.poll(async () => (await getGoal(id)).execution?.status, { timeout: 20000 }).toBe(status)
  return getGoal(id)
}
const send = async (text) => {
  await page.getByRole('textbox', { name: '输入消息' }).fill(text)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => page.evaluate(async (id) => (await window.covan.listMessages(id)).some((message) => message.status === 'streaming'), fixture.chat.id), { timeout: 20000 }).toBe(false)
}

try {
  await launch()
  fixture = await page.evaluate(async (base) => {
    await window.covan.setSetting('natural_follow_up', '0')
    const provider = await window.covan.saveProvider({ name: '本地模拟', kind: 'openai-compatible', base_url: base, default_model: 'fixture' })
    const bot = await window.covan.createBot({ name: '执行助手', provider_id: provider.id })
    const chat = await window.covan.createDm(bot.id)
    return { bot, chat }
  }, base)
  await page.reload()
  await page.locator('aside').first().getByRole('button', { name: '执行助手', exact: true }).click()
  await send('显示目标看板')
  const board = page.locator('.goals-board')
  await expect(board).toBeVisible()
  await board.getByRole('button', { name: '新建目标', exact: true }).click()
  const create = page.locator('.goal-create-card')
  await create.getByLabel('目标标题').fill('调研三个竞品')
  await create.getByLabel('负责 Bot', { exact: true }).selectOption(fixture.bot.id)
  await create.getByRole('button', { name: '确认创建', exact: true }).click()
  const detail = page.locator('.goal-detail-card')
  await expect(detail).toContainText('调研三个竞品')
  const goalId = await page.evaluate(async () => (await window.covan.listGoals()).goals.find((goal) => goal.title === '调研三个竞品').id)
  await detail.getByRole('button', { name: '执行下一步', exact: true }).click()
  await waitGoal(goalId, 'review')
  await detail.getByRole('button', { name: '验收本轮', exact: true }).click()
  const completed = await waitGoal(goalId, 'done')
  assert.equal(completed.status, 'ACTIVE', '执行一轮不自动完成整个目标')
  assert.ok(completed.artifacts.some((artifact) => artifact.type === 'document' && artifact.path.endsWith('/research.md')))
  assert.ok(completed.updates.some((update) => update.text.includes('Agent 回复，尚需核对') && update.text.includes('下一步')))
  await expect(detail).toContainText('research.md')
  await expect(detail.getByRole('button', { name: '执行下一步', exact: true })).toBeEnabled()
  await detail.scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(artifacts, 'goal-execution.png') })
  const executedMessages = await page.evaluate((id) => window.covan.listMessages(id), completed.execution.chatId)
  assert.equal(executedMessages.filter((message) => message.sender_type === 'user').length, 1, '目标执行不伪造用户消息')
  assert.ok(executedMessages.find((message) => message.id === completed.execution.messageId)?.artifacts.length)
  await detail.getByRole('button', { name: '查看执行会话', exact: true }).click()
  await expect(page.locator('.artifact-card').first()).toBeVisible()
  console.log('✓ Goals UI owner selection, real tool execution, file association, progress and source chat')

  // Document import, local preview, draft reload and real model input with source locations.
  const input = page.getByLabel('选择附件')
  await input.setInputFiles([
    { name: 'report.pdf', mimeType: 'application/pdf', buffer: pdfFixture(['Revenue 120', 'Costs 80']) },
    { name: 'sample.ts', mimeType: 'text/plain', buffer: Buffer.from('export const answer = 42\n// comparison source') },
  ])
  await expect(page.locator('.composer-document')).toHaveCount(2, { timeout: 25000 })
  await page.getByRole('button', { name: '预览附件：report.pdf', exact: true }).click()
  await expect(page.locator('.document-preview')).toContainText('[第 2 页]')
  await expect(page.locator('.document-preview')).toContainText('Costs 80')
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  await page.reload()
  await expect(page.locator('.composer-document')).toHaveCount(2)
  await send('比较附件，请引用来源')
  await expect(page.locator('.message-bot').last()).toContainText('[report.pdf，第 2 页]')
  const request = requests.find((request) => (request.messages ?? []).some((message) => textOf(message.content).includes('比较附件')))
  const payload = JSON.stringify(request.messages)
  assert.ok(payload.includes('Revenue 120') && payload.includes('Costs 80') && payload.includes('L1: export const answer = 42'))
  assert.ok(!payload.includes('image_url'), '文档使用文字输入，无需视觉模型')
  await page.getByRole('button', { name: '预览附件：sample.ts', exact: true }).click()
  await expect(page.locator('.document-preview')).toContainText('L2: // comparison source')
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  await page.screenshot({ path: path.join(artifacts, 'documents.png') })
  const exportedPath = path.join(profile, 'conversation.md')
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, exportedPath)
  await page.evaluate((id) => window.covan.exportChat(id), fixture.chat.id)
  const exported = fs.readFileSync(exportedPath, 'utf8')
  const assetDirectory = exported.match(/\[report\.pdf\]\((covan-images-[a-f0-9-]+)\//)?.[1]
  assert.ok(assetDirectory)
  assert.ok(!exported.includes('![report.pdf]'))
  const assetFiles = fs.readdirSync(path.join(profile, assetDirectory))
  assert.equal(assetFiles.length, 2)
  assert.equal(fs.readFileSync(path.join(profile, assetDirectory, assetFiles.find((name) => name.endsWith('.pdf')))).subarray(0, 5).toString(), '%PDF-')
  const dropped = await page.evaluateHandle(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['drop test'], 'dropped.txt', { type: 'text/plain' }))
    return transfer
  })
  await page.locator('.composer-shell').dispatchEvent('drop', { dataTransfer: dropped })
  await expect(page.locator('.composer-document')).toHaveCount(1)
  await page.getByRole('button', { name: '移除附件：dropped.txt', exact: true }).click()
  await dropped.dispose()
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['paste test'], 'pasted.md', { type: 'text/plain' }))
    document.querySelector('.composer-shell').dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  })
  await expect(page.locator('.composer-document')).toHaveCount(1)
  await page.getByRole('button', { name: '移除附件：pasted.md', exact: true }).click()
  console.log('✓ PDF page extraction, code line references, local previews, draft reload and model context')

  // Main-process limits cannot be bypassed via IPC.
  const invalidResults = await page.evaluate(async () => {
    const checks = []
    for (const [name, bytes] of [['fake.pdf', [1, 2, 3]], ['binary.txt', [0, 1, 2]], ['empty.txt', []], ['bad.txt', [255, 254, 255]], ['office.docx', [80, 75, 0]]]) {
      try { await window.covan.importChatAttachment(name, new Uint8Array(bytes)); checks.push(false) } catch { checks.push(true) }
    }
    try { await window.covan.readChatDocument('../covan.db'); checks.push(false) } catch { checks.push(true) }
    try { await window.covan.importChatAttachment('huge.txt', new Uint8Array(16 * 1024 * 1024 + 1)); checks.push(false) } catch { checks.push(true) }
    return checks
  })
  assert.ok(invalidResults.every(Boolean))
  const emptyPdf = await page.evaluate(async (bytes) => {
    try { await window.covan.importChatAttachment('scan.pdf', new Uint8Array(bytes)); return '' } catch (error) { return error.message }
  }, [...pdfFixture([''])])
  assert.match(emptyPdf, /OCR/)
  const truncated = await page.evaluate(async () => {
    const attachment = await window.covan.importChatAttachment('long.txt', new TextEncoder().encode('x'.repeat(61000)))
    return { attachment, preview: await window.covan.readChatDocument(attachment.path) }
  })
  assert.equal(truncated.attachment.truncated, true)
  assert.ok(truncated.preview.text.length < 61000)
  console.log('✓ Empty/scanned PDFs, invalid/binary/oversized inputs, path traversal and truncation')

  const makeGoal = (title) => page.evaluate(({ title, botId, chatId }) => window.covan.createGoal({ title, ownerAgentId: botId, sessionId: chatId }), { title, botId: fixture.bot.id, chatId: fixture.chat.id })
  const slow = await makeGoal('慢速目标')
  const duplicate = await page.evaluate(async (goal) => {
    const first = await window.covan.runGoalNextStep(goal.id, goal.version)
    const second = await window.covan.runGoalNextStep(goal.id, goal.version)
    return [first, second]
  }, slow)
  assert.equal(duplicate[0].id, duplicate[1].id)
  const blocked = await makeGoal('并发目标')
  await page.evaluate((goal) => window.covan.runGoalNextStep(goal.id, goal.version), blocked)
  await waitGoal(blocked.id, 'review')
  await page.evaluate((id) => window.covan.stopGoalExecution(id), slow.id)
  const stopped = await waitGoal(slow.id, 'stopped')
  assert.equal(stopped.artifacts.length, 0)
  const paused = await page.evaluate(async (id) => {
    const goal = await window.covan.getGoal(id)
    return window.covan.updateGoal(id, { status: 'PAUSED' }, goal.version)
  }, slow.id)
  await assert.rejects(() => page.evaluate((goal) => window.covan.runGoalNextStep(goal.id, goal.version), paused), /恢复为进行中/)
  const failed = await makeGoal('失败目标')
  await page.evaluate((goal) => window.covan.runGoalNextStep(goal.id, goal.version), failed)
  const failure = await waitGoal(failed.id, 'error')
  assert.equal(failure.artifacts.length, 0)
  assert.ok(failure.updates.some((update) => update.text.includes('失败')))
  await page.evaluate((id) => window.covan.updateGoal(id, { title: '重试目标' }), failed.id)
  await page.evaluate((id) => window.covan.runGoalNextStep(id), failed.id)
  await waitGoal(failed.id, 'review')
  const pausedDuringRun = await makeGoal('慢速目标：暂停')
  await page.evaluate((goal) => window.covan.runGoalNextStep(goal.id, goal.version), pausedDuringRun)
  await page.evaluate((id) => window.covan.updateGoal(id, { status: 'PAUSED' }), pausedDuringRun.id)
  assert.equal((await waitGoal(pausedDuringRun.id, 'paused')).status, 'PAUSED')
  const deletedDuringRun = await makeGoal('慢速目标：删除')
  await page.evaluate((goal) => window.covan.runGoalNextStep(goal.id, goal.version), deletedDuringRun)
  await page.evaluate((id) => window.covan.deleteGoal(id), deletedDuringRun.id)
  await expect.poll(() => page.evaluate(async (id) => (await window.covan.listMessages(id)).some((message) => message.status === 'streaming'), fixture.chat.id)).toBe(false)
  console.log('✓ Duplicate protection, cancellation, paused-goal rejection, failure and explicit retry')

  const recovery = await makeGoal('慢速目标：重启恢复')
  await page.evaluate((goal) => window.covan.runGoalNextStep(goal.id, goal.version), recovery)
  await app.close()
  await launch()
  const recovered = await getGoal(recovery.id)
  assert.equal(recovered.execution.status, 'paused')
  assert.match(recovered.execution.reason, /中断/)
  assert.equal((await getGoal(goalId)).execution.status, 'done')
  await page.reload()
  const persisted = await page.evaluate((id) => window.covan.listMessages(id), fixture.chat.id)
  assert.equal(persisted.find((message) => message.sender_type === 'user' && message.attachments.length === 2)?.attachments[0].pages, 2)
  assert.ok(persisted.every((message) => message.status !== 'streaming'))
  assert.deepEqual(errors, [])
  console.log('✓ Restart preserves attachments/results and marks interrupted execution without replay')
  console.log('Productivity UI regression passed.')
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await app?.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(profile, { recursive: true, force: true })
}
