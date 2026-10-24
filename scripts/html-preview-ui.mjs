// Real Electron regression: fictional HTML, local resources and loopback only.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'
import { expect } from '@playwright/test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'covan-html-preview-'))
const artifacts = path.join(root, 'artifacts', 'html-preview')
fs.mkdirSync(artifacts, { recursive: true })
const errors = [], consoleMessages = [], remoteRequests = []
const remote = http.createServer((request, response) => {
  remoteRequests.push({ url: request.url, referrer: request.headers.referer || '' })
  response.setHeader('Access-Control-Allow-Origin', '*')
  if (request.url === '/library.js') {
    response.setHeader('Content-Type', 'text/javascript')
    response.end("document.querySelector('#remote').textContent='remote JS ready'")
  } else {
    response.setHeader('Content-Type', 'text/css')
    response.end('h1 { color: rgb(50, 120, 200); }')
  }
})
let app, page
try {
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve))
  const remoteUrl = `http://127.0.0.1:${remote.address().port}`
  app = await electron.launch({ args: [root], env: {
    PATH: process.env.PATH, HOME: os.homedir(), TMPDIR: os.tmpdir(),
    ELECTRON_RENDERER_URL: '', COVAN_USER_DATA_DIR: profile,
  } })
  page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    // Keep only relevant diagnostics, never base64 font payloads.
    if (/covan-preview|script execution|inline script|game\.|escape/.test(message.text())) consoleMessages.push(message.text().slice(0, 800))
  })
  await expect(page.getByRole('button', { name: '创建你的 Bot' })).toBeVisible()
  const fixture = await page.evaluate(async () => {
    const provider = await window.covan.saveProvider({ name: 'HTML Mock', kind: 'mock' })
    const bot = await window.covan.createBot({ name: '游戏预览测试', provider_id: provider.id })
    const chat = await window.covan.createDm(bot.id)
    const other = await window.covan.createBot({ name: '另一个工作区', provider_id: provider.id })
    return { bot, chat, other }
  })
  const workspace = path.join(profile, 'workspaces', fixture.bot.workspace_dir)
  fs.mkdirSync(path.join(workspace, 'game', 'assets'), { recursive: true })
  const outside = path.join(profile, 'outside.txt')
  fs.writeFileSync(outside, 'OUTSIDE SENTINEL')
  fs.writeFileSync(path.join(profile, 'workspaces', fixture.other.workspace_dir, 'other.txt'), 'OTHER BOT SENTINEL')
  const gamePath = path.join(workspace, 'game', '俄罗斯方块 #1.html')
  const game = fs.readFileSync(path.join(root, 'scripts/fixtures/preview-game.html'), 'utf8')
    .replace('</head>', `<link rel="stylesheet" href="${remoteUrl}/style.css"></head>`)
    .replace('</body>', `<script src="${remoteUrl}/library.js"></script></body>`)
  fs.writeFileSync(gamePath, game)
  fs.writeFileSync(path.join(workspace, 'game', 'assets', 'game.css'), 'body { background: rgb(16, 24, 39); color: white; }')
  fs.writeFileSync(path.join(workspace, 'game', 'assets', 'game.mjs'), "import { label } from './value.mjs'; document.querySelector('#module').textContent=label;")
  fs.writeFileSync(path.join(workspace, 'game', 'assets', 'value.mjs'), "export const label = 'module ready';")
  fs.writeFileSync(path.join(workspace, 'game', 'assets', 'data.json'), JSON.stringify({ label: 'data ready' }))
  fs.writeFileSync(path.join(workspace, 'game', 'assets', 'tile.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="orange"/></svg>')
  fs.symlinkSync(outside, path.join(workspace, 'game', 'assets', 'escape.txt'))
  fs.symlinkSync(outside, path.join(workspace, 'escape.html'))
  fs.writeFileSync(path.join(workspace, 'large.html'), 'x'.repeat(2 * 1024 * 1024 + 1))
  fs.writeFileSync(path.join(workspace, 'binary.html'), Buffer.from([0, 1, 2]))
  fs.writeFileSync(path.join(workspace, 'other.html'), '<h1>另一个 HTML</h1><script>document.body.dataset.ran="yes"</script>')
  fs.writeFileSync(path.join(workspace, 'readme.md'), '# Markdown 仍可预览')
  const files = ['game/俄罗斯方块 #1.html', 'other.html', 'readme.md', 'missing.html']
  await app.evaluate(({ app }, fixture) => {
    const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path')
    const { createRequire } = process.getBuiltinModule('module')
    const Database = createRequire(app.getAppPath() + '/package.json')('better-sqlite3')
    const db = new Database(path.join(app.getPath('userData'), 'covan.db'))
    const artifacts = fixture.files.map(relPath => ({ relPath, name: path.basename(relPath), size: fs.existsSync(path.join(fixture.workspace, relPath)) ? fs.statSync(path.join(fixture.workspace, relPath)).size : 1, mtime: Date.now(), operation: 'write' }))
    db.prepare('INSERT INTO messages (id,chat_id,sender_type,sender_bot_id,content,artifacts,status,created_at) VALUES (?,?,?,?,?,?,?,?)').run('html-game-fixture', fixture.chat.id, 'bot', fixture.bot.id, '游戏已生成', JSON.stringify(artifacts), 'done', Date.now())
    db.close()
  }, { ...fixture, workspace, files })
  await page.reload()
  await page.getByRole('complementary', { name: '会话导航' }).getByRole('button', { name: '游戏预览测试', exact: true }).click()
  const open = name => page.locator('.artifact-file').filter({ hasText: name }).getByRole('button', { name: '预览', exact: true }).click()
  await open('俄罗斯方块 #1.html')
  const iframe = page.locator('.artifact-preview-frame')
  const frame = page.frameLocator('.artifact-preview-frame')
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts')
  await expect(frame.locator('#module')).toHaveText('module ready')
  await expect(frame.locator('#data')).toHaveText('data ready')
  await expect(frame.locator('#remote')).toHaveText('remote JS ready')
  await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(16, 24, 39)')
  await expect(frame.getByRole('heading')).toHaveCSS('color', 'rgb(50, 120, 200)')
  await expect(frame.locator('body')).toHaveAttribute('data-animated', 'yes')
  assert.ok(await frame.getByAltText('本地方块').evaluate(image => image.complete && image.naturalWidth === 32))
  assert.deepEqual(await frame.locator('canvas').evaluate(canvas => [...canvas.getContext('2d').getImageData(15, 15, 1, 1).data]), [255, 153, 0, 255])
  await frame.getByRole('button', { name: '向右移动', exact: true }).click()
  await page.keyboard.press('ArrowRight')
  await expect(frame.locator('#moves')).toHaveText('2')
  await frame.getByRole('button', { name: '内嵌事件', exact: true }).click()
  await expect(frame.locator('#inline')).toHaveText('clicked')
  const originalUrl = await iframe.getAttribute('src')
  await page.screenshot({ path: path.join(artifacts, 'interactive-game.png') })
  console.log('✓ Inline JS/events, Canvas, animation, keyboard/mouse, CSS, modules, images and fetch work')

  // Only a fixture URL is changed here, to pass the synthetic outside sentinel.
  await iframe.evaluate((element, outside) => { element.src += '?outside=' + encodeURIComponent(outside) }, pathToFileURL(outside).href)
  await expect(frame.locator('#module')).toHaveText('module ready')
  await frame.getByRole('button', { name: '检查隔离', exact: true }).click()
  await expect(frame.locator('#isolation')).not.toHaveText('')
  const isolation = JSON.parse(await frame.locator('#isolation').innerText())
  assert.deepEqual(isolation, { bridge: 'undefined', node: 'undefined', process: 'undefined', parent: 'blocked', storage: 'blocked', popup: 'blocked', symlink: 404, directory: 404, traversal: 404, otherPreview: 'blocked', privateProtocol: 'blocked', file: 'blocked' })
  assert.equal((await app.windows()).length, 1)
  assert.ok(remoteRequests.length >= 2 && remoteRequests.every(request => request.referrer === ''))
  const shellUrl = page.url()
  await frame.getByRole('button', { name: '离开预览', exact: true }).click()
  await expect(frame.getByRole('heading')).toHaveText('预览游戏回归')
  assert.equal(page.url(), shellUrl)
  console.log('✓ No bridge/Node/parent access, popup, private protocol, local file or workspace escape')

  const status = url => app.evaluate(async ({ net }, url) => (await net.fetch(url)).status, url)
  assert.equal(await status(originalUrl), 200)
  await page.getByRole('button', { name: '重新加载预览', exact: true }).click()
  await expect(frame.locator('#module')).toHaveText('module ready')
  await expect(frame.locator('#moves')).toHaveText('0')
  const reloadedUrl = await iframe.getAttribute('src')
  assert.notEqual(reloadedUrl, originalUrl)
  assert.equal(await status(originalUrl), 403)
  // Reload really rereads disk, not an old srcdoc snapshot.
  fs.writeFileSync(path.join(workspace, 'game', 'assets', 'data.json'), JSON.stringify({ label: 'updated data' }))
  await page.getByRole('button', { name: '重新加载预览', exact: true }).click()
  await expect(frame.locator('#data')).toHaveText('updated data')
  const currentUrl = await iframe.getAttribute('src')
  const crossBotUrl = new URL(`/${fixture.other.id}/other.txt`, currentUrl).href
  assert.equal(await status(crossBotUrl), 404)
  await open('other.html')
  await expect(frame.getByRole('heading')).toHaveText('另一个 HTML')
  await expect(frame.locator('body')).toHaveAttribute('data-ran', 'yes')
  assert.equal(await status(currentUrl), 403)
  const otherUrl = await iframe.getAttribute('src')
  await open('readme.md')
  await expect(page.locator('.artifact-preview-markdown')).toContainText('Markdown 仍可预览')
  assert.equal(await status(otherUrl), 403)
  await open('missing.html')
  await expect(page.locator('.artifact-preview-panel').getByRole('alert')).toBeVisible()
  await open('other.html')
  await expect(frame.getByRole('heading')).toHaveText('另一个 HTML')
  const closingUrl = await iframe.getAttribute('src')
  await page.getByRole('button', { name: '关闭预览', exact: true }).click()
  await expect(page.locator('.artifact-preview-frame')).toHaveCount(0)
  await expect.poll(() => status(closingUrl)).toBe(403)
  console.log('✓ Reload/switch/close revoke old capabilities; Markdown and visible HTML errors still work')

  for (const relPath of ['../outside.html', 'escape.html', 'large.html', 'binary.html', 'readme.md']) {
    const result = await page.evaluate(async ({ botId, relPath }) => {
      try { await window.covan.createWorkspaceHtmlPreview(botId, relPath); return 'unexpected success' }
      catch { return 'rejected' }
    }, { botId: fixture.bot.id, relPath })
    assert.equal(result, 'rejected', relPath)
  }
  await open('other.html')
  await expect(frame.getByRole('heading')).toHaveText('另一个 HTML')
  const beforeNavigation = await iframe.getAttribute('src')
  await page.reload()
  assert.equal(await status(beforeNavigation), 403)
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({ outcome: 'passed', isolation, remoteRequests, errors, consoleMessages }, null, 2))
  console.log('✓ Invalid inputs and main-page navigation revoke/reject access')
  console.log('HTML preview Electron regression passed. Artifacts: ' + artifacts)
} catch (error) {
  await page?.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {})
  fs.writeFileSync(path.join(artifacts, 'failure.json'), JSON.stringify({ errors, consoleMessages }, null, 2))
  throw error
} finally {
  await app?.close()
  await new Promise(resolve => remote.close(resolve))
  fs.rmSync(profile, { recursive: true, force: true })
}
