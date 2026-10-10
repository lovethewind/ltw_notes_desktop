/**
 * 行内字号（选中文字字号 / 后续输入字号）——端到端回归。
 *
 * ## 背景
 *
 * 早期版本的字号是「**整篇显示缩放**」（只改 CSS 变量，不写正文）。
 * 2026-09-24 用户重新定义语义：
 *
 *  - **选中文字**再改字号 → 只改选中的那段，写进正文；
 *  - **没选中**就改字号 → 只对**后续新打的字**生效，已有正文一个字不动；
 *  - 设回默认值（15px）→ 移除标记，不留 `<span style="font-size:15px">`；
 *  - **没有「整篇缩放」这一档**。
 *
 * ## 为什么必须用 e2e
 *
 * 单测只能对 `.vue` 源码做正则匹配，证明不了下面任何一条：
 *
 * 1. `storedMarks` 到底还在不在（**本轮最险的坑**：`click` 会因焦点转移丢掉它，
 *    表现为「选了 20px，打出来还是 15px」，全程无报错）；
 * 2. `<span style="font-size:…">` 是否真的能**往返**（存下去、重新打开还在，
 *    且不会退化成字面量文本）；
 * 3. 选区字号刷新是否慢一拍（`selectionUpdated` 在 `state.apply` 内部触发，
 *    读 `view.state` 会拿到**上一个** state）。
 *
 * 这三条都只有真跑起来、真打字、真读落库内容才测得出来。
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
  const noteId = await page.evaluate(
    async ({ title: noteTitle, content: noteContent }) => {
      const note = await window.notesDesktop.createNote(null)
      await window.notesDesktop.updateNote(note.id, { title: noteTitle, content: noteContent })
      return note.id
    },
    { title, content }
  )
  await page.reload()
  await openNote(page, title)
  return noteId
}

/** 从侧边栏点开指定标题的笔记。 */
async function openNote(page, title) {
  await expandUnclassified(page)
  await page.waitForSelector('.navigation-panel .sidebar-note-main')
  await page.locator('.navigation-panel .sidebar-note-main').filter({ hasText: title }).first().click()
  await page.locator('.milkdown-editor-root .ProseMirror').waitFor()
  await page.waitForTimeout(600)
}

/** 清空正文并把光标放进编辑器。 */
async function clearAndFocus(page) {
  const editor = page.locator('.milkdown-editor-root .ProseMirror').first()
  await editor.click()
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Backspace')
}

/** 打开字号下拉（触发器与选项都走 pointerdown，Playwright 的 click 能覆盖到）。 */
async function openFontSizeMenu(page) {
  await page.locator('.markdown-font-size-menu__toggle').first().click()
  await page.waitForTimeout(200)
}

/** 从下拉里挑一个字号。 */
async function pickFontSize(page, size) {
  await openFontSizeMenu(page)
  await page.locator('.markdown-font-size-menu__item').filter({ hasText: new RegExp(`^${size}$`) }).click()
  await page.waitForTimeout(300)
}

/** 读落库正文（按笔记 id，与编辑器保存的是同一条记录）。 */
function readStoredContent(page, noteId) {
  return page.evaluate(
    async (id) => (await window.notesDesktop.getNote(id))?.content ?? '',
    noteId
  )
}

/**
 * 等自动保存落库，并返回落库后的正文。
 *
 * ⚠️ 两个坑：
 * 1. 自动保存是**防抖**的（`NOTE_AUTOSAVE_DELAY_MS = 1500`），改完立刻读会拿到旧值；
 * 2. 轮询必须在 **Node 侧**做 —— `page.waitForFunction` 传 async 谓词时不会等 Promise，
 *    会立刻当成真值返回（本轮实测：等待形同虚设，断言随即读到旧内容）。
 *
 * :param page: Electron 页面。
 * :param noteId: 笔记 id。
 * :param options: includes / excludes，落库正文必须满足的内容条件。
 * :return: 落库正文。
 */
async function waitForStored(page, noteId, { includes, excludes } = {}) {
  const deadline = Date.now() + 20_000
  let content = ''
  for (;;) {
    content = String(await readStoredContent(page, noteId))
    const satisfied =
      (!includes || content.includes(includes)) && (!excludes || !content.includes(excludes))
    if (satisfied) return content
    if (Date.now() > deadline) {
      throw new Error(
        `等待落库超时：includes=${includes ?? '-'} excludes=${excludes ?? '-'}，实际 ${JSON.stringify(content)}`
      )
    }
    await page.waitForTimeout(200)
  }
}

