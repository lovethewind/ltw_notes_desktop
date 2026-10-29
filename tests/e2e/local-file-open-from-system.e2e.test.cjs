/**
 * 系统请求打开文件（拖到 Dock 图标 / 双击 / 右键「打开方式」）的端到端验证。
 *
 * 真实链路的前半段（LaunchServices 派发 open-file）在自动化里没法触发，
 * 所以这里直接从主进程 emit 同一个事件，后面的「攒路径 → IPC → 渲染层建标签」
 * 全部走真实实现。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '../..')
const extraLaunchArgs = (process.env.XINYUE_E2E_ELECTRON_ARGS || '').split(/\s+/).filter(Boolean)

/** 使用隔离数据目录启动真实 Electron 主进程与渲染窗口。 */
async function launchApplication(userDataPath) {
  const application = await electron.launch({
    args: [...extraLaunchArgs, projectRoot],
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      XINYUE_NOTES_E2E_USER_DATA: userDataPath
    }
  })
  const page = await application.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.notesDesktop))
  await page.waitForSelector('.navigation-panel')
  return { application, page }
}

/** 模拟 LaunchServices 投递一次「用本应用打开这个文件」。 */
function emitOpenFile(application, filePath) {
  return application.evaluate(({ app }, target) => {
    app.emit('open-file', { preventDefault() {} }, target)
  }, filePath)
}

/** 当前所有外部文件标签的文件名，按标签栏顺序。 */
function fileTabNames(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('.note-tab.file-tab'))
    .map((element) => element.textContent?.trim() || ''))
}

test('系统请求打开 Markdown 时建出文件标签并显示正文', async (t) => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-open-file-'))
  const filePath = path.join(userDataPath, '系统投递的笔记.md')
  await fs.writeFile(filePath, '# 系统投递\n\n从图标拖进来的正文。\n', 'utf8')

  const { application, page } = await launchApplication(userDataPath)
  t.after(async () => {
    await application.close()
    await fs.rm(userDataPath, { recursive: true, force: true })
  })

  await emitOpenFile(application, filePath)
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('.note-tab.file-tab'))
      .some((element) => element.textContent?.includes('系统投递的笔记.md')))

  const content = await page.locator('.cm-content').first().innerText()
  assert.match(content, /从图标拖进来的正文/)
})

test('连续投递多个文件时按投递顺序建标签', async (t) => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-open-file-multi-'))
  const firstPath = path.join(userDataPath, '第一篇.md')
  const secondPath = path.join(userDataPath, '第二篇.md')
  await fs.writeFile(firstPath, '# 第一篇\n', 'utf8')
  await fs.writeFile(secondPath, '# 第二篇\n', 'utf8')

  const { application, page } = await launchApplication(userDataPath)
  t.after(async () => {
    await application.close()
    await fs.rm(userDataPath, { recursive: true, force: true })
  })

  // 一次拖多个文件时系统会逐个派发，这里按同样的节奏连续 emit。
  await emitOpenFile(application, firstPath)
  await emitOpenFile(application, secondPath)
  await page.waitForFunction(() => document.querySelectorAll('.note-tab.file-tab').length >= 2)

  const names = await fileTabNames(page)
  const firstIndex = names.findIndex((name) => name.includes('第一篇.md'))
  const secondIndex = names.findIndex((name) => name.includes('第二篇.md'))
  assert.ok(firstIndex > -1 && secondIndex > -1, `标签缺失：${names.join(' / ')}`)
  assert.ok(firstIndex < secondIndex, `标签顺序被并发打乱：${names.join(' / ')}`)
})

test('系统请求打开不支持的类型时不建标签', async (t) => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-open-file-unsupported-'))
  const imagePath = path.join(userDataPath, '图片.png')
  await fs.writeFile(imagePath, 'not a real png', 'utf8')

  const { application, page } = await launchApplication(userDataPath)
  t.after(async () => {
    await application.close()
    await fs.rm(userDataPath, { recursive: true, force: true })
  })

  await emitOpenFile(application, imagePath)
  await page.waitForTimeout(400)
  assert.equal((await fileTabNames(page)).length, 0)
})
