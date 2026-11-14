// Real Electron, an isolated profile, and reviewed local fixtures. No real accounts or paid models.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { expect } from '@playwright/test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'covan-browser-ui-'))
const artifacts = path.join(root, 'artifacts/browser')
fs.mkdirSync(artifacts, { recursive: true })
const errors = [], requests = []
let app, page, toolbar, fixture, submissions = 0, uploads = 0, base
const textOf = (value) => typeof value === 'string' ? value : (value ?? []).map((part) => part.text ?? '').join('\n')
const siteHtml = `<!doctype html><meta charset="utf-8"><title>本地浏览器验收</title><style>body{font:16px system-ui;padding:30px;max-width:620px}label{display:block;margin:18px 0}input,select,button{font:inherit;padding:8px}#result{padding:16px;background:#eef7ff}</style><h1>报名与资料交付</h1><p id="result">等待提交</p><form id="form"><label>公司<input id="company" name="company" value="旧内容"></label><label>方案<select id="plan"><option value="basic">基础版</option><option value="pro">专业版</option></select></label><label>资料文件<input id="upload" type="file" aria-label="资料文件"></label><label>密码（请手动填写）<input type="password" value="fixture-password-never-send"></label><button id="submit" type="submit">确认报名</button></form><p><a href="/download">下载报告</a></p><script>document.getElementById('upload').onchange=()=>fetch('/upload',{method:'POST',body:document.getElementById('upload').files[0]});document.getElementById('form').onsubmit=async(e)=>{e.preventDefault();await fetch('/submit',{method:'POST',body:JSON.stringify({company:document.getElementById('company').value,plan:document.getElementById('plan').value})});document.getElementById('result').textContent='提交成功：'+document.getElementById('company').value;};</script>`

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/site') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(siteHtml); return }
    if (req.url === '/submit') { submissions++; for await (const _chunk of req) {} res.end('ok'); return }
    if (req.url === '/upload') { uploads++; for await (const _chunk of req) {} res.end('ok'); return }
    if (req.url === '/download') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="report.txt"' }); res.end('Covan verified report'); return }
    if (req.url === '/login') { res.setHeader('Set-Cookie', 'fixture_login=yes; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax'); res.setHeader('Content-Type', 'text/html'); res.end('<h1>Manual fixture login complete</h1>'); return }
    if (req.url === '/profile') { res.setHeader('Content-Type', 'text/html'); res.end(`<h1>${req.headers.cookie?.includes('fixture_login=yes') ? 'Signed in' : 'Anonymous'}</h1>`); return }
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'fixture' }] })); return }
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw || '{}'); requests.push(body)
    const messages = body.messages ?? []
    const userIndex = messages.findLastIndex((message) => message.role === 'user')
    const user = textOf(messages[userIndex]?.content)
    const toolMessages = messages.slice(userIndex + 1).filter((message) => message.role === 'tool')
    const step = toolMessages.length
    let previous
    try { previous = JSON.parse(textOf(toolMessages.at(-1)?.content)) } catch { /* Tool errors end the fixture run. */ }
    const element = (name) => previous?.elements?.find((entry) => entry.name === name)
    let tool
    const scenario = /全流程|拒绝操作|接管测试|过期快照|越界上传|文件变化|停止测试/.test(user)
    if (scenario && step === 0) tool = ['browser_open', { url: `${base}/site` }]
    else if (scenario && previous?.snapshotId) {
      if (user.includes('越界上传') && step === 1) tool = ['browser_upload', { snapshotId: previous.snapshotId, ref: element('资料文件')?.ref, paths: ['../outside.txt'] }]
      else if (user.includes('文件变化') && step === 1) tool = ['browser_upload', { snapshotId: previous.snapshotId, ref: element('资料文件')?.ref, paths: ['upload.txt'] }]
      else if (step === 1) tool = ['browser_fill', { snapshotId: previous.snapshotId, fields: [{ ref: element('公司')?.ref, value: user.includes('全流程') ? 'Covan' : '禁止执行' }] }]
      else if (user.includes('全流程')) {
        if (step === 2) tool = ['browser_select', { snapshotId: previous.snapshotId, ref: element('方案')?.ref, value: 'pro' }]
        if (step === 3) tool = ['browser_upload', { snapshotId: previous.snapshotId, ref: element('资料文件')?.ref, paths: ['upload.txt'] }]
        if (step === 4) tool = ['browser_click', { snapshotId: previous.snapshotId, ref: element('确认报名')?.ref }]
        if (step === 5) tool = ['browser_click', { snapshotId: previous.snapshotId, ref: element('下载报告')?.ref }]
      }
    }
    const content = scenario ? (user.includes('全流程') && step >= 6 ? '已检查提交成功，并下载了真实报告。' : '操作已停止，请查看工作台。') : '收到。'
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    send({ role: 'assistant' })
    send(tool ? { tool_calls: [{ index: 0, id: `browser-${step}`, type: 'function', function: { name: tool[0], arguments: JSON.stringify(tool[1]) } }] } : { content })
    send({}, tool ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n')
  } catch (error) { errors.push(String(error)); res.statusCode = 500; res.end() }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
