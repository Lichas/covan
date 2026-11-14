// Browser autonomy and login handoff, using only a local website and model fixture.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { expect } from '@playwright/test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'covan-browser-auto-'))
const artifacts = path.join(root, 'artifacts/browser-auto')
fs.mkdirSync(artifacts, { recursive: true })
let app, page, fixture, base, queries = 0, uploads = 0
const errors = [], requests = []
const textOf = (value) => typeof value === 'string' ? value : (value ?? []).map((part) => part.text ?? '').join('\n')
const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (req.url === '/auto') return res.end('<h1>资料查询</h1><label>关键词<input id="query"></label><label>方案<select id="plan"><option value="basic">基础版</option><option value="pro">专业版</option></select></label><label>附件<input id="upload" type="file" aria-label="附件"></label><button onclick="fetch(\'/query\',{method:\'POST\'}).then(()=>document.getElementById(\'result\').textContent=\'查询完成\')">执行查询</button><p id="result"></p><a href="/download">下载结果</a><script>document.getElementById("upload").onchange=()=>fetch("/upload",{method:"POST",body:document.getElementById("upload").files[0]})</script>')
    if (req.url === '/auth') return res.end('<h1>登录</h1><form action="/signed" method="POST"><label>账号<input id="username" name="username" autocomplete="username"></label><label>密码<input id="password" name="password" type="password"></label><button>登录</button></form>')
    if (req.url === '/verify') return res.end('<h1>验证码验证</h1><form action="/signed" method="POST"><label>验证码<input id="otp" name="code" autocomplete="one-time-code"></label><button>验证</button></form>')
    if (req.url === '/signed') { for await (const _chunk of req) {} return res.end('<h1>登录成功</h1><p>账户资料可用</p><a href="/download">下载资料</a>') }
    if (req.url === '/query' || req.url === '/upload') { for await (const _chunk of req) {} if (req.url === '/query') queries++; else uploads++; return res.end('ok') }
    if (req.url === '/download') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="result.txt"' }); return res.end('automatic result') }
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'fixture' }] }))
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw || '{}'); requests.push(body)
    const messages = body.messages ?? [], userIndex = messages.findLastIndex((message) => message.role === 'user')
    const user = textOf(messages[userIndex]?.content)
    const results = messages.slice(userIndex + 1).filter((message) => message.role === 'tool')
    let previous
    try { previous = JSON.parse(textOf(results.at(-1)?.content)) } catch { /* Interrupted tools produce an error. */ }
    const step = results.length, find = (name) => previous?.elements?.find((element) => element.name === name)?.ref
    let tool
    if (/自动全流程|登录流程|停止登录|验证码流程|确认模式|显式接管/.test(user) && step === 0)
      tool = ['browser_open', { url: base + (user.includes('验证码') ? '/verify' : /登录/.test(user) ? '/auth' : '/auto') }]
    else if (user.includes('自动全流程') && previous?.snapshotId) {
      const snapshotId = previous.snapshotId
      if (step === 1) tool = ['browser_fill', { snapshotId, fields: [{ ref: find('关键词'), value: 'Covan' }] }]
      if (step === 2) tool = ['browser_select', { snapshotId, ref: find('方案'), value: 'pro' }]
      if (step === 3) tool = ['browser_upload', { snapshotId, ref: find('附件'), paths: ['upload.txt'] }]
      if (step === 4) tool = ['browser_click', { snapshotId, ref: find('执行查询') }]
      if (step === 5) tool = ['browser_click', { snapshotId, ref: find('下载结果') }]
    } else if ((user.includes('登录流程') || user.includes('验证码流程')) && step === 1 && previous?.snapshotId)
      tool = ['browser_click', { snapshotId: previous.snapshotId, ref: find('下载资料') }]
    else if (user.includes('显式接管') && step === 1 && previous?.snapshotId) tool = ['browser_handoff', { kind: 'login', reason: '请手动完成此网站的特殊登录' }]
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    send({ role: 'assistant' })
    send(tool ? { tool_calls: [{ index: 0, id: `action-${step}`, type: 'function', function: { name: tool[0], arguments: JSON.stringify(tool[1]) } }] } : { content: '本轮结果已核对。' })
    send({}, tool ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n')
  } catch (error) { errors.push(String(error)); res.statusCode = 500; res.end() }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
