/**
 * 笔记预览（Markdown 渲染视图）端到端回归。
 *
 * 这里必须用真窗口验证，原因有三：
 *
 * 1. **「盖住」到底成不成立**：预览层是 grid 里和滚动容器重叠的一格，位置写错就整块偏位；
 *    `elementFromPoint` 是唯一能证明「用户看到的是预览而不是编辑器」的手段。
 * 2. **预览层底色必须不透明**：编辑器整层还压在下面，半透明就会把 Crepe 顶栏与正文透上来，
 *    两层的字叠在一起（用户报的就是这个「压字」）。字符串级单测看不出透明度，只有真窗口能量。
 * 3. **公式能不能活过清洗**：KaTeX 吐的是带 `style` 的 HTML，DOMPurify 若把它剥掉，
 *    单测（字符串级）照样全绿，页面上却是一坨裸文本。
 * 4. **表格单元格的块级渲染**：富文本编辑器做不到（表格单元格块级嵌套不可行），
 *    预览的价值就在这里 —— 只有真渲染出来才算数。
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
  // 无头 `--disable-gpu` 下 `scrollTo({ behavior: 'smooth' })` 推进不稳：第 ⑥ 段「点大纲项应滚动
  // 预览层」曾整片红（scrollTop 停在 0），且与几何断言无关。让 `prefers-reduced-motion` 生效后
  // 动画时长被压成 0、滚动立即落位 —— 这里要的是落点，不是动画，所以不损失覆盖。
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

/** 模式条上的大纲开关（预览态唯一够得着的那一个）。 */
function outlineToggle(page) {
  return modeBar(page).locator('.markdown-note-mode-bar__outline')
}

/** 预览层里的渲染正文。 */
function previewDoc(page) {
  return page.locator('.markdown-note-preview__doc')
}