base = `http://127.0.0.1:${server.address().port}`

async function launch() {
  const env = { ...process.env, ELECTRON_RENDERER_URL: '', COVAN_USER_DATA_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [root], env })
  app.process().stderr.on('data', (chunk) => { if (/Uncaught Exception|UnhandledPromiseRejection/.test(chunk.toString())) errors.push('Unexpected main exception: ' + chunk.toString().slice(0, 500)) })
  page = await app.firstWindow(); page.on('pageerror', (error) => errors.push(error.message))
  await page.waitForFunction(() => !!window.covan)
}
const state = () => page.evaluate((id) => window.covan.getBrowserState(id), fixture.bot.id)
async function begin(text) {
  await page.evaluate(({ id, text }) => window.covan.sendUserMessage(id, text, []), { id: fixture.chat.id, text })
  await expect.poll(async () => (await state()).pending?.action, { timeout: 15000 }).toBe('open')
  await expect.poll(() => app.windows().some((window) => window.url().includes('browserBot='))).toBe(true)
  toolbar = app.windows().find((window) => window.url().includes('browserBot='))
  await toolbar.waitForFunction(() => !!window.covan)
}
async function approve(action) {
  await expect.poll(async () => (await state()).pending?.action, { timeout: 15000 }).toBe(action)
  await toolbar.getByRole('button', { name: '确认执行', exact: true }).click()
}
async function idle() {
  await expect.poll(() => page.evaluate(async (id) => (await window.covan.listMessages(id)).some((message) => message.status === 'streaming'), fixture.chat.id), { timeout: 20000 }).toBe(false)
}
// Reviewed fixture-only inspection of the remote view; never evaluates model-generated code.
async function remoteRead(expression) {
  return app.evaluate(async ({ webContents }, { base, expression }) => {
    const remote = webContents.getAllWebContents().find((entry) => entry.getURL().startsWith(base + '/'))
    if (!remote) throw new Error('Fixture view unavailable')
    return remote.executeJavaScript(expression)
  }, { base, expression })
}
async function resumeAgent() { await page.evaluate((id) => window.covan.setBrowserControl(id, 'agent'), fixture.bot.id) }

