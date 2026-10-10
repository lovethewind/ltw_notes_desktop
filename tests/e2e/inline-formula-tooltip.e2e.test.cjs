/**
 * 行内公式编辑气泡 —— 几何守卫（端到端）。
 *
 * ## 为什么要有这条
 *
 * 2026-10-08 用户报「公式弹窗有问题」：点开行内公式后，编辑气泡**几乎铺满整个视口**，
 * 只剩底部一个 KaTeX 公式可见。
 *
 * 根因不是公式功能，而是**主编辑器的 CSS 泄漏**：
 * `src/style.css` 里那条 `.milkdown-editor-root .milkdown .ProseMirror { … }` 是**后代选择器**，
 * 而 Crepe 的 latex 功能会在气泡里内嵌**第二个 EditorView**
 * （`.milkdown > .milkdown-latex-inline-edit > .container > div > .ProseMirror`），
 * 于是 `min-height: calc(100vh - 250px)` 也套了上去 —— 实测气泡 222×674（窗口 920 高）。
 * 气泡放不下后 floating-ui 还会把它**上翻**，看起来就是「上方一大片空白 + 下方一个公式」。
 *
 * ## 为什么必须用 e2e
 *
 * 这是**布局结果**，正则匹配 `.vue`/`.css` 源码证明不了：
 * 同特异性下谁赢取决于两张样式表的加载顺序，只有真的把编辑器跑起来量一次 rect 才算数。
 * 三条断言分别守三个层次：
 *   ① 气泡本身是「一小条」（不是一屏）；
 *   ② 气泡里的编辑器**看得见源码文本**（不是空壳）；
 *   ③ 气泡不盖住它正在编辑的那个公式。
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

async function expandUnclassified(page) {
  const button = page.getByRole('button', { name: /未分类/ }).first()
  if ((await button.getAttribute('aria-expanded')) === 'false') await button.click()
}

async function seedAndOpenNote(page, title, content) {
  await page.evaluate(
    async ({ title: noteTitle, content: noteContent }) => {
      const note = await window.notesDesktop.createNote(null)
      await window.notesDesktop.updateNote(note.id, { title: noteTitle, content: noteContent })
      return note.id
    },
    { title, content }
  )
  await page.reload()
  await expandUnclassified(page)
  await page.waitForSelector('.navigation-panel .sidebar-note-main')
  await page.locator('.navigation-panel .sidebar-note-main').filter({ hasText: title }).first().click()
  await page.locator('.milkdown-editor-root .ProseMirror').waitFor()
  await page.waitForTimeout(600)
}

/** 取元素（含其祖先）里第一条可见的 rect，便于断言「谁盖住谁」。 */
async function visibleRectOf(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right }
  }, selector)
}

test('行内公式编辑气泡：必须是一小条，不铺满视口、不盖住公式', { timeout: 120_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-inline-formula-'))
  let application
  try {
    application = await launchApplication(userDataPath)
    const { page } = application
    await seedAndOpenNote(page, '行内公式气泡', '占位')

    const editor = page.locator('.milkdown-editor-root .ProseMirror').first()
    await editor.click()
    await page.keyboard.press('Meta+A')
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(200)

    // `$666000$` 会被 Crepe 的 inputRule 变成行内公式节点（与用户手打同一条路径）。
    await page.keyboard.type('$666000$')
    await page.waitForTimeout(500)
    const inline = page.locator('span[data-type="math_inline"]').first()
    assert.equal(await inline.count(), 1, '打 `$666000$` 应生成行内公式节点')
    assert.equal(await inline.getAttribute('data-value'), '666000', '公式内容应为 666000')

    // 点一下 → 打开编辑气泡（Crepe 只在 NodeSelection 命中公式时显示）。
    await inline.click()
    const tooltip = page.locator('.milkdown-latex-inline-edit')
    await tooltip.waitFor({ state: 'visible', timeout: 10_000 })
    await page.waitForTimeout(300)

    const viewport = page.viewportSize() || { width: 1440, height: 920 }
    const tip = await visibleRectOf(page, '.milkdown-latex-inline-edit')
    const formula = await visibleRectOf(page, 'span[data-type="math_inline"]')
    assert.ok(tip && formula, '应能取到气泡与公式的位置')

    // ① 气泡是「一小条」：Crepe 的设计是一行输入框（min-width 174 / max-width 294）。
    assert.ok(
      tip.w <= 340,
      `气泡宽度应是输入框尺寸（≤340px），实际 ${Math.round(tip.w)}px`
    )
    assert.ok(
      tip.h < 120,
      `⚠️ 气泡高度必须是一行输入框（<120px），实际 ${Math.round(tip.h)}px —— ` +
        `变高说明又有「主编辑器 .ProseMirror」规则泄漏进了这个内嵌编辑器`
    )
    assert.ok(
      tip.h < viewport.height * 0.3,
      `气泡不得占据视口大半个高度：气泡 ${Math.round(tip.h)}px / 视口 ${viewport.height}px`
    )

    // ② 气泡里的编辑器要真的看得见源码（不是被 padding/宽度挤没的空壳）。
    const innerText = (await page.locator('.milkdown-latex-inline-edit .ProseMirror').first().textContent()) || ''
    assert.equal(innerText.trim(), '666000', `气泡内应显示公式源码，实际 ${JSON.stringify(innerText)}`)
    const innerFontSize = await page.evaluate(() => {
      const el = document.querySelector('.milkdown-latex-inline-edit .ProseMirror')
      return el ? Number.parseFloat(getComputedStyle(el).fontSize) : 0
    })
    assert.ok(innerFontSize > 0 && innerFontSize < 30, `气泡内字号应为正常码字大小，实际 ${innerFontSize}px`)

    // ③ 气泡不该盖住正在编辑的公式（盖住时用户看不到自己在改什么）。
    const belowFormula = tip.y >= formula.bottom - 2
    const aboveFormula = tip.bottom <= formula.y + 2
    assert.ok(
      belowFormula || aboveFormula,
      `气泡不得覆盖公式：公式 ${Math.round(formula.y)}~${Math.round(formula.bottom)}，` +
        `气泡 ${Math.round(tip.y)}~${Math.round(tip.bottom)}`
    )

    // ④ 确认按钮落库：气泡里改内容后点确认，正文里的公式应更新（顺带守住气泡仍可交互）。
    await page.locator('.milkdown-latex-inline-edit .ProseMirror').first().click()
    await page.keyboard.press('Meta+A')
    await page.keyboard.type('42')
    await page.locator('.milkdown-latex-inline-edit button').first().click()
    await page.waitForTimeout(400)
    assert.equal(
      await page.locator('span[data-type="math_inline"]').first().getAttribute('data-value'),
      '42',
      '气泡里改完点确认，公式内容应更新'
    )
  } finally {
    if (application?.electronApplication) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})
