/**
 * 编辑器正文显示字号 —— 端到端回归。
 *
 * ## 背景
 *
 * 用户反馈「富文本编辑的字体大小和样式没钉钉好看，而且工具栏没有字体大小调整」。
 * 第一轮把标题从 Crepe 默认的 42/36/32px 收紧并加粗（对齐钉钉观感），
 * 并把字号调整埋在「更多」菜单里做放大/缩小。
 *
 * 第二轮（本轮）按用户要求改成**下拉**：去掉放大/缩小，
 * 在「一级标题」块类型选择器**之后**挂一个字号下拉，取值对齐钉钉
 * （9/10/11/12/14/16/18/20/22，另补 15 作为默认档）。
 *
 * ## 为什么必须用 e2e
 *
 * 单测只能对 `.vue` 源码做正则匹配，证明不了「选了下拉字号真的变了」。
 * 而字号是靠 CSS 变量 `--markdown-body-font-size` 驱动的 —— 变量名写错、
 * 绑错节点、样式没消费、下拉没插进 DOM，单测全都发现不了，
 * 只有真跑起来量计算样式才可靠。
 *
 * ## 三条核心断言
 *
 * 1. 字号下拉**确实挂在「一级标题」选择器之后**（位置是本次需求的明确要求）；
 * 2. 从下拉选一个字号后，**正文的 computed font-size 真的变了**；
 * 3. 字号变化**只影响显示** —— 落库的 markdown 正文一个字符都不能变。
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

/** 打开字号下拉。 */
async function openFontSizeMenu(page) {
  await page.locator('.markdown-font-size-menu__toggle').first().click()
  await page.waitForTimeout(250)
}

