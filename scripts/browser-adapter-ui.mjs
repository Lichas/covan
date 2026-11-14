// Two real browser implementations, one Broker/UI contract. All data, credentials and HTTP requests are synthetic.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { expect } from '@playwright/test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.join(root, 'artifacts/browser-adapters'); fs.mkdirSync(artifacts, { recursive: true })
const text = (value) => typeof value === 'string' ? value : (value ?? []).map((part) => part.text ?? '').join('\n')
let app, page, fixture, base, releaseModel, modelWaiting, step = 0, submissions = 0, uploads = 0
const requests = [], errors = [], logins = [], profiles = [], typedInputs = [], scrolls = []
const site = http.createServer(async (req, res) => {
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    const style = '<style>body{font:16px system-ui;margin:24px;background:#eef5ff;color:#123;min-height:1600px}h1{margin:0;font-size:24px}input{position:absolute;left:24px;top:80px;width:300px;height:36px;font-size:16px;box-sizing:border-box}button{position:absolute;left:24px;top:200px;width:180px;height:40px}a{position:absolute;left:24px;top:260px}input[type=file]{top:140px}</style>'
    if (req.url === '/work') return res.end(style + '<h1>浏览器适配测试</h1><input aria-label="公司" value="initial" oninput="fetch(\'/typed\',{method:\'POST\',body:this.value})"><input type="file" aria-label="附件"><button onclick="fetch(\'/submitted\',{method:\'POST\'}).then(()=>document.querySelector(\'h1\').textContent=\'提交已验证\')">确认提交</button><a href="/download">下载结果</a><script>onscroll=()=>fetch("/scrolled",{method:"POST",body:String(scrollY)});document.querySelector(\'[type=file]\').onchange=()=>fetch("/uploaded",{method:"POST",body:document.querySelector("[type=file]").files[0]})</script>')
    if (req.url === '/auth') return res.end(style + '<h1>登录</h1><form action="/signed" method="POST"><input aria-label="账号" name="username" autocomplete="username"><input style="top:140px" aria-label="密码" name="password" type="password"><button>登录</button></form>')
    if (req.url === '/signed') { let raw = ''; for await (const chunk of req) raw += chunk; logins.push(raw); res.setHeader('Set-Cookie', 'adapter-login=1; Path=/; Max-Age=3600; HttpOnly'); return res.end(style + '<h1>登录完成</h1><p>当前会话可继续</p>') }
    if (req.url === '/profile') { profiles.push(req.headers.cookie ?? ''); if (req.headers.cookie?.includes('adapter-login=1')) return res.end(style + '<h1>会话已保留</h1>'); return res.end(style + '<h1>未登录</h1>') }
    if (req.url === '/download') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="adapter-result.txt"' }); return res.end('adapter verified bytes') }
    if (req.url === '/typed' || req.url === '/scrolled') { let raw = ''; for await (const chunk of req) raw += chunk; (req.url === '/typed' ? typedInputs : scrolls).push(raw); return res.end('ok') }
    if (req.url === '/submitted' || req.url === '/uploaded') { for await (const _chunk of req) {} if (req.url === '/submitted') submissions++; else uploads++; return res.end('ok') }
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'fixture' }] }))
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw || '{}'); requests.push(body)
    const messages = body.messages ?? [], userIndex = messages.findLastIndex((message) => message.role === 'user')
    const user = text(messages[userIndex]?.content)
    const results = messages.slice(userIndex + 1).filter((message) => message.role === 'tool')
    let previous; try { previous = JSON.parse(text(results.at(-1)?.content)) } catch {}
    const ref = (name) => previous?.elements?.find((element) => element.name === name)?.ref
    let tool
    if (user.includes('适配器任务') && body.tools?.some((tool) => tool.function?.name === 'browser_open')) {
      if (step === 0) tool = ['browser_open', { url: base + '/work' }]
      if (step === 1) { modelWaiting = true; await new Promise((resolve) => { releaseModel = resolve }); tool = ['browser_snapshot', {}] }
      if (step === 2) tool = ['browser_fill', { snapshotId: previous.snapshotId, fields: [{ ref: ref('公司'), value: 'Covan adapter' }] }]
      if (step === 3) tool = ['browser_upload', { snapshotId: previous.snapshotId, ref: ref('附件'), paths: ['upload.txt'] }]
      if (step === 4) tool = ['browser_click', { snapshotId: previous.snapshotId, ref: ref('确认提交') }]
      if (step === 5) tool = ['browser_click', { snapshotId: previous.snapshotId, ref: ref('下载结果') }]
      if (step === 6) tool = ['browser_open', { url: base + '/auth' }]
      step++
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    send({ role: 'assistant' }); send(tool ? { tool_calls: [{ index: 0, id: `adapter-action-${step}`, type: 'function', function: { name: tool[0], arguments: JSON.stringify(tool[1]) } }] } : { content: '浏览器流程与下载已核对。' }); send({}, tool ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n')
  } catch (error) { errors.push(String(error)); res.statusCode = 500; res.end() }
})
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${site.address().port}`
const state = () => page.evaluate((id) => window.covan.getBrowserState(id), fixture.bot.id)
const idle = () => expect.poll(() => page.evaluate(async (id) => (await window.covan.listMessages(id)).some((message) => message.status === 'streaming'), fixture.chat.id), { timeout: 30000 }).toBe(false)
async function launch(profile) {
  const env = { ...process.env, ELECTRON_RENDERER_URL: '', COVAN_USER_DATA_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [root], env }); page = await app.firstWindow(); page.on('pageerror', (error) => errors.push(error.message)); await page.waitForFunction(() => !!window.covan)
  app.process().stderr.on('data', (data) => { if (/Uncaught Exception|UnhandledPromiseRejection/.test(String(data))) errors.push('Unexpected main exception') })
}
async function focusMain() { await app.evaluate(({ app, BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find((entry) => !entry.webContents.getURL().includes('browserBot=')); app.focus({ steal: true }); window.show(); window.focus() }) }
async function imageClick(x, y) {
  await focusMain()
  const panel = page.getByRole('complementary', { name: '浏览器预览', exact: true })
  const image = panel.getByRole('img', { name: '浏览器实时画面', exact: true })
  await expect(image).toBeVisible()
  const current = await state(), frame = await page.evaluate(({ botId, taskId }) => window.covan.getBrowserFrame(botId, taskId), { botId: fixture.bot.id, taskId: current.currentTaskId })
  const bounds = await image.boundingBox()
  await image.click({ position: { x: x / frame.width * bounds.width, y: y / frame.height * bounds.height } })
  // Image focus is forwarded to a user-only textarea for native IME/paste support.
  await expect(panel.getByLabel('浏览器键盘输入', { exact: true })).toBeFocused()
}
try {
  for (const backend of ['embedded', 'local-chrome']) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'covan-adapter-ui-'))
    try {
      step = 0; modelWaiting = false
      await launch(profile)
      fixture = await page.evaluate(async ({ base, backend }) => {
        await window.covan.setSetting('natural_follow_up', '0')
        const provider = await window.covan.saveProvider({ name: 'Adapter fixture', kind: 'openai-compatible', base_url: base + '/v1', default_model: 'fixture' })
        const bot = await window.covan.createBot({ name: '浏览器适配助手', provider_id: provider.id })
        const available = (await window.covan.getBrowserState(bot.id)).availableBackends
        if (!available.some((entry) => entry.id === backend)) throw new Error('Local Chrome is required for this regression')
        await window.covan.setBrowserBackend(bot.id, backend)
        return { bot, chat: await window.covan.createDm(bot.id) }
      }, { base, backend })
      fs.mkdirSync(path.join(profile, 'workspaces', fixture.bot.id), { recursive: true }); fs.writeFileSync(path.join(profile, 'workspaces', fixture.bot.id, 'upload.txt'), 'adapter synthetic upload')
      await page.reload(); await page.locator('aside').first().getByRole('button', { name: '浏览器适配助手', exact: true }).click()
      await page.evaluate((id) => window.covan.sendUserMessage(id, '执行适配器任务', []), fixture.chat.id)
      await expect.poll(() => modelWaiting, { timeout: 20000 }).toBe(true)
      const initial = await state(); assert.equal(initial.backend, backend); assert.ok(initial.currentTaskId)
      await focusMain()
      const card = page.getByRole('region', { name: '浏览器任务', exact: true }); await expect(card).toBeVisible(); await expect(card.getByRole('img', { name: '浏览器实时画面' })).toBeVisible()
      const frame = await page.evaluate(({ botId, taskId }) => window.covan.getBrowserFrame(botId, taskId), { botId: fixture.bot.id, taskId: initial.currentTaskId }); assert.ok(frame.width > 500); assert.match(frame.dataUrl, /^data:image\/jpeg;base64,/)
      await assert.rejects(() => page.evaluate(({ botId, taskId, frameId }) => window.covan.sendBrowserInput(botId, taskId, frameId, { type: 'click', x: 0, y: 0 }), { botId: fixture.bot.id, taskId: initial.currentTaskId, frameId: frame.id }), /先接管/)
      await card.getByRole('button', { name: '打开浏览器', exact: true }).click()
      const panel = page.getByRole('complementary', { name: '浏览器预览', exact: true }); await expect(panel).toBeVisible()
      await panel.getByRole('button', { name: '接管浏览器', exact: true }).click()
      await expect.poll(async () => (await state()).handoff?.kind).toBe('control')
      await assert.rejects(() => page.evaluate(({ botId, taskId, frameId }) => window.covan.sendBrowserInput(botId, taskId, frameId, { type: 'click', x: 0, y: 0 }), { botId: fixture.bot.id, taskId: initial.currentTaskId, frameId: frame.id }), /画面已更新/)
      await imageClick(80, 95)
      await panel.getByLabel('浏览器键盘输入', { exact: true }).press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
      await panel.getByLabel('浏览器键盘输入', { exact: true }).pressSequentially('human edit')
      await panel.getByLabel('浏览器键盘输入', { exact: true }).evaluate((element) => {
        // Fixed synthetic IME events test our renderer path; never model-generated code.
        element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
        element.value = '中文'
        element.dispatchEvent(new InputEvent('input', { bubbles: true, data: '中文', isComposing: true }))
        element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }))
      })
      await expect.poll(() => typedInputs.at(-1)).toBe('human edit中文')
      await panel.getByRole('img', { name: '浏览器实时画面' }).hover()
      await page.mouse.wheel(0, 180); await expect.poll(() => Number(scrolls.at(-1))).toBeGreaterThan(0)
      await page.mouse.wheel(0, -180); await expect.poll(() => Number(scrolls.at(-1))).toBe(0)
      await expect.poll(async () => panel.getByRole('alert').allTextContents()).toEqual([])
      await page.screenshot({ path: path.join(artifacts, `${backend}-takeover.png`) })
      releaseModel(); await expect.poll(() => step).toBe(2)
      assert.equal((await state()).handoff.kind, 'control', '新工具调用应等待人工交还，不能结束或夺回控制权')
      await panel.getByRole('button', { name: '交还并继续', exact: true }).first().click()
      await expect.poll(async () => (await state()).mode).toBe('agent')
      await expect.poll(async () => (await state()).handoff?.kind, { timeout: 30000 }).toBe('login')
      await imageClick(80, 95); await panel.getByLabel('浏览器键盘输入', { exact: true }).pressSequentially('fixture-user')
      await imageClick(80, 155); await panel.getByLabel('浏览器键盘输入', { exact: true }).pressSequentially('human-only-secret')
      await imageClick(80, 220)
      await expect.poll(async () => (await state()).url).toBe(base + '/signed')
      await panel.getByRole('button', { name: '交还并继续', exact: true }).first().click(); await idle()
      const done = await state(), downloaded = done.downloads.find((entry) => entry.status === 'done')
      assert.equal(fs.readFileSync(path.join(profile, 'workspaces', fixture.bot.id, downloaded.relPath), 'utf8'), 'adapter verified bytes')
      assert.equal(logins.at(-1), 'username=fixture-user&password=human-only-secret')
      assert.ok(!JSON.stringify(requests).includes('human-only-secret')); assert.ok(!JSON.stringify(requests).includes('human edit'))
      assert.equal(done.tasks.find((task) => task.id === initial.currentTaskId).status, 'ended')
      assert.equal((await page.evaluate((id) => window.covan.listMessages(id), fixture.chat.id)).filter((message) => message.sender_type === 'user').length, 1)
      await focusMain()
      await expect(panel.getByRole('region', { name: '需要登录', exact: true })).toHaveCount(0)
      const finalFrame = await page.evaluate(({ botId, taskId }) => window.covan.getBrowserFrame(botId, taskId), { botId: fixture.bot.id, taskId: initial.currentTaskId })
      await expect.poll(() => panel.getByRole('img', { name: '浏览器实时画面' }).getAttribute('src')).toBe(finalFrame.dataUrl)
      await page.screenshot({ path: path.join(artifacts, `${backend}-completed.png`) })
      // Closed connections revoke old frame controls; metadata survives restart without storing pixels.
      await page.evaluate((id) => window.covan.closeBrowser(id), fixture.bot.id)
      assert.equal(await page.evaluate(({ botId, taskId }) => window.covan.getBrowserFrame(botId, taskId), { botId: fixture.bot.id, taskId: initial.currentTaskId }), null)
      await app.close(); app = null; await launch(profile)
      assert.equal((await state()).backend, backend); assert.equal((await state()).tasks.length, 1)
      await page.evaluate(async ({ botId, url }) => { await window.covan.openBrowser(botId); await window.covan.navigateBrowser(botId, url) }, { botId: fixture.bot.id, url: base + '/profile' })
      assert.match(profiles.at(-1), /adapter-login=1/)
      await page.evaluate((id) => window.covan.resetBrowserSession(id), fixture.bot.id)
      assert.equal((await state()).opened, false)
      console.log(`✓ ${backend}: real frame card, in-chat control, same-turn handback, login, upload/download, restart and revoked frames`)
    } catch (error) { console.error('Fixture stage', { backend, step, modelWaiting }); await page?.screenshot({ path: path.join(artifacts, `${backend}-failure.png`) }).catch(() => {}); throw error } finally { releaseModel?.(); await app?.close(); app = null; fs.rmSync(profile, { recursive: true, force: true }) }
  }
  assert.equal(submissions, 2); assert.equal(uploads, 2); assert.deepEqual(errors, [])
  console.log('Browser adapter UI regression passed.')
} catch (error) { await page?.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {}); throw error }
finally { releaseModel?.(); await app?.close(); site.closeAllConnections(); await new Promise((resolve) => site.close(resolve)) }