/** 读文档里第一个行内字号 span 的实况。 */
function readFontSizeSpan(page) {
  return page.evaluate(() => {
    const element = document.querySelector('.milkdown-editor-root .ProseMirror span[data-xynote-font-size]')
    if (!element) return null
    return {
      size: element.getAttribute('data-xynote-font-size'),
      text: element.textContent,
      fontSize: Number.parseFloat(window.getComputedStyle(element).fontSize)
    }
  })
}

/** 当前 DOM 选区里的文字。 */
function readDomSelection(page) {
  return page.evaluate(() => window.getSelection()?.toString() ?? '')
}

test('行内字号：位置与外观（挂在「一级标题」之后，触发器横排不过窄）', { timeout: 120_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-inline-font-ui-'))
  let application
  try {
    application = await launchApplication(userDataPath)
    const { page } = application
    await seedAndOpenNote(page, '字号外观', '字号外观验证')

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
    assert.ok(toggleLayout.width >= 54, `触发器不应被压得过窄，实际 ${toggleLayout.width}px`)
    assert.equal(toggleLayout.height, 34, `触发器高度应为 34px，实际 ${toggleLayout.height}px`)
    // 横排的直接证据：数值与箭头垂直中心几乎重合（竖排时会差十几像素）。
    assert.ok(
      Math.abs(toggleLayout.valueCenterY - toggleLayout.chevronCenterY) <= 3,
      `数值与箭头应水平对齐：数值中心 ${toggleLayout.valueCenterY}，箭头中心 ${toggleLayout.chevronCenterY}`
    )

    // 无标记时触发器显示正文默认值，且只显示数值（与钉钉一致，不带 px）。
    assert.equal(
      (await page.locator('.markdown-font-size-menu__value').first().textContent() || '').trim(),
      '15',
      '未设字号时触发器应显示 15'
    )

    // 档位表：对齐钉钉并保留 15px 默认档，尾部带大字号阶梯。
    await openFontSizeMenu(page)
    assert.deepEqual(
      (await page.locator('.markdown-font-size-menu__item').allTextContents()).map((text) => text.trim()),
      ['9', '10', '11', '12', '14', '15', '16', '18', '20', '22', '24', '26', '28', '36', '42', '48', '72'],
      '下拉取值应对齐钉钉、保留 15px，并包含大字号档'
    )
    // 选中项要有打勾标记，否则用户看不出当前档位。
    assert.deepEqual(
      (await page.locator('.markdown-font-size-menu__item[aria-checked="true"]').allTextContents()).map((t) => t.trim()),
      ['15'],
      '未设字号时「15」应被标记为当前档位'
    )
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  } finally {
    if (application?.electronApplication) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

test('行内字号：选中文字改字号写进正文，设回默认值即移除标记', { timeout: 120_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-inline-font-sel-'))
  let application
  try {
    application = await launchApplication(userDataPath)
    const { page } = application
    const noteId = await seedAndOpenNote(page, '选区字号', '占位')

    await clearAndFocus(page)
    await page.keyboard.type('abcdef')
    await page.waitForTimeout(300)

    // 从末尾往左选 3 个字符 —— 这条路径与用户拖选同构，且选区确定、可重复。
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('Shift+ArrowLeft')
    assert.equal(await readDomSelection(page), 'def', '前置条件：应选中末尾的 def')

    await pickFontSize(page, 22)

    // ① 真被应用了：选中的文字外面套上了 22px 的 span，且计算字号确实是 22。
    const span = await readFontSizeSpan(page)
    assert.ok(span, '选中文字后应生成行内字号 span')
    assert.equal(span.text, 'def', 'span 应恰好包住选中的文字')
    assert.equal(span.size, '22', 'span 应记录 22')
    assert.equal(span.fontSize, 22, `span 的计算字号应为 22px，实际 ${span.fontSize}px`)

    // ② 未被选中的部分不能受影响。
    const untouched = await page.evaluate(() => {
      const editor = document.querySelector('.milkdown-editor-root .ProseMirror')
      return Number.parseFloat(window.getComputedStyle(editor).fontSize)
    })
    assert.equal(untouched, 15, '未选中的正文仍应是默认 15px')

    // ③ 写进了源码：落盘 markdown 里出现标准 HTML（不是自定义方言）。
    const contentWithMark = await waitForStored(page, noteId, { includes: 'font-size:22px' })
    assert.match(
      contentWithMark,
      /abc<span style="font-size:22px">def<\/span>/,
      `落盘正文应把选中文字包进标准 HTML span，实际：${JSON.stringify(contentWithMark)}`
    )

    // ④ 触发器跟着选区显示 22。
    assert.equal(
      (await page.locator('.markdown-font-size-menu__value').first().textContent() || '').trim(),
      '22',
      '设完字号后触发器应显示 22'
    )

    // ⑤ 选回默认值 → 移除标记。选区在应用后仍然保留，直接再选一次 15 即可。
    assert.equal(await readDomSelection(page), 'def', '应用字号后选区应保持，便于继续调整')
    await pickFontSize(page, 15)
    assert.equal(await readFontSizeSpan(page), null, '设回 15 后行内字号 span 应被移除')
    const contentAfterRemove = await waitForStored(page, noteId, { excludes: 'font-size' })
    assert.doesNotMatch(
      contentAfterRemove,
      /font-size/,
      `设回默认值后正文里不应残留 font-size，实际：${JSON.stringify(contentAfterRemove)}`
    )
  } finally {
    if (application?.electronApplication) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

test('行内字号：没选中时只对后续输入生效，且重新打开笔记后仍然保真', { timeout: 120_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-inline-font-pending-'))
  let application
  try {
    application = await launchApplication(userDataPath)
    const { page } = application
    const noteId = await seedAndOpenNote(page, '待用字号', '占位')

    await clearAndFocus(page)
    await page.keyboard.type('hello')
    await page.waitForTimeout(300)

    // 无选区（输入完光标在末尾）→ 选 20px。这一步只应改「待用格式」。
    await pickFontSize(page, 20)
    assert.equal(
      await readFontSizeSpan(page),
      null,
      '没选中时不得给已有正文加 span（语义是「只对后续输入生效」）'
    )

    // 关键一步：菜单操作之后焦点必须还在正文里，否则 storedMarks 已被清空。
    // 用「直接打字」来验证 —— 打出来的字带 20px 才算真的生效。
    await page.keyboard.type('XY')
    await page.waitForTimeout(400)

    const span = await readFontSizeSpan(page)
    assert.ok(span, '待用字号生效后，新打的字外面应有 span')
    assert.equal(span.text, 'XY', 'span 应只包住新打的字')
    assert.equal(span.fontSize, 20, `新打的字应为 20px，实际 ${span.fontSize}px`)

    const content = await waitForStored(page, noteId, { includes: 'font-size:20px' })
    assert.match(
      content,
      /hello<span style="font-size:20px">XY<\/span>/,
      `先打的 hello 不应被卷入，实际：${JSON.stringify(content)}`
    )

    // 往返保真：重新打开后 span 必须**仍是格式**，不能退化成字面量文本
    // （mdast 侧靠 nestFontSizeSpans + 自定义 stringify handler 还原，这两条最容易静默坏掉）。
    await page.reload()
    await openNote(page, '待用字号')
    const reopened = await readFontSizeSpan(page)
    assert.ok(reopened, '重新打开后仍应有行内字号 span（说明往返没丢格式）')
    assert.equal(reopened.text, 'XY', '往返后 span 内容应不变')
    assert.equal(reopened.fontSize, 20, '往返后字号应不变')

    // 而且不能出现字面量 HTML 文本（那说明解析链路断了，用户会看到一串标签）。
    const literal = await page.evaluate(() =>
      document.querySelector('.milkdown-editor-root .ProseMirror')?.textContent?.includes('<span') ?? false
    )
    assert.equal(literal, false, '正文里不应出现字面量 <span 文本')

    // 落库内容在往返后应**逐字不变** —— 往返若有偏差，用户每打开一次笔记都会被重写一遍正文。
    assert.equal(
      String(await readStoredContent(page, noteId)),
      content,
      '往返后落库内容应逐字稳定，不得被重写'
    )
  } finally {
    if (application?.electronApplication) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})
