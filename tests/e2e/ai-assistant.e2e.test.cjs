const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '../..')

/** 后台启动隔离的真实 Electron 应用，避免测试读写用户笔记和 AI 设置。 */
// 受限沙箱（如无 GUI 权限的容器）里 Chromium 子进程无法初始化自身 sandbox，主进程会以
// "GPU process isn't usable" 崩溃退出。需要时用该环境变量注入 --no-sandbox / --disable-gpu
// 一类的开关；不设置时行为与原来完全一致。
const extraLaunchArgs = (process.env.XINYUE_E2E_ELECTRON_ARGS || '').split(/\s+/).filter(Boolean)

async function launchApplication(userDataPath) {
  const electronApplication = await electron.launch({
    args: [...extraLaunchArgs, projectRoot],
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      XINYUE_NOTES_E2E_USER_DATA: userDataPath
    }
  })
  try {
    const page = await electronApplication.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean(window.notesDesktop))
    return { electronApplication, page }
  } catch (error) {
    await electronApplication.close().catch(() => {})
    throw error
  }
}

test('AI 助手面板提供范围、隐私提示和本机模型设置', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-ai-e2e-'))
  let application

  try {
    application = await launchApplication(userDataPath)
    await application.page.evaluate(async () => {
      const folder = await window.notesDesktop.createFolder('AI 测试', null)
      const note = await window.notesDesktop.createNote(folder.id)
      await window.notesDesktop.updateNote(note.id, {
        title: '并发方案',
        content: '线程池适合 IO 密集任务。'
      })
      await window.notesDesktop.saveWorkspaceSession({
        tabs: [{ noteId: note.id, isPinned: false }],
        activeNoteId: note.id
      })
    })
    await application.page.reload()

    await application.page.getByRole('button', { name: 'AI 笔记助手' }).click()
    const panel = application.page.getByRole('complementary', { name: 'AI 笔记助手' })
    await panel.waitFor()
    assert.match(await panel.innerText(), /当前笔记/)
    assert.match(await panel.innerText(), /当前文件夹/)
    assert.match(await panel.innerText(), /全部笔记/)
    assert.match(await panel.innerText(), /密钥由系统安全存储加密/)
    assert.equal(await panel.locator('.ai-primary-action kbd').innerText(), '⌘ Enter')
    assert.ok(Number.parseFloat(await panel.locator('.ai-primary-action kbd').evaluate((element) => getComputedStyle(element).fontSize)) >= 12)
    assert.equal(await panel.getByText('并发方案').count(), 1)
    assert.equal(await panel.getByRole('button', { name: /查找并分析/ }).isDisabled(), true)

    await panel.getByLabel('模型名称').fill('test-model')
    await panel.getByLabel('API Key').fill('test-key')
    await panel.getByRole('button', { name: '保存设置' }).click()
    await assert.doesNotReject(panel.getByText('test-model').waitFor())
    assert.equal(await panel.getByText(/An object could not be cloned/).count(), 0)

    await panel.getByRole('button', { name: '关闭 AI 助手' }).click()
    await panel.waitFor({ state: 'detached' })
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

test('AI 回答按 Markdown 渲染并清理不安全 HTML', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-ai-markdown-e2e-'))
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      choices: [{ message: { content: '**关键结论**\n\n- 第一项\n- 第二项\n\n<script>window.__unsafeAi = true</script> [S1]' } }]
    }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  let application

  try {
    application = await launchApplication(userDataPath)
    await application.page.evaluate(async () => {
      const note = await window.notesDesktop.createNote(null)
      await window.notesDesktop.updateNote(note.id, { title: 'Markdown 来源', content: '用于生成回答的正文。' })
      await window.notesDesktop.saveWorkspaceSession({ tabs: [{ noteId: note.id, isPinned: false }], activeNoteId: note.id })
    })
    await application.page.reload()
    await application.page.getByRole('button', { name: 'AI 笔记助手' }).click()
    const panel = application.page.getByRole('complementary', { name: 'AI 笔记助手' })
    await panel.getByLabel('接口地址').fill(`http://127.0.0.1:${address.port}`)
    await panel.getByLabel('模型名称').fill('markdown-test')
    await panel.getByLabel('API Key').fill('test-key')
    await panel.getByRole('button', { name: '保存设置' }).click()
    await panel.getByLabel('你想从笔记中了解什么？').fill('总结正文')
    await panel.getByRole('button', { name: /查找并分析/ }).click()

    const renderedAnswer = panel.locator('.ai-answer-text')
    await renderedAnswer.getByText('关键结论').waitFor()
    assert.equal(await renderedAnswer.locator('strong').innerText(), '关键结论')
    assert.equal(await renderedAnswer.locator('li').count(), 2)
    assert.equal(await renderedAnswer.locator('script').count(), 0)
    assert.equal(await application.page.evaluate(() => window.__unsafeAi), undefined)
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

test('没有打开笔记时顶部 AI 入口仍可用并默认全部笔记', { timeout: 60_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-ai-empty-e2e-'))
  let application

  try {
    application = await launchApplication(userDataPath)
    const aiButton = application.page.locator('.titlebar').getByRole('button', { name: 'AI 笔记助手' })
    await aiButton.click()
    const panel = application.page.getByRole('complementary', { name: 'AI 笔记助手' })
    await panel.waitFor()
    assert.equal(await panel.getByRole('button', { name: '全部笔记' }).getAttribute('aria-pressed'), 'true')
    assert.equal(await application.page.locator('.editor-meta').count(), 0)
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})
