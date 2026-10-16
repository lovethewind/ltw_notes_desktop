/**
 * 工具栏「插入 → 行内公式」的行为守卫（端到端）。
 *
 * ## 为什么要有这条
 *
 * 2026-10-16 用户报：网页端点「行内公式」**没反应**，刷新页面后**正常的文字变成了公式**，
 * 而且这个按钮跟同面板的其他按钮**格格不入**。
 *
 * 前两条是同一个根因：Crepe 的 `ToggleLatex` 把 `doc.textBetween(from, to)` 当公式内容，
 * **无选区**时取到空串 → 插进来一个**空公式节点**。
 *   - 屏幕上它零宽、看不见 → 「点了没反应」；
 *   - 序列化成 Markdown 是一个孤零零的 `$$`（已用 remark 实测）→ 这行落在行首/独占一行时，
 *     重新打开笔记会被解析成**块级公式**开头，把后面所有正文一口吞掉（数据损坏）。
 *
 * 桌面端与网页端是同一份实现，所以这里守两条：
 *   ① 无选区时**一个字都不动**，并给出提示（不许静默失败）；
 *   ② 有选区时**照常包上**（守卫不得把正常路径一起挡掉）。
 *
 * ## 为什么必须用 e2e
 *
 * 「无选区时命令到底往文档里写了什么」只有真把编辑器跑起来、真点一次才知道：
 * `editor.editor.action()` 的返回值、`commands.call()` 有没有真的 dispatch、
 * 打开二级菜单会不会顺带丢掉选区 —— 正则匹配 `.vue` 源码全都证明不了。
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

/** 展开顶栏「插入」二级菜单。 */
async function openInsertMenu(page) {
  await page.locator('.markdown-toolbar-menu[data-menu="insert"] > .markdown-toolbar-menu__toggle').click()
  await page.waitForTimeout(200)
  await page.locator('.markdown-toolbar-menu__item[data-label="行内公式"]').waitFor({ state: 'visible' })
}

/** 点「插入 → 行内公式」。 */
async function clickInlineFormula(page) {
  await openInsertMenu(page)
  await page.locator('.markdown-toolbar-menu__item[data-label="行内公式"]').click()
  await page.waitForTimeout(300)
}

test('行内公式：无选区不落空公式、有选区照常包上', { timeout: 120_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-inline-formula-button-'))
  let application
  try {
    application = await launchApplication(userDataPath)
    const { page } = application
    await seedAndOpenNote(page, '行内公式按钮', '第一段正常文字\n\n第二段正常文字')

    const editor = page.locator('.milkdown-editor-root .ProseMirror').first()
    const paragraph = editor.locator('p').first()
    const inline = page.locator('span[data-type="math_inline"]')

    // ① 无选区（只把光标点进段落）→ 不许插入空公式节点。
    await paragraph.click()
    await page.waitForTimeout(200)
    await clickInlineFormula(page)
    assert.equal(
      await inline.count(),
      0,
      '⚠️ 无选区点「行内公式」插进了空公式节点 —— 它会序列化成独立的 `$$`，' +
        '重新打开笔记时把后面正文全吞进块级公式里（数据损坏）'
    )

    // ② 必须给出「请先选中」的提示 —— 静默什么都不做就是用户报的「点了没反应」。
    const feedback = page.locator('.editor-feedback')
    await feedback.waitFor({ state: 'visible', timeout: 3000 })
    assert.match(await feedback.textContent(), /请先选中要转成公式的文字/)

    // ③ 正文一个字都不能动。
    const textAfter = (await editor.textContent()) || ''
    assert.ok(
      textAfter.includes('第一段正常文字') && textAfter.includes('第二段正常文字'),
      `正文应原样保留，实际 ${JSON.stringify(textAfter)}`
    )

    // ④ 有选区时必须照常包上（守住这条守卫别把正常路径一起挡掉）。
    await paragraph.click()
    await page.keyboard.press('Meta+ArrowLeft')
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    await clickInlineFormula(page)
    assert.equal(await inline.count(), 1, '有选区点「行内公式」应生成 1 个行内公式节点')
    const value = await inline.first().getAttribute('data-value')
    assert.ok(value && value.length > 0, `公式内容应为选中的文字，实际 ${JSON.stringify(value)}`)

    // ⑤ 反向：光标只落在一个公式节点上时，再点一次应把它拆回文字（不能被空文本判定挡回去）。
    await inline.first().click()
    await page.waitForTimeout(200)
    await clickInlineFormula(page)
    assert.equal(await inline.count(), 0, '选中公式节点再点「行内公式」应把它拆回普通文字')

    // ⑥ 气泡里的「勾」要收起气泡 —— Crepe 原生的勾只写值（updateValue）、不动选区，
    //    气泡的 shouldShow 判据继续成立，得靠 handleLatexBubbleConfirm() 把光标挪出公式节点。
    await paragraph.click()
    await page.keyboard.press('Meta+ArrowLeft')
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    await clickInlineFormula(page)
    const bubble = page.locator('.milkdown-latex-inline-edit')
    await bubble.waitFor({ state: 'visible', timeout: 3000 })
    assert.equal(await bubble.getAttribute('data-show'), 'true', '插入公式后气泡应展开')
    await bubble.locator('button').click()
    await page.waitForTimeout(400)
    assert.equal(
      await bubble.getAttribute('data-show'),
      'false',
      '⚠️ 点气泡里的「勾」应收起气泡；还是 true 就说明只写回了值、没关掉（用户报的「点了勾没关闭弹窗」）'
    )
  } finally {
    if (application?.electronApplication) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})