base = `http://127.0.0.1:${server.address().port}`
async function launch() {
  const env = { ...process.env, ELECTRON_RENDERER_URL: '', COVAN_USER_DATA_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [root], env }); page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  app.process().stderr.on('data', (chunk) => { if (/Uncaught Exception|UnhandledPromiseRejection/.test(chunk.toString())) errors.push('Unexpected main exception') })
  await page.waitForFunction(() => !!window.covan)
}
const state = () => page.evaluate((id) => window.covan.getBrowserState(id), fixture.bot.id)
const start = (text) => page.evaluate(({ id, text }) => window.covan.sendUserMessage(id, text, []), { id: fixture.chat.id, text })
const idle = () => expect.poll(() => page.evaluate(async (id) => (await window.covan.listMessages(id)).some((message) => message.status === 'streaming'), fixture.chat.id), { timeout: 20000 }).toBe(false)
async function handoff(kind = 'login') {
  await expect.poll(async () => (await state()).handoff?.kind, { timeout: 15000 }).toBe(kind)
  await expect(page.getByRole('region', { name: kind === 'login' ? '需要登录' : '需要完成验证', exact: true })).toBeVisible()
  return (await state()).handoff
}
async function manual(expression) {
  // Repository-owned actions on the synthetic website only, simulating the human's login.
  return app.evaluate(async ({ webContents }, { base, expression }) => {
    const contents = webContents.getAllWebContents().find((item) => item.getURL().startsWith(base + '/'))
    if (!contents) throw new Error('Fixture browser unavailable')
    return contents.executeJavaScript(expression)
  }, { base, expression })
}