try {
  await launch()
  fixture = await page.evaluate(async (base) => {
    await window.covan.setSetting('natural_follow_up', '0')
    const provider = await window.covan.saveProvider({ name: '本地浏览器模拟', kind: 'openai-compatible', base_url: base + '/v1', default_model: 'fixture' })
    const bot = await window.covan.createBot({ name: '浏览器助手', provider_id: provider.id })
    await window.covan.setBrowserPolicy(bot.id, 'confirm')
    return { bot, chat: await window.covan.createDm(bot.id) }
  }, base)
  fs.mkdirSync(path.join(profile, 'workspaces', fixture.bot.id), { recursive: true })
  fs.writeFileSync(path.join(profile, 'workspaces', fixture.bot.id, 'upload.txt'), 'Synthetic upload fixture')
  await page.reload()
  await page.locator('aside').first().getByRole('button', { name: '浏览器助手', exact: true }).click()
  await begin('浏览器全流程')
  await approve('open')
  await expect.poll(async () => (await state()).pending?.action).toBe('fill')
  assert.equal(await remoteRead('typeof window.covan'), 'undefined')
  await approve('fill'); await approve('select'); await approve('upload'); await approve('click'); await approve('click'); await approve('download')
  await idle()
  assert.equal(submissions, 1); assert.equal(uploads, 1)
  assert.equal(await remoteRead('document.getElementById("company").value'), 'Covan')
  assert.equal(await remoteRead('document.getElementById("plan").value'), 'pro')
  assert.match(await remoteRead('document.getElementById("result").textContent'), /提交成功/)
  const downloaded = (await state()).downloads.find((entry) => entry.status === 'done')
  assert.ok(downloaded?.relPath)
  assert.equal(fs.readFileSync(path.join(profile, 'workspaces', fixture.bot.id, downloaded.relPath), 'utf8'), 'Covan verified report')
  const messages = await page.evaluate((id) => window.covan.listMessages(id), fixture.chat.id)
  assert.ok(messages.some((message) => message.artifacts.some((artifact) => artifact.relPath === downloaded.relPath)))
  assert.ok(!JSON.stringify(requests).includes('fixture-password-never-send'), '密码值不进入模型输入')
  assert.ok(!JSON.stringify(requests).includes('旧内容'), '输入框当前值及其 AX 子节点不进入模型快照')
  const capture = await app.evaluate(async ({ BrowserWindow }) => {
    const workspace = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('browserBot='))
    const children = workspace.contentView.children
    const remote = children.find((view) => view.webContents?.getURL().includes('/site'))
    if (!remote?.getVisible() || remote.getBounds().x !== 300 || remote.getBounds().y !== 140 || children.indexOf(remote) < children.indexOf(children.find((view) => view.webContents === workspace.webContents))) throw new Error('Remote browser view must be visible above the chrome content at its reserved bounds')
    return (await workspace.capturePage()).toPNG().toString('base64')
  })
  fs.writeFileSync(path.join(artifacts, 'workbench.png'), Buffer.from(capture, 'base64'))
  const remoteCapture = await app.evaluate(async ({ webContents }, url) => {
    const remote = webContents.getAllWebContents().find((entry) => entry.getURL() === url)
    return (await remote.capturePage()).toPNG().toString('base64')
  }, base + '/site')
  fs.writeFileSync(path.join(artifacts, 'webpage.png'), Buffer.from(remoteCapture, 'base64'))
  console.log('✓ Real broker tools, visible approvals, text/select/upload/click/download, result verification and delivery card')

  await begin('拒绝操作'); await approve('open')
  await expect.poll(async () => (await state()).pending?.action).toBe('fill')
  const deniedId = (await state()).pending.id
  await toolbar.getByRole('button', { name: '拒绝', exact: true }).click(); await idle()
  assert.equal(await remoteRead('document.getElementById("company").value'), 'Covan')
  await assert.rejects(() => page.evaluate(({ id, approvalId }) => window.covan.respondBrowserApproval(id, approvalId, true), { id: fixture.bot.id, approvalId: deniedId }), /失效/)
  console.log('✓ Denial has no side effect; consumed approval cannot be replayed')

  await begin('接管测试'); await approve('open')
  await expect.poll(async () => (await state()).pending?.action).toBe('fill')
  await toolbar.getByRole('button', { name: '接管浏览器', exact: true }).click()
  await expect.poll(async () => (await state()).handoff?.kind).toBe('control')
  assert.equal((await state()).pending, null)
  const takeoverId = (await state()).handoff.id
  await page.evaluate(({ id, handoffId }) => window.covan.completeBrowserHandoff(id, handoffId, false), { id: fixture.bot.id, handoffId: takeoverId }); await idle()
  assert.equal((await state()).mode, 'human'); assert.equal((await state()).pending, null)
  assert.equal(await remoteRead('document.getElementById("company").value'), 'Covan')
  await resumeAgent()
  await begin('过期快照'); await approve('open')
  await expect.poll(async () => (await state()).pending?.action).toBe('fill')
  await remoteRead('document.getElementById("company").setAttribute("aria-label", "changed by fixture")')
  await approve('fill'); await idle()
  assert.equal(await remoteRead('document.getElementById("company").value'), 'Covan')
  await remoteRead('document.getElementById("company").removeAttribute("aria-label")')
  console.log('✓ Human takeover pauses pending work and cancellation revokes it; changed targets invalidate approval')

  await begin('越界上传'); await approve('open'); await idle()
  assert.equal((await state()).pending, null); assert.equal(uploads, 1)
  await begin('文件变化'); await approve('open')
  await expect.poll(async () => (await state()).pending?.action).toBe('upload')
  fs.writeFileSync(path.join(profile, 'workspaces', fixture.bot.id, 'upload.txt'), 'Changed after approval was requested')
  await approve('upload'); await idle(); assert.equal(uploads, 1)
  await begin('停止测试')
  await page.evaluate((id) => window.covan.stopChat(id), fixture.chat.id); await idle()
  assert.equal((await state()).pending, null); assert.equal((await state()).mode, 'human')
  console.log('✓ Upload path isolation and stopping the chat revokes approvals and control')

  await page.evaluate(({ id, url }) => window.covan.navigateBrowser(id, url), { id: fixture.bot.id, url: base + '/login' })
  await page.evaluate(({ id, url }) => window.covan.navigateBrowser(id, url), { id: fixture.bot.id, url: base + '/profile' })
  assert.equal(await remoteRead('document.body.textContent'), 'Signed in')
  // A user-owned browser download still receives a trusted confirmation.
  await page.evaluate(({ id, url }) => window.covan.navigateBrowser(id, url), { id: fixture.bot.id, url: base + '/site' })
  await remoteRead('document.querySelector("a").click()')
  await approve('download')
  await expect.poll(async () => (await state()).downloads.filter((entry) => entry.status === 'done').length).toBe(2)
  await remoteRead('(() => { const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob(["client-generated report"], {type:"text/plain"})); link.download="client-report.txt"; document.body.append(link); link.click(); })()')
  await approve('download')
  await expect.poll(async () => (await state()).downloads.filter((entry) => entry.status === 'done').length).toBe(3)
  await app.close(); await launch()
  await page.evaluate((id) => window.covan.openBrowser(id), fixture.bot.id)
  await page.evaluate(({ id, url }) => window.covan.navigateBrowser(id, url), { id: fixture.bot.id, url: base + '/profile' })
  assert.equal(await remoteRead('document.body.textContent'), 'Signed in')
  const other = await page.evaluate(async () => window.covan.createBot({ name: '隔离浏览器' }))
  await page.evaluate((id) => window.covan.openBrowser(id), other.id)
  await page.evaluate(({ id, url }) => window.covan.navigateBrowser(id, url), { id: other.id, url: base + '/profile' })
  const anonymous = await app.evaluate(async ({ webContents }, url) => {
    const views = webContents.getAllWebContents().filter((entry) => entry.getURL() === url)
    return Promise.all(views.map((entry) => entry.executeJavaScript('document.body.textContent')))
  }, base + '/profile')
  assert.deepEqual(anonymous.sort(), ['Anonymous', 'Signed in'])
  await page.evaluate((id) => window.covan.resetBrowserSession(id), fixture.bot.id)
  assert.equal((await state()).opened, false)
  assert.deepEqual(errors, [])
  console.log('✓ Login persists after restart, other Bots are isolated, and session reset closes the workspace')
  console.log('Browser UI regression passed.')
} catch (error) {
  await toolbar?.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {})
  fs.writeFileSync(path.join(artifacts, 'fixture-debug.json'), JSON.stringify({ errors, state: await state().catch(() => null), lastRequests: requests.slice(-3) }, null, 2))
  throw error
} finally {
  await app?.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve))
  fs.rmSync(profile, { recursive: true, force: true })
}