test('字号下拉：挂在「一级标题」之后，选中即改变正文字号且不动源码', { timeout: 120_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-font-scale-'))
  let application
  try {
    application = await launchApplication(userDataPath)
    const { page } = application
    await seedAndOpenNote(page, '字号测试', '字号调整验证正文')

    // 位置要求：字号下拉必须紧跟在块类型选择器之后，且在其右侧。
    const placement = await page.evaluate(() => {
      const heading = document.querySelector('.top-bar-heading-selector')
      const menu = document.querySelector('.markdown-font-size-menu')
      if (!heading || !menu) return null
      return {
        isNextSibling: heading.nextElementSibling === menu,
        headingRight: heading.getBoundingClientRect().right,
        menuLeft: menu.getBoundingClientRect().left
      }
    })
    assert.ok(placement, '应同时存在块类型选择器与字号下拉')
    assert.ok(placement.isNextSibling, '字号下拉应是「一级标题」选择器的下一个兄弟节点')
    assert.ok(
      placement.menuLeft >= placement.headingRight - 1,
      `字号下拉应在「一级标题」右侧：标题右缘 ${placement.headingRight}，下拉左缘 ${placement.menuLeft}`
    )

    // 触发器布局：数值与箭头必须**横排**。
    // ⚠️ 通用 `.top-bar-item` 是 `flex-direction: column` 且特异性相同、声明更靠后，
    // 字号下拉若不加一级特异性会被覆盖成竖排（09-23 用户截图反馈「菜单有点窄」即此）。
    // 这条断言直接量计算样式，别只测源码字符串。
    const toggleLayout = await page.evaluate(() => {
      const toggle = document.querySelector('.markdown-font-size-menu__toggle')
      if (!toggle) return null
      const style = window.getComputedStyle(toggle)
      const rect = toggle.getBoundingClientRect()
      const value = toggle.querySelector('.markdown-font-size-menu__value')
      const chevron = toggle.querySelector('.markdown-font-size-menu__chevron')
      const valueRect = value?.getBoundingClientRect()
      const chevronRect = chevron?.getBoundingClientRect()
      return {
        flexDirection: style.flexDirection,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        valueCenterY: valueRect ? valueRect.top + valueRect.height / 2 : null,
        chevronCenterY: chevronRect ? chevronRect.top + chevronRect.height / 2 : null
      }
    })
    assert.ok(toggleLayout, '应能找到字号下拉触发器')
    assert.equal(toggleLayout.flexDirection, 'row', '触发器应为横排（不被 .top-bar-item 的 column 覆盖）')
    assert.ok(
      toggleLayout.width >= 54,
      `触发器不应被压得过窄，实际 ${toggleLayout.width}px`
    )
    // 横排的直接证据：数值与箭头垂直中心几乎重合（竖排时会差十几像素）。
    assert.ok(
      Math.abs(toggleLayout.valueCenterY - toggleLayout.chevronCenterY) <= 3,
      `数值与箭头应水平对齐：数值中心 ${toggleLayout.valueCenterY}，箭头中心 ${toggleLayout.chevronCenterY}`
    )

    const before = await readBodyFontSize(page)
    assert.ok(before && before > 0, `应能读到正文字号，实际 ${before}`)
    assert.equal(before, 15, '默认正文应为 15px')

    // 触发器只显示数值（与钉钉一致），不带「px」后缀。
    const toggleText = await page.locator('.markdown-font-size-menu__value').first().textContent()
    assert.equal((toggleText || '').trim(), '15', '触发器应只显示当前字号数值')

    // 落库正文（改动前的基线）—— 后面要证明它一字未变。
    const contentBefore = await readStoredContent(page)
    assert.match(contentBefore, /字号调整验证正文/, '正文应已入库')

    // 从下拉里选 22px
    await openFontSizeMenu(page)
    const options = await page.locator('.markdown-font-size-menu__item').allTextContents()
    assert.deepEqual(
      options.map((text) => text.trim()),
      ['9', '10', '11', '12', '14', '15', '16', '18', '20', '22'],
      '下拉取值应对齐钉钉并保留 15px'
    )
    await page.locator('.markdown-font-size-menu__item').filter({ hasText: /^22$/ }).click()
    await page.waitForTimeout(500)
    const afterLarger = await readBodyFontSize(page)
    assert.equal(afterLarger, 22, `选 22 后正文应为 22px，实际 ${afterLarger}px`)

    // 再选回 15px
    await openFontSizeMenu(page)
    await page.locator('.markdown-font-size-menu__item').filter({ hasText: /^15$/ }).click()
    await page.waitForTimeout(500)
    const afterRestore = await readBodyFontSize(page)
    assert.equal(afterRestore, before, '选回 15 应回到原字号')

    // 选中项要有打勾标记，否则用户看不出当前档位。
    await openFontSizeMenu(page)
    const checked = await page.locator('.markdown-font-size-menu__item[aria-checked="true"]').allTextContents()
    assert.deepEqual(checked.map((text) => text.trim()), ['15'], '当前档位应被标记为选中')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)

    // 底线：字号只改显示，正文源码不得被写入任何字号信息。
    const contentAfter = await readStoredContent(page)
    assert.equal(contentAfter, contentBefore, '调字号不得改动正文源码')
    assert.doesNotMatch(contentAfter, /font-size/, '正文里不应出现 font-size')
  } finally {
    if (application?.electronApplication) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

test('字号下拉：选择被记住（重载后仍是上次的字号）', { timeout: 120_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-font-persist-'))
  let application
  try {
    application = await launchApplication(userDataPath)
    const { page } = application
    await seedAndOpenNote(page, '字号记忆', '重载后字号应保留')

    await openFontSizeMenu(page)
    await page.locator('.markdown-font-size-menu__item').filter({ hasText: /^20$/ }).click()
    await page.waitForTimeout(400)
    assert.equal(await readBodyFontSize(page), 20, '选 20 后应为 20px')

    await page.reload()
    await page.locator('.milkdown-editor-root .ProseMirror').waitFor()
    await page.waitForTimeout(800)
    assert.equal(await readBodyFontSize(page), 20, '重载后应记住上次选择的字号')

    const toggleText = await page.locator('.markdown-font-size-menu__value').first().textContent()
    assert.equal((toggleText || '').trim(), '20', '触发器应显示恢复后的字号')
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

    // 标题字号应跟随正文变量：放大正文后 h1 也要变大，否则「等比缩放」是假的。
    const headingBefore = heading.fontSize
    await openFontSizeMenu(page)
    await page.locator('.markdown-font-size-menu__item').filter({ hasText: /^22$/ }).click()
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
