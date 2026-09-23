/**
 * 编辑器正文显示字号 —— 端到端回归。
 *
 * ## 背景
 *
 * 用户反馈「富文本编辑的字体大小和样式没钉钉好看，而且工具栏没有字体大小调整」。
 * 本轮做了两件事：把标题从 Crepe 默认的 42/36/32px 收紧并加粗（对齐钉钉观感），
 * 以及给工具栏「更多」菜单加了放大/缩小字号。
 *
 * ## 为什么必须用 e2e
 *
 * 单测只能对 `.vue` 源码做正则匹配，证明不了「点了按钮字号真的变了」。
 * 而字号是靠 CSS 变量 `--markdown-body-font-size` 驱动的 —— 变量名写错、
 * 绑错节点、样式没消费，单测全都发现不了，只有真跑起来量计算样式才可靠。
 *
 * ## 两条核心断言
 *
 * 1. 点「放大字号」后，**正文的 computed font-size 真的变大**；
 * 2. 字号变化**只影响显示** —— 落库的 markdown 正文一个字符都不能变。
 *    这是本功能的底线：markdown 没有行内字号语法，字号绝不能写进正文。
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

/** 展开「未分类」分组，否则侧边栏里看不到笔记条目。 */
async function expandUnclassified(page) {
  const button = page.getByRole('button', { name: /未分类/ }).first()
  if ((await button.getAttribute('aria-expanded')) === 'false') await button.click()
}

/**
 * 用 IPC 直接建一篇笔记并打开它。
 *
 * 不点「新建笔记」按钮：那会依赖顶栏 UI 的措辞与结构，而这里要测的是字号，
 * 建笔记只是前置条件。既有 e2e 也统一走 IPC（见 note-link-jump 等）。
 */
async function seedAndOpenNote(page, title, content) {
  await page.evaluate(async ({ title, content }) => {
    const note = await window.notesDesktop.createNote(null)
    await window.notesDesktop.updateNote(note.id, { title, content })
  }, { title, content })
  await page.reload()
  await expandUnclassified(page)
  await page.waitForSelector('.navigation-panel .sidebar-note-main')
  await page.locator('.navigation-panel .sidebar-note-main').filter({ hasText: title }).first().click()
  await page.locator('.milkdown-editor-root .ProseMirror').waitFor()
  await page.waitForTimeout(800)
}

/** 读编辑器正文当前的 computed font-size（px 数值）。 */
function readBodyFontSize(page) {
  return page.evaluate(() => {
    const editor = document.querySelector('.milkdown-editor-root .ProseMirror')
    if (!editor) return null
    return Number.parseFloat(window.getComputedStyle(editor).fontSize)
  })
}

/** 读落库的正文（取第一篇笔记）。 */
function readStoredContent(page) {
  return page.evaluate(async () => {
    const workspace = await window.notesDesktop.listWorkspace()
    return workspace.notes[0]?.content ?? ''
  })
}

/** 打开工具栏「更多」菜单。 */
async function openToolsMenu(page) {
  await page.locator('.markdown-tools-menu .markdown-toolbar-menu__toggle').first().click()
  await page.waitForTimeout(250)
}

test('正文显示字号：工具栏可放大/缩小，且不改动正文源码', { timeout: 120_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-font-scale-'))
  let application
  try {
    application = await launchApplication(userDataPath)
    const { page } = application
    await seedAndOpenNote(page, '字号测试', '字号调整验证正文')

    const before = await readBodyFontSize(page)
    assert.ok(before && before > 0, `应能读到正文字号，实际 ${before}`)
    assert.equal(before, 15, '默认正文应为 15px')

    // 落库正文（放大前的基线）—— 后面要证明它一字未变。
    const contentBefore = await readStoredContent(page)
    assert.match(contentBefore, /字号调整验证正文/, '正文应已入库')

    // 放大一档
    await openToolsMenu(page)
    await page.getByRole('menuitem', { name: '放大字号' }).click()
    await page.waitForTimeout(500)
    const afterIncrease = await readBodyFontSize(page)
    assert.ok(
      afterIncrease > before,
      `放大后字号应变大：放大前 ${before}px，放大后 ${afterIncrease}px`
    )

    // 缩小一档，应回到原值
    await openToolsMenu(page)
    await page.getByRole('menuitem', { name: '缩小字号' }).click()
    await page.waitForTimeout(500)
    const afterDecrease = await readBodyFontSize(page)
    assert.equal(afterDecrease, before, '缩小一档应回到原字号')

    // 底线：字号只改显示，正文源码不得被写入任何字号信息。
    const contentAfter = await readStoredContent(page)
    assert.equal(contentAfter, contentBefore, '调字号不得改动正文源码')
    assert.doesNotMatch(contentAfter, /font-size/, '正文里不应出现 font-size')
  } finally {
    if (application?.electronApplication) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

test('正文显示字号：标题字号随变量缩放，且不再是被收紧前的 42px', { timeout: 120_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-font-heading-'))
  let application
  try {
    application = await launchApplication(userDataPath)
    const { page } = application
    await seedAndOpenNote(page, '标题字号', '# 一级标题\n\n正文段落')

    const heading = await page.evaluate(() => {
      const element = document.querySelector('.milkdown-editor-root .ProseMirror h1')
      if (!element) return null
      const style = window.getComputedStyle(element)
      return { fontSize: Number.parseFloat(style.fontSize), fontWeight: style.fontWeight }
    })
    assert.ok(heading, '应能生成 h1')
    assert.notEqual(heading.fontSize, 42, 'h1 不应再是 Crepe 默认的 42px')
    assert.ok(heading.fontSize <= 26, `h1 应收紧到 26px 以内，实际 ${heading.fontSize}px`)

    // 加粗：对齐钉钉的观感（原 Crepe 默认是字重 400，偏细）。
    const weight = Number.parseInt(heading.fontWeight, 10)
    assert.ok(weight >= 600, `标题应加粗（>=600），实际 ${heading.fontWeight}`)

    // 标题字号应跟随正文变量：放大一档后 h1 也要变大，否则「等比缩放」是假的。
    const headingBefore = heading.fontSize
    await openToolsMenu(page)
    await page.getByRole('menuitem', { name: '放大字号' }).click()
    await page.waitForTimeout(500)
    const headingAfter = await page.evaluate(() => {
      const element = document.querySelector('.milkdown-editor-root .ProseMirror h1')
      return element ? Number.parseFloat(window.getComputedStyle(element).fontSize) : null
    })
    assert.ok(
      headingAfter > headingBefore,
      `标题应随正文字号等比放大：前 ${headingBefore}px，后 ${headingAfter}px`
    )
  } finally {
    if (application?.electronApplication) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})
