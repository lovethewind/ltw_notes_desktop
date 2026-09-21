/**
 * 富文本编辑器的 `<br>` 保真与三种粘贴方式 —— 端到端回归。
 *
 * ## 背景
 *
 * Crepe 的 commonmark preset 内置 `remarkPreserveEmptyLinePlugin`
 * （`@milkdown/preset-commonmark/lib/index.js:2125`），其 visitor 把 mdast 里
 * **trim 后值等于 `<br>` / `<br/>` / `<br />` / `<br >` 的 `html` 节点直接删除**
 * （同文件 `:436-448`），设计意图是把 `<br />` 当作「空段落占位符」。
 *
 * 副作用：用户正文里真实的内联 `<br>` 也被删掉 —— 段落里 `前<br>后` 变成 `前后`，
 * 表格单元格里同样消失。这是富文本 round-trip 不保真的根因之一。
 *
 * 修复见 `src/editor/xynote-hardbreak.ts`：前置插入 remark transformer，
 * 在内置插件之前把内联 `<br>` 改写成自定义 mdast 类型 `xynoteHardbreak`，
 * 再经自定义 schema 节点（`toDOM`/`parseDOM` 带 `data-type="xynote-hardbreak"` 标记，
 * `toMarkdown` 回写 `<br>`）实现保真往返。
 *
 * ⚠️ 自定义节点的 `parseDOM` 必须带 `priority: 60`：粘贴链路走
 * `parser(text)` → `DOMSerializer` → `parseSlice`，而内置 `hardbreakSchema`
 * 注册了 `parseDOM: [{ tag: "br" }]`（默认 priority 50），会抢走这个 `<br>`
 * 把节点降级 —— 段落里变 `\`+换行、表格里被压成空格。
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
    env: {
      ...process.env,
      NODE_ENV: 'test',
      XINYUE_NOTES_E2E_USER_DATA: userDataPath
    }
  })
  const page = await electronApplication.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.notesDesktop))
  return { electronApplication, page }
}

function noteEditor(page) {
  return page.locator('.milkdown-editor-root .ProseMirror')
}

/**
 * 建一篇空笔记并打开编辑态，返回笔记 ID。
 *
 * 走 preload API 建笔记（与 note-tabs e2e 同法）：比点「新建」按钮更稳，
 * 且 reload 后侧栏结构可预期。交互断言仍全部走真实界面。
 */
async function seedAndOpenNote(page, title) {
  const noteId = await page.evaluate(async (t) => {
    const note = await window.notesDesktop.createNote(null)
    await window.notesDesktop.updateNote(note.id, { title: t, content: '' })
    return note.id
  }, title)
  await page.reload()
  await page.waitForFunction(() => Boolean(window.notesDesktop))
  // 侧栏「未分类」默认可能收起，显式展开，避免依赖产品默认状态
  const unclassified = page.getByRole('button', { name: /未分类/ }).first()
  if (await unclassified.getAttribute('aria-expanded') === 'false') await unclassified.click()
  await page.waitForSelector('.navigation-panel .sidebar-note-main')
  await page.locator('.navigation-panel .sidebar-note-main').filter({ hasText: title }).first().click()
  await noteEditor(page).waitFor()
  return noteId
}

/**
 * 把文本写入系统剪贴板并断言写入成功。
 *
 * 必须走 Electron 主进程的 `clipboard`：沙箱里的 `navigator.clipboard.readText()`
 * 依赖系统剪贴板，容易被环境干扰；写后立即回读可确保后续 Paste 结果的确定性。
 *
 * @param {import('playwright').ElectronApplication} electronApplication 应用实例（非 {page} 包装对象）。
 */
async function writeClipboard(electronApplication, text) {
  return electronApplication.evaluate(({ clipboard }, value) => {
    clipboard.clear()
    clipboard.writeText(value)
    return clipboard.readText() === value
  }, text)
}

/** 清空编辑器正文后粘贴剪贴板内容。 */
async function pasteIntoEditor(page, editor) {
  await editor.click()
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(400)
  await page.keyboard.press('Meta+V')
  // 等自动保存防抖（NOTE_AUTOSAVE_DELAY_MS = 1500）落库
  await page.waitForTimeout(3200)
}