test('笔记预览：Markdown 渲染（块级单元格 + 公式），且盖住编辑器、退出后正文不变', { timeout: 120_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-note-preview-e2e-'))
  const original = [
    '# 订单看板',
    '',
    '行内公式 $E=mc^2$ 与块级公式：',
    '',
    '$$',
    '\\frac{a}{b}',
    '$$',
    '',
    '| 原型 | 需求描述 |',
    '| --- | --- |',
    '| 图 | ### 大货订单<br>1. 数据<br>* 数据来源：领猫SCM |',
    '| 状态 | 1. 未开始 |',
    '',
    '## 备注',
    '',
    ...Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 行补充说明，用来把文档撑到需要滚动。`),
    ''
  ].join('\n')
  let application

  try {
    application = await launchApplication(userDataPath)
    const { page } = application
    const seeded = await seedAndOpenNote(page, '预览渲染', original)
    assert.equal(seeded.content, original, '前置条件：落库正文应与种入的一致（否则测的不是预览渲染）')

    // 进预览前：编辑器在场、预览层不在，但模式条已经常驻在「编辑」上。
    assert.equal(await previewLayer(page).count(), 0)
    assert.equal(await modeBar(page).count(), 1, '模式条应常驻在编辑器上方')
    assert.match(await modeBar(page).innerText(), /编辑模式/)
    assert.equal(await modeButton(page, '编辑').getAttribute('aria-pressed'), 'true')
    assert.equal(await modeButton(page, '预览').getAttribute('aria-pressed'), 'false')
    // 旧的那个顶栏「预览」眼睛按钮必须已经拿掉 —— 现在唯一入口就是模式条。
    assert.equal(await page.locator('.markdown-preview-toggle').count(), 0, '顶栏不应再出现预览按钮')

    // 模式条必须待在编辑区**上方**：之前它跟 Crepe 顶栏占同一条位置，两行字直接压在一起。
    const barRect = await modeBar(page).boundingBox()
    const editorRect = await page.locator('.milkdown-editor-scroll').boundingBox()
    assert.ok(barRect && editorRect, '应能取到模式条与编辑区的几何')
    assert.ok(
      barRect.y + barRect.height <= editorRect.y + 1,
      `模式条底边(${barRect.y + barRect.height}) 不应越过编辑区顶边(${editorRect.y})`
    )

    // 顶部只应有一条横线：模式条横跨整幅宽度（含侧栏那一列），侧栏整列从它下方开始。
    // 早先侧栏跨满两行，于是「编辑|预览」紧挨「大纲|关系」挤在同一水平带里、两条底边还差
    // 19px（35 vs 54），读起来像同一条顶栏上的四个页签。字符串级单测只看得到 CSS 声明，
    // 看不到这两条带到底有没有重合 —— 只有真窗口能量出来。
    const topBand = await page.evaluate(() => {
      const shellElement = document.querySelector('.milkdown-editor-shell')
      const barElement = document.querySelector('.markdown-note-mode-bar')
      const outlineElement = document.querySelector('.markdown-outline')
      if (!shellElement || !barElement || !outlineElement) return null
      const shellRect = shellElement.getBoundingClientRect()
      const barRectInner = barElement.getBoundingClientRect()
      const outlineRect = outlineElement.getBoundingClientRect()
      return {
        shellWidth: shellRect.width,
        barWidth: barRectInner.width,
        barBottom: barRectInner.bottom,
        outlineTop: outlineRect.top
      }
    })
    assert.ok(topBand, '前置条件：外壳 / 模式条 / 侧栏都应在场（否则这条断言证明不了什么）')
    assert.ok(
      Math.abs(topBand.barWidth - topBand.shellWidth) <= 1,
      `模式条应横跨整幅宽度：模式条 ${topBand.barWidth} vs 外壳 ${topBand.shellWidth}`
    )
    assert.ok(
      topBand.outlineTop >= topBand.barBottom - 1,
      `侧栏应从模式条下方开始：侧栏顶 ${topBand.outlineTop} vs 模式条底 ${topBand.barBottom}`
    )

    await modeButton(page, '预览').click()
    await previewLayer(page).waitFor()
    await page.waitForTimeout(400)

    // ① 模式条与按钮组（与本地文件预览同构）。
    assert.match(await modeBar(page).innerText(), /预览模式/)
    assert.equal(await modeButton(page, '预览').getAttribute('aria-pressed'), 'true')
    assert.equal(await modeButton(page, '编辑').getAttribute('aria-pressed'), 'false')

    const doc = previewDoc(page)

    // ② 表格照常渲染，单元格里的块级写法复活成真元素（富文本编辑器做不到）。
    await doc.locator('table').waitFor()
    assert.equal(await doc.locator('table').count(), 1)
    const richCell = doc.locator('tbody tr').nth(0).locator('td').nth(1)
    assert.equal(await richCell.locator('h3').innerText(), '大货订单')
    assert.equal(await richCell.locator('ol li').innerText(), '数据')
    assert.equal(await richCell.locator('ul li').innerText(), '数据来源：领猫SCM')
    // 纯文本单元格不能被误判成列表。
    const plainCell = doc.locator('tbody tr').nth(1).locator('td').nth(1)
    assert.equal(await plainCell.innerText(), '1. 未开始')
    assert.equal(await plainCell.locator('ol, ul').count(), 0)

    // ③ 公式真的渲染出来了（且活过了 DOMPurify 清洗）。
    assert.ok(await doc.locator('.katex').count() >= 2, '行内与块级公式都应渲染成 KaTeX')
    assert.ok(await doc.locator('.markdown-math-block .katex-display').count() === 1, '块级公式应在 math-block 里')
    assert.doesNotMatch(await doc.innerText(), /\$E=mc\^2\$/, '公式原文不应残留成字面文本')

    // ④ 预览层真的盖住编辑区：该点最上层元素属于预览层，而不是编辑器。
    const coverage = await page.evaluate(() => {
      const scroller = document.querySelector('.milkdown-editor-scroll')
      const layer = document.querySelector('.markdown-note-preview')
      const prose = document.querySelector('.milkdown-editor-root .ProseMirror')
      const toolbar = document.querySelector('.milkdown-top-bar')
      if (!scroller || !layer || !prose) return null
      const rect = scroller.getBoundingClientRect()
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 40)
      // 单独再戳一下 Crepe 顶栏自己那一条：它跟预览层原本是「同一格」，最容易被压字。
      const toolbarRect = toolbar ? toolbar.getBoundingClientRect() : null
      const onToolbar = toolbarRect
        ? document.elementFromPoint(rect.left + 20, toolbarRect.top + toolbarRect.height / 2)
        : null
      const background = getComputedStyle(layer).backgroundColor
      const alphaMatch = background.match(/rgba?\(([^)]+)\)/)
      const channels = alphaMatch ? alphaMatch[1].split(',').map((value) => parseFloat(value.trim())) : []
      return {
        coversEditor: Boolean(top?.closest('.markdown-note-preview')),
        coversToolbar: toolbarRect ? Boolean(onToolbar?.closest('.markdown-note-preview')) : null,
        hasToolbar: Boolean(toolbarRect),
        backgroundAlpha: channels.length < 4 ? 1 : channels[3],
        editorStillMounted: prose.isConnected,
        layerRect: layer.getBoundingClientRect().toJSON(),
        scrollerRect: rect.toJSON()
      }
    })
    assert.ok(coverage, '应能取到编辑器 / 预览层的几何')
    assert.equal(coverage.coversEditor, true, '预览层必须盖住编辑区（该点最上层应是预览层）')
    assert.equal(coverage.editorStillMounted, true, '编辑器只被盖住，不得卸载（撤销栈与光标要留着）')
    assert.equal(coverage.hasToolbar, true, '前置条件：Crepe 顶栏应在场，否则这条断言证明不了什么')
    assert.equal(coverage.coversToolbar, true, 'Crepe 顶栏也必须被预览层盖住（只读视图里它没有意义）')
    // 用户报的「压字」根因就是这条：底色半透明 → 底下的顶栏与正文整层透上来。
    assert.equal(coverage.backgroundAlpha, 1, '预览层底色必须不透明，否则编辑器会整层透上来')
    // 覆盖范围与编辑区一致（允许 1px 取整误差）。
    assert.ok(Math.abs(coverage.layerRect.width - coverage.scrollerRect.width) <= 1, '预览层宽度应与编辑区一致')
    assert.ok(Math.abs(coverage.layerRect.height - coverage.scrollerRect.height) <= 1, '预览层高度应与编辑区一致')

    // ⑤ 预览态也必须能把大纲调出来。开关长在模式条上 —— Crepe 顶栏里那个在预览态被整层盖住，
    //    大纲一旦是关着的，用户就再也拿不回来了（`elementFromPoint` 只会拿到预览层）。
    assert.equal(await outlineToggle(page).count(), 1, '模式条应有大纲开关')
    assert.equal(await outlineToggle(page).getAttribute('aria-pressed'), 'true', '默认大纲是开着的')
    assert.equal(await page.locator('.markdown-outline-toggle').count(), 0, '顶栏不应再留一个重叠的大纲按钮')
    await page.locator('.markdown-outline__close').click()
    await page.waitForTimeout(250)
    assert.equal(await page.locator('.markdown-outline').count(), 0, '点 ✕ 后侧栏应收起')
    assert.equal(await outlineToggle(page).getAttribute('aria-pressed'), 'false')
    await outlineToggle(page).click()
    await page.locator('.markdown-outline').waitFor()
    assert.equal(await outlineToggle(page).getAttribute('aria-pressed'), 'true', '预览态点开关应能把大纲调回来')

    // ⑤b 「复制 Markdown」同样搬到了模式条：它原在顶栏「更多」里，预览态一样被整层盖住、
    //     点不到。这里用 elementFromPoint 证明它够得着，并且点下去真的给出反馈。
    const copyProbe = await page.evaluate(() => {
      const button = document.querySelector('.markdown-note-mode-bar__copy')
      if (!button) return null
      const rect = button.getBoundingClientRect()
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return { reachable: Boolean(top?.closest('.markdown-note-mode-bar__copy')) }
    })
    assert.ok(copyProbe, '模式条应有「复制 Markdown」按钮')
    assert.equal(copyProbe.reachable, true, '预览态下「复制 Markdown」必须点得到（顶栏那层已被盖住）')
    // 「专注模式」已删除，顶栏「更多」菜单随之清空下线 —— 不能留一个点了没反应的空面板。
    assert.equal(await page.locator('.markdown-tools-menu').count(), 0, '顶栏「更多」菜单应已下线')
    assert.equal(await page.locator('[data-label="专注模式"]').count(), 0, '专注模式入口应已移除')
    await page.locator('.markdown-note-mode-bar__copy').click()
    await page.locator('.editor-feedback').waitFor({ state: 'visible', timeout: 5000 })
    // 剪贴板权限被拒时给的是失败提示，两种都算「按钮真的跑通了」。
    assert.match(await page.locator('.editor-feedback').innerText(), /Markdown 已复制|复制失败/, '点复制应给出反馈')

    // ⑥ 大纲在预览态仍然能跳（用渲染出来的标题，且不把单元格里的 h3 算进去）。
    const outlineItems = page.locator('.markdown-outline-item')
    const readPreviewScrollTop = () =>
      page.evaluate(() => document.querySelector('.markdown-note-preview__body')?.scrollTop ?? 0)
    if (await outlineItems.count() > 0) {
      const before = await readPreviewScrollTop()
      await outlineItems.last().click()
      // smooth 在无头下推进不稳：等它真的落位（最多 3s），而不是赌固定 500ms。
      let after = before
      for (let index = 0; index < 30; index += 1) {
        await page.waitForTimeout(100)
        after = await readPreviewScrollTop()
        if (after !== before) break
      }
      assert.notEqual(after, before, '点击大纲项应滚动预览层')
    }

    // ⑦ 退出预览：层消失、编辑器回来、正文一个字都没被动过。
    await modeButton(page, '编辑').click()
    await page.waitForTimeout(400)
    assert.equal(await previewLayer(page).count(), 0)
    assert.equal(await modeButton(page, '预览').getAttribute('aria-pressed'), 'false')
    assert.match(await modeBar(page).innerText(), /编辑模式/)
    const stored = await page.evaluate(
      async (noteId) => (await window.notesDesktop.getNote(noteId))?.content ?? '',
      seeded.noteId
    )
    assert.equal(stored, original, '预览是只读的，正文不得被改写')
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

/**
 * 嵌入卡片在预览里必须是「看得见的卡片」。
 *
 * 为什么只能真窗口验：渲染模块吐出的卡片 HTML 还要过一遍 DOMPurify（它在 node 下不可用），
 * `class` / 结构若被清洗掉，字符串级单测照样全绿，页面上却还是一片空白 —— 正是要修的那个 bug。
 */
test('笔记预览：嵌入卡片不再是一片空白，且标题取实时值', { timeout: 120_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-notes-embed-preview-e2e-'))
  const targetTitle = '被嵌入的目标笔记'
  let application

  try {
    application = await launchApplication(userDataPath)
    const { page } = application

    // 先建「被嵌入的那一篇」，拿到它的真实 ID。
    const targetId = await page.evaluate(async (title) => {
      const note = await window.notesDesktop.createNote(null)
      await window.notesDesktop.updateNote(note.id, { title, content: '目标正文' })
      return note.id
    }, targetTitle)

    // 占位 div 刻意**不写 `title` 属性** —— 这是绝大多数卡片的真实形态，
    // 预览要显示的标题只能靠回查笔记库拿到。
    await seedAndOpenNote(
      page,
      '含嵌入卡片的笔记',
      ['开头', '', `<div data-xynote-embed="note:${targetId}"></div>`, '', '结尾'].join('\n')
    )

    await modeButton(page, '预览').click()
    await previewLayer(page).waitFor()
    const doc = previewDoc(page)
    await doc.waitFor()

    const card = doc.locator('.markdown-embed-placeholder').first()
    await card.waitFor({ timeout: 10_000 })

    // ① 卡片活过了清洗，而且真的可见（不是被剥成空壳）。
    assert.equal(await card.isVisible(), true, '嵌入卡片应在预览里可见')
    // ② 标题显示的是目标笔记的实时标题，而不是「未命名」兜底。
    assert.match(await card.innerText(), new RegExp(targetTitle))
    // ③ 占位 div 不能再露出来 —— 它渲染出来是个看不见的空块，等于信息静默消失。
    assert.equal(await doc.locator('[data-xynote-embed]').count(), 0)
    // ④ 卡片得有实际体量，否则「可见」没有意义。
    const box = await card.boundingBox()
    assert.ok(box && box.height >= 30, `卡片应有实际高度，实际 ${box && box.height}`)
    // ⑤ 卡片前后的正文都还在，插入卡片没吃掉上下文。
    const text = await doc.innerText()
    assert.match(text, /开头/)
    assert.match(text, /结尾/)
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})