try {
  await launch()
  fixture = await page.evaluate(async (base) => {
    await window.covan.setSetting('natural_follow_up', '0')
    const provider = await window.covan.saveProvider({ name: '自动浏览器模拟', kind: 'openai-compatible', base_url: base + '/v1', default_model: 'fixture' })
    const bot = await window.covan.createBot({ name: '自动浏览助手', provider_id: provider.id })
    return { bot, chat: await window.covan.createDm(bot.id) }
  }, base)
  fs.mkdirSync(path.join(profile, 'workspaces', fixture.bot.id), { recursive: true })
  fs.writeFileSync(path.join(profile, 'workspaces', fixture.bot.id, 'upload.txt'), 'synthetic upload')
  await page.reload(); await page.locator('aside').first().getByRole('button', { name: '自动浏览助手', exact: true }).click()
  const seenApprovals = []
  await page.evaluate((id) => { window.__browserDispose = window.covan.onEvent(async (event) => { if (event.type === 'browser-updated' && event.botId === id) { const state = await window.covan.getBrowserState(id); if (state.pending) window.__unexpectedBrowserApproval = true } }) }, fixture.bot.id)
  assert.equal((await state()).policy, 'auto')
  await start('自动全流程'); await idle()
  assert.equal(queries, 1); assert.equal(uploads, 1)
  assert.equal(await manual('document.getElementById("query").value'), 'Covan')
  const downloaded = (await state()).downloads.find((entry) => entry.status === 'done')
  assert.equal(fs.readFileSync(path.join(profile, 'workspaces', fixture.bot.id, downloaded.relPath), 'utf8'), 'automatic result')
  assert.ok(!(await page.evaluate(() => window.__unexpectedBrowserApproval)))
  console.log('✓ Default auto mode browses, fills, selects, uploads, submits and downloads without approval cards')

  await start('登录流程')
  const login = await handoff()
  assert.equal((await state()).pending, null)
  await page.getByRole('region', { name: '需要登录', exact: true }).getByRole('button', { name: '登录完成，继续', exact: true }).click()
  await expect(page.getByRole('region', { name: '需要登录', exact: true })).toContainText('仍检测到登录')
  await page.screenshot({ path: path.join(artifacts, 'login-card.png') })
  await manual('document.getElementById("username").value="fixture-user"; document.getElementById("password").value="human-only-password-987"; document.querySelector("form").requestSubmit()')
  await expect.poll(async () => (await state()).url).toBe(base + '/signed')
  assert.equal((await state()).handoff.id, login.id, '人工登录导航不取消卡片')
  await page.getByRole('region', { name: '需要登录', exact: true }).getByRole('button', { name: '登录完成，继续', exact: true }).click()
  await idle()
  assert.equal((await state()).handoff, null)
  assert.equal((await state()).downloads.filter((entry) => entry.status === 'done').length, 2)
  const messages = await page.evaluate((id) => window.covan.listMessages(id), fixture.chat.id)
  assert.equal(messages.filter((message) => message.sender_type === 'user').length, 2, '登录续跑不插入新用户消息')
  assert.ok(messages.find((message) => message.id === login.messageId)?.artifacts.length)
  assert.ok(!JSON.stringify(requests).includes('human-only-password-987'))
  await assert.rejects(() => page.evaluate(({ botId, id }) => window.covan.completeBrowserHandoff(botId, id, true), { botId: fixture.bot.id, id: login.id }), /失效/)
  console.log('✓ Login card binds the original response, survives navigation and resumes the same turn without a new message')

  await start('验证码流程'); const verification = await handoff('verification')
  await manual('document.getElementById("otp").value="human-code-654321"; document.querySelector("form").requestSubmit()')
  await expect.poll(async () => (await state()).url).toBe(base + '/signed')
  await page.evaluate(({ botId, id }) => window.covan.completeBrowserHandoff(botId, id, true), { botId: fixture.bot.id, id: verification.id })
  await idle(); assert.ok(!JSON.stringify(requests).includes('human-code-654321'))
  console.log('✓ OTP challenge pauses automatically; code stays out of model input')

  await start('停止登录'); const stopped = await handoff()
  await page.evaluate((id) => window.covan.stopChat(id), fixture.chat.id); await idle()
  assert.equal((await state()).handoff, null)
  await assert.rejects(() => page.evaluate(({ botId, id }) => window.covan.completeBrowserHandoff(botId, id, true), { botId: fixture.bot.id, id: stopped.id }), /失效/)
  await page.evaluate((id) => window.covan.setBrowserControl(id, 'agent'), fixture.bot.id)
  await start('显式接管'); const explicit = await handoff()
  await page.evaluate(({ botId, id }) => window.covan.completeBrowserHandoff(botId, id, false), { botId: fixture.bot.id, id: explicit.id }); await idle()
  assert.equal((await state()).handoff, null)
  console.log('✓ Stopping/cancelling revokes login cards; unrecognised login pages can request explicit handoff')

  await page.evaluate((id) => window.covan.setBrowserPolicy(id, 'confirm'), fixture.bot.id)
  await app.close(); await launch()
  assert.equal((await state()).policy, 'confirm')
  await page.evaluate(async (id) => { await window.covan.openBrowser(id); await window.covan.setBrowserControl(id, 'agent') }, fixture.bot.id)
  await start('确认模式')
  await expect.poll(async () => (await state()).pending?.action).toBe('open')
  const oldApproval = (await state()).pending.id
  await page.evaluate((id) => window.covan.setBrowserPolicy(id, 'auto'), fixture.bot.id); await idle()
  assert.equal((await state()).pending, null)
  await assert.rejects(() => page.evaluate(({ botId, id }) => window.covan.respondBrowserApproval(botId, id, true), { botId: fixture.bot.id, id: oldApproval }), /失效/)
  assert.deepEqual(errors, [])
  console.log('✓ Confirm mode is optional and persistent; switching mode never approves an old request')
  console.log('Browser autonomy UI regression passed.')
} catch (error) {
  await page?.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await app?.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve))
  fs.rmSync(profile, { recursive: true, force: true })
}