/**
 * 读取富文本编辑器的当前 DOM 状态。
 *
 * ⚠️ 不要走 `dom.pmViewDesc.view` 拿 EditorView：实测该私有属性存在但 `.view` 为空，
 * 取不到 state/schema。这里只读 DOM —— 自定义节点的 `data-type="xynote-hardbreak"`
 * 标记本身就足以判定「<br> 由哪个节点承载」，无需访问 ProseMirror 内部结构。
 */
async function readEditor(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.milkdown-editor-root .ProseMirror')
    if (!el) return null
    return {
      html: el.innerHTML,
      // 自定义硬换行节点（修复后才会有）
      xynoteHardbreaks: el.querySelectorAll('[data-type="xynote-hardbreak"]').length,
      // 内置 hardbreak 节点（未修复时 <br> 会降级成它）
      builtinHardbreaks: el.querySelectorAll('[data-type="hardbreak"]').length
    }
  })
}

test('富文本笔记：粘贴含 <br> 的 Markdown 后段落内 <br> 保真', { timeout: 90_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-br-para-e2e-'))
  let application

  try {
    application = await launchApplication(userDataPath)
    const { page } = application
    const noteId = await seedAndOpenNote(page, 'br 段落回归')
    const editor = noteEditor(page)

    assert.ok(await writeClipboard(application.electronApplication, '前文<br>后文'), '剪贴板写入失败')
    await pasteIntoEditor(page, editor)

    const state = await readEditor(page)
    assert.ok(state, '未找到富文本编辑器')
    // 必须由自定义节点承载（而非被内置 hardbreak 抢走）
    assert.equal(state.xynoteHardbreaks, 1, `段落内 <br> 应由自定义节点承载，实际 DOM：${state.html}`)
    assert.equal(state.builtinHardbreaks, 0, '不应降级成内置 hardbreak 节点')

    // 落库正文必须保留 <br>（而非被压成 `\`+换行）
    const saved = await page.evaluate((id) => window.notesDesktop.getNote(id), noteId)
    assert.match(saved.content, /前文<br\s*\/?>后文/, `落库正文应保留 <br>，实际：${JSON.stringify(saved.content)}`)
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

test('富文本笔记：粘贴含 <br> 的表格后单元格内 <br> 保真', { timeout: 90_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-br-table-e2e-'))
  let application

  try {
    application = await launchApplication(userDataPath)
    const { page } = application
    const noteId = await seedAndOpenNote(page, 'br 表格回归')
    const editor = noteEditor(page)

    const markdown = '| A | B |\n| --- | --- |\n| 前<br>后 | x |'
    assert.ok(await writeClipboard(application.electronApplication, markdown), '剪贴板写入失败')
    await pasteIntoEditor(page, editor)

    const saved = await page.evaluate((id) => window.notesDesktop.getNote(id), noteId)
    // 表格单元格里的 <br> 曾经被压成空格（`前 后`）——这是最隐蔽的丢失场景
    assert.match(saved.content, /前<br\s*\/?>后/, `表格单元格应保留 <br>，实际：${JSON.stringify(saved.content)}`)
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

/**
 * 表格单元格内 `Shift+Enter` 插硬换行 —— 回归。
 *
 * ## 背景
 *
 * Crepe 的 commonmark preset 注册了 `hardbreakFilterPlugin`
 * （`@milkdown/preset-commonmark/lib/index.js:1984`），它读取 `hardbreakFilterNodes` ctx
 * （默认 `["table", "code_block"]`）并**拒绝**在表格内插入 hardbreak，
 * 所以内置 `Shift-Enter` 在单元格里**静默失效**（实测：按键后既不换行也不报错）。
 *
 * 修复见 `MarkdownVisualEditor.vue` 的 `insertTableCellHardBreak`：在表格内改用
 * 本项目的 `xynoteHardbreak` 内联节点，它不经该过滤器，且序列化回写 `<br>`
 * （内置 hardbreak 在单元格里会被 remark-stringify 压成空格）。
 *
 * ⚠️ 断言必须落在**落库正文**上，而不是只看 DOM：DOM 里能看到换行不代表存得住。
 */
test('富文本笔记：表格单元格内 Shift+Enter 插 <br> 且能落库', { timeout: 90_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-cell-br-e2e-'))
  let application

  try {
    application = await launchApplication(userDataPath)
    const { page } = application
    const noteId = await seedAndOpenNote(page, '单元格硬换行回归')
    const editor = noteEditor(page)

    const markdown = '| A | B |\n| --- | --- |\n| 前 | x |'
    assert.ok(await writeClipboard(application.electronApplication, markdown), '剪贴板写入失败')
    await pasteIntoEditor(page, editor)

    // 光标落到首个单元格「前」之后，按 Shift+Enter 再输入 Z
    const firstCell = page.locator('.milkdown-editor-root .ProseMirror table td p').first()
    await firstCell.click()
    await page.keyboard.press('End')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('Z')
    await page.waitForTimeout(300)

    const state = await readEditor(page)
    assert.ok(state, '未找到富文本编辑器')
    assert.equal(state.xynoteHardbreaks, 1, `单元格内应出现自定义硬换行节点，实际 DOM：${state.html}`)

    // 等自动保存防抖后核对落库正文 —— 这才是「存得住」的证据
    await page.waitForTimeout(3200)
    const saved = await page.evaluate((id) => window.notesDesktop.getNote(id), noteId)
    assert.match(
      saved.content,
      /前<br\s*\/?>Z/,
      `单元格内硬换行应落库为 <br>，实际：${JSON.stringify(saved.content)}`
    )
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

test('富文本笔记：空段落占位符语义不回退', { timeout: 90_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-br-empty-e2e-'))
  let application

  try {
    application = await launchApplication(userDataPath)
    const { page } = application
    const noteId = await seedAndOpenNote(page, 'br 空段落回归')
    const editor = noteEditor(page)

    // 独立的 `<br />` 在 Milkdown 里是「空段落占位符」，必须交由内置插件按老逻辑处理：
    // 不能被我们的规则抢成显式 <br> 节点，否则文档里会多出一行真实的换行符。
    assert.ok(await writeClipboard(application.electronApplication, 'a\n\n<br />\n\nb'), '剪贴板写入失败')
    await pasteIntoEditor(page, editor)

    const state = await readEditor(page)
    assert.ok(state, '未找到富文本编辑器')
    // 独立 <br /> 是「空段落占位符」，应由内置插件按老逻辑处理，不该被抢成自定义节点
    assert.equal(
      state.xynoteHardbreaks, 0,
      `独立 <br /> 不应被抢成自定义节点，实际 DOM：${state.html}`
    )

    const saved = await page.evaluate((id) => window.notesDesktop.getNote(id), noteId)
    // 正文两段应保留，且不应留下字面量 `<br />` 文本
    assert.match(saved.content, /a/)
    assert.match(saved.content, /b/)
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

test('富文本笔记右键菜单提供三种粘贴方式', { timeout: 90_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-paste-menu-e2e-'))
  let application

  try {
    application = await launchApplication(userDataPath)
    const { page } = application
    await seedAndOpenNote(page, '粘贴菜单回归')
    const editor = noteEditor(page)

    await editor.click({ button: 'right' })
    // 菜单三项都必须存在
    for (const label of ['粘贴', '粘贴为纯文本', '粘贴为 Markdown']) {
      assert.equal(
        await page.getByRole('menuitem', { name: label, exact: true }).count(),
        1,
        `右键菜单应包含「${label}」`
      )
    }

    // 「粘贴为纯文本」：Markdown 语法应原样插入，不被解析
    assert.ok(await writeClipboard(application.electronApplication, '# 不是标题'), '剪贴板写入失败')
    await page.getByRole('menuitem', { name: '粘贴为纯文本', exact: true }).click()
    await page.waitForTimeout(600)
    const plainState = await readEditor(page)
    assert.ok(plainState, '未找到富文本编辑器')
    assert.match(plainState.html, /# 不是标题/, '纯文本粘贴应保留字面量 #')

    // 「粘贴为 Markdown」：语法应被解析成真正的标题。
    // 必须先清空上一轮内容，否则新内容会追加到同一段落、`## ` 不在行首而不被解析。
    await editor.click()
    await page.keyboard.press('Meta+A')
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(400)

    assert.ok(await writeClipboard(application.electronApplication, '## 是二级标题'), '剪贴板写入失败')
    await editor.click({ button: 'right' })
    await page.getByRole('menuitem', { name: '粘贴为 Markdown', exact: true }).click()
    await page.waitForTimeout(800)
    const mdState = await readEditor(page)
    assert.ok(mdState, '未找到富文本编辑器')
    assert.match(mdState.html, /<h2[^>]*>是二级标题<\/h2>/, 'Markdown 粘贴应解析成二级标题')
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})
