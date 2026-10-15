/**
 * 预览里的嵌入占位卡「可点开」端到端回归。
 *
 * 为什么必须真窗口验证（单测覆盖不到）：
 *
 * 1. **属性活不活得过清洗**：卡片的目标 ID 写在 `data-note-id` 上，预览正文要过
 *    DOMPurify。属性一旦被剥，点击处理器取不到 ID → 静默无反应，而字符串级守卫照样全绿。
 * 2. **事件委托真的接上了没有**：预览正文是 `v-html` 出来的死 HTML，卡片挂不上 Vue 事件，
 *    只能靠容器委托。模板上写了 `@click` 不等于点下去有反应。
 * 3. **打开语义**：点一下应当新开标签打开被嵌入的笔记，而不是原地什么都不发生。
 *
 * 本文件与 `note-preview.e2e.test.cjs` 里那条「卡片渲染」用例互补：那条管「卡片长得对」，
 * 这条管「卡片点得动」。
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
  await page.emulateMedia({ reducedMotion: 'reduce' })
  return { electronApplication, page }
}

/** 展开「未分类」分组，否则侧边栏里看不到笔记条目。 */
async function expandUnclassified(page) {
  const button = page.getByRole('button', { name: /未分类/ }).first()
  if ((await button.getAttribute('aria-expanded')) === 'false') await button.click()
}

/** 用 IPC 建一篇笔记、写入指定正文并打开它。 */
async function seedAndOpenNote(page, title, content) {
  const result = await page.evaluate(
    async ({ title: noteTitle, content: noteContent }) => {
      const note = await window.notesDesktop.createNote(null)
      const updated = await window.notesDesktop.updateNote(note.id, { title: noteTitle, content: noteContent })
      return { noteId: note.id, content: updated?.content ?? '' }
    },
    { title, content }
  )
  await page.reload()
  await expandUnclassified(page)
  await page.waitForSelector('.navigation-panel .sidebar-note-main')
  await page.locator('.navigation-panel .sidebar-note-main').filter({ hasText: title }).first().click()
  await page.locator('.milkdown-editor-root .ProseMirror').waitFor()
  await page.waitForTimeout(600)
  return result
}

/** 编辑器上方的常驻模式条（编辑 / 预览）。 */
function modeBar(page) {
  return page.locator('.markdown-note-mode-bar')
}

/** 模式条里的模式按钮：传 '编辑' 或 '预览'。 */
function modeButton(page, label) {
  return modeBar(page).locator('.markdown-note-mode-bar__mode-button').filter({ hasText: label })
}

/** 预览层。 */
function previewLayer(page) {
  return page.locator('.markdown-note-preview')
}

/** 预览层里的渲染正文。 */
function previewDoc(page) {
  return page.locator('.markdown-note-preview__doc')
}

/** 当前编辑器正文的纯文本（用于断言「打开的是哪一篇」）。 */
async function editorText(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.milkdown-editor-root .ProseMirror')
    return el ? el.textContent || '' : ''
  })
}

test('预览里的嵌入占位卡：点击 / 回车都能打开被嵌入的笔记', { timeout: 120_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-embed-click-e2e-'))
  // 目标笔记正文放一个唯一标记：只有真的打开了它，编辑器里才可能出现。
  const TARGET_MARKER = 'EMBED_TARGET_MARKER_9527'
  let application

  try {
    application = await launchApplication(userDataPath)
    const { page } = application

    // —— 前置：造一篇被嵌入的目标笔记 ——
    const target = await page.evaluate(
      async ({ title, content }) => {
        const note = await window.notesDesktop.createNote(null)
        await window.notesDesktop.updateNote(note.id, { title, content })
        return { id: note.id }
      },
      { title: '嵌入目标笔记', content: `# 目标\n\n${TARGET_MARKER}` }
    )

    // —— 造宿主笔记（正文含嵌入块），并打开它 ——
    // 嵌入块写成**真实库里的形态**：`data-xynote-embed` 与 `data-xynote-embed-server`
    // 双属性并存（跨端契约）。多出来的属性若把正则带偏，卡片就渲染不出来 —— 这里必须兜住。
    const hostContent = [
      '开头段落',
      '',
      `<div data-xynote-embed="note:${target.id}" data-xynote-embed-server="2081338922006073344" title="嵌入目标笔记"></div>`,
      '',
      '结尾段落'
    ].join('\n')
    await seedAndOpenNote(page, '宿主笔记', hostContent)

    // —— 切到预览 ——
    await modeButton(page, '预览').click()
    await previewLayer(page).waitFor()
    const doc = previewDoc(page)
    const card = doc.locator('.markdown-embed-placeholder').first()
    await card.waitFor({ timeout: 10_000 })

    // ① 关键前置：目标 ID 必须活过清洗。这条挂了，点击必然静默失效。
    assert.equal(
      await card.getAttribute('data-note-id'),
      target.id,
      'data-note-id 必须活过 DOMPurify 清洗，且等于被嵌入笔记的 id'
    )
    // 卡片得可聚焦，键盘入口才有落点。
    assert.equal(await card.getAttribute('role'), 'button')
    assert.equal(await card.getAttribute('tabindex'), '0')

    // ② 鼠标点击 → 应打开目标笔记
    await card.click()
    await page.waitForFunction(
      (marker) => {
        const el = document.querySelector('.milkdown-editor-root .ProseMirror')
        return Boolean(el && (el.textContent || '').includes(marker))
      },
      TARGET_MARKER,
      { timeout: 10_000 }
    )
    assert.match(await editorText(page), new RegExp(TARGET_MARKER), '点击后应打开被嵌入的笔记')

    // —— 回到宿主笔记，验证键盘入口 ——
    await expandUnclassified(page)
    await page.locator('.navigation-panel .sidebar-note-main').filter({ hasText: '宿主笔记' }).first().click()
    await page.locator('.milkdown-editor-root .ProseMirror').waitFor()
    await page.waitForTimeout(600)
    await modeButton(page, '预览').click()
    await previewLayer(page).waitFor()
    const cardAgain = previewDoc(page).locator('.markdown-embed-placeholder').first()
    await cardAgain.waitFor({ timeout: 10_000 })

    // ③ 聚焦后按回车 → 同样应打开（div 不会因回车自动派发 click，靠 keydown 处理器兜）
    await cardAgain.focus()
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      (marker) => {
        const el = document.querySelector('.milkdown-editor-root .ProseMirror')
        return Boolean(el && (el.textContent || '').includes(marker))
      },
      TARGET_MARKER,
      { timeout: 10_000 }
    )
    assert.match(await editorText(page), new RegExp(TARGET_MARKER), '回车后应打开被嵌入的笔记')
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})
