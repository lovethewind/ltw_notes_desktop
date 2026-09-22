/**
 * 单个 Markdown 文件导入 —— 端到端回归。
 *
 * ## 背景
 *
 * 此前只能「导入 Markdown 文件夹或 ZIP」，导一个 `.md` 得先塞进一个文件夹，
 * 用户因此改用「复制粘贴正文」，但粘贴只带文字 —— 图片会全部断链。
 *
 * 本次新增「导入单个 Markdown 文件」：不建来源文件夹，但把它引用的本地图片一并搬进来。
 *
 * ⚠️ 对话框是原生 `showOpenDialog`，无人值守环境无法驱动，因此按既有 e2e 的惯例
 * stub 掉「选路径」这一步；其余链路（IPC → 主进程读盘 → 图片落附件目录 → 写库）都是真实实现。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '../..')
const extraLaunchArgs = (process.env.XINYUE_E2E_ELECTRON_ARGS || '').split(/\s+/).filter(Boolean)

async function launchApplication(userDataPath) {
  const electronApplication = await electron.launch({
    args: [...extraLaunchArgs, projectRoot],
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: 'test', XINYUE_NOTES_E2E_USER_DATA: userDataPath }
  })
  const page = await electronApplication.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.notesDesktop))
  return { electronApplication, page }
}

/** 让原生文件对话框返回固定路径（对话框本身无法被自动化驱动）。 */
async function stubOpenDialog(application, openPath) {
  await application.electronApplication.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p })
  }, openPath)
}

/** 展开「未分类」并按标题选中笔记，返回其正文。 */
async function openNoteByTitle(page, title) {
  const unclassified = page.getByRole('button', { name: /未分类/ }).first()
  if ((await unclassified.getAttribute('aria-expanded')) === 'false') await unclassified.click()
  await page.waitForSelector('.navigation-panel .sidebar-note-main')
  await page.locator('.navigation-panel .sidebar-note-main').filter({ hasText: title }).first().click()
  await page.locator('.milkdown-editor-root .ProseMirror').waitFor()
  await page.waitForTimeout(800)
  return page.evaluate(() => window.notesDesktop.listWorkspace())
}

test('导入单个 Markdown 文件：不建文件夹、正文入库、本地图片一并搬入', { timeout: 120_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-single-import-'))
  const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-single-src-'))
  const filePath = path.join(sourceDir, '接口说明.md')
  let application

  try {
    // 一个 1x1 PNG，用来验证图片真的被搬进附件目录而不是断链。
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
    await fs.mkdir(path.join(sourceDir, 'images'), { recursive: true })
    await fs.writeFile(path.join(sourceDir, 'images', 'a.png'), png)
    await fs.writeFile(
      filePath,
      ['# 接口说明', '', '正文第一段', '', '![示意图](images/a.png)', ''].join('\n'),
      'utf8'
    )

    application = await launchApplication(userDataPath)
    const { page } = application
    await stubOpenDialog(application, filePath)

    // 走真实链路：stub 掉原生选路径对话框后，直接调 IPC（对话框之外的环节都是真实实现）
    const imported = await page.evaluate(() => window.notesDesktop.importSingleMarkdown(null))
    assert.equal(imported.canceled, false, '导入不应被取消')
    assert.equal(imported.importedNotes, 1, `应导入 1 篇笔记，实际：${JSON.stringify(imported)}`)
    // 关键：单文件导入不建来源文件夹。
    assert.equal(imported.importedFolders, 0, `单文件导入不该建文件夹，实际：${JSON.stringify(imported)}`)
    assert.match(imported.message, /接口说明/, '结果消息应带上笔记标题')
    assert.match(imported.message, /1 个图片资源/, '结果消息应说明搬入了图片')

    await page.reload()
    await page.waitForFunction(() => Boolean(window.notesDesktop))

    const workspace = await openNoteByTitle(page, '接口说明')
    const note = workspace.notes.find((item) => item.title === '接口说明')
    assert.ok(note, '导入的笔记应出现在工作区里')

    const detail = await page.evaluate((id) => window.notesDesktop.getNote(id), note.id)
    assert.match(detail.content, /正文第一段/, '正文应完整入库')
    // 图片引用必须已被改写成附件地址，而不是留下相对路径（相对路径在新位置必然是断链）。
    assert.doesNotMatch(detail.content, /images\/a\.png/, `图片引用应被改写，实际：${JSON.stringify(detail.content)}`)
    assert.match(detail.content, /xinyue-asset\.local|xinyue-asset:\/\//, '图片应指向应用内附件地址')
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
    await fs.rm(sourceDir, { recursive: true, force: true })
  }
})
