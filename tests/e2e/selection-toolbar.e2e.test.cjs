/**
 * 选中气泡（Crepe 的 Toolbar）——美化 + 内嵌字号下拉的端到端回归。
 *
 * ## 为什么必须用 e2e
 *
 * 单测只能对源码做正则匹配，下面这几条只有真跑起来才测得出来：
 *
 * 1. **覆写到底有没有生效**（Computed Style 才是真相 —— 特异性不够时正则照样匹配，
 *    但页面上一像素都没变）；
 * 2. **`buildToolbar` 有没有真的接上**（Crepe 的 Toolbar 是编译产物里的一段 Vue 渲染函数，
 *    接错组名会直接抛错或静默不渲染）；
 * 3. **在气泡里开弹层时气泡会不会自己消失**（Crepe 的显示条件里有一条
 *    `document.activeElement` 必须在正文或气泡内 —— 弹层挂在 body 上，失焦就收摊）；
 * 4. **`pointerdown` 之后补发的 click 有没有被截住**（不截的话面板刚开就被
 *    document 上常驻的 closeToolbarMenus 关掉，表现为「点了没反应」，无任何报错）。
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

/** 用 IPC 直接建一篇笔记并打开它（建笔记只是前置条件，不依赖顶栏 UI 措辞）。 */
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

/**
 * 打字并选中末尾若干个字符，等气泡浮出来。
 *
 * 用 Shift+方向键而不是拖拽：选区确定、可重复，且与用户拖选走同一条 DOM 选区路径。
 *
 * :param page: Electron 页面。
 * :param text: 要输入的正文。
 * :param selectLength: 从末尾往左选多少个字符。
 * :return: 无返回值。
 */
async function typeAndSelect(page, text, selectLength) {
  await clearAndFocus(page)
  await page.keyboard.type(text)
  await page.waitForTimeout(300)
  for (let i = 0; i < selectLength; i += 1) await page.keyboard.press('Shift+ArrowLeft')
  await page.waitForSelector('.milkdown-toolbar[data-show="true"]', { timeout: 10_000 })
  await page.waitForTimeout(250)
}

/** 气泡里的「字号」按钮（Crepe 不给按钮自定义属性，只能靠图标里的标记 span 定位）。 */
function fontSizeBubbleButton(page) {
  return page.locator('.milkdown-toolbar .toolbar-item:has(.xynote-fs-trigger)')
}

/** 气泡浮起时可见的那个字号面板（顶栏下拉那份不带 is-portal-open）。 */
function bubbleFontSizePanel(page) {
  return page.locator('.markdown-font-size-menu__panel.is-portal-open')
}

/** 读落库正文。 */
function readStoredContent(page, noteId) {
  return page.evaluate(async (id) => (await window.notesDesktop.getNote(id))?.content ?? '', noteId)
}

/**
 * 读气泡与顶栏的实况几何（避让逻辑只能靠真几何验证）。
 *
 * :param page: Electron 页面。
 * :return: 顶栏下沿、气泡上下沿、选区上下沿、该点最上层元素等。
 */
function readBubbleGeometry(page) {
  return page.evaluate(() => {
    const toolbar = document.querySelector('.milkdown-toolbar')
    const topBar = document.querySelector('.milkdown-top-bar')
    const selection = window.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    if (!toolbar || !topBar || !range) return null
    const barRect = topBar.getBoundingClientRect()
    const toolRect = toolbar.getBoundingClientRect()
    const selectionRect = range.getBoundingClientRect()
    const x = toolRect.left + toolRect.width / 2
    const y = toolRect.top + 2
    return {
      barBottom: barRect.bottom,
      bubbleTop: toolRect.top,
      bubbleBottom: toolRect.bottom,
      bubbleHeight: toolRect.height,
      selectionTop: selectionRect.top,
      selectionBottom: selectionRect.bottom,
      // floating-ui 没被避让时的原生落点（placement: top，offset 10）
      naturalTop: selectionRect.top - 10 - toolRect.height,
      viewportHeight: window.innerHeight,
      topMost: [...document.elementsFromPoint(x, y)]
        .slice(0, 3)
        .map((element) => String(element.className ?? element.tagName))
        .join(' | ')
    }
  })
}

/** 等自动保存落库（防抖 1500ms，且轮询必须在 Node 侧做，见 inline-font-size e2e 的说明）。 */
async function waitForStored(page, noteId, { includes } = {}) {
  const deadline = Date.now() + 20_000
  let content = ''
  for (;;) {
    content = String(await readStoredContent(page, noteId))
    if (!includes || content.includes(includes)) return content
    if (Date.now() > deadline) {
      throw new Error(`等待落库超时：includes=${includes}，实际 ${JSON.stringify(content)}`)
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

test('选中气泡：覆写真的生效（圆角 / 按钮尺寸 / 分隔线），且「字号」按钮在首组内', { timeout: 120_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-bubble-look-'))
  let application
  try {
    application = await launchApplication(userDataPath)
    const { page } = application
    await seedAndOpenNote(page, '气泡外观', '占位')
    await typeAndSelect(page, 'abcdefgh', 4)

    // ① 覆写生效的真凭据是 Computed Style —— 正则只能证明「写了」，证明不了「赢了 Crepe」。
    const look = await page.evaluate(() => {
      const toolbar = document.querySelector('.milkdown-toolbar')
      const items = [...document.querySelectorAll('.milkdown-toolbar .toolbar-item')]
      const divider = document.querySelector('.milkdown-toolbar .divider')
      const trigger = document.querySelector('.milkdown-toolbar .xynote-fs-trigger')
      const button = trigger?.closest('.toolbar-item')
      if (!toolbar || !items.length || !divider || !button) return null
      const bar = window.getComputedStyle(toolbar)
      const item = window.getComputedStyle(items[0])
      const fontSizeItem = window.getComputedStyle(button)
      // 气泡内的子节点顺序（用来确认「字号」落在第一个分组里，而不是被塞到分隔线之后）。
      const children = [...toolbar.children]
      return {
        borderRadius: bar.borderRadius,
        paddingLeft: bar.paddingLeft,
        borderWidth: bar.borderWidth,
        itemWidth: item.width,
        itemHeight: item.height,
        itemRadius: item.borderRadius,
        itemIconWidth: window.getComputedStyle(items[0].querySelector('svg')).width,
        dividerHeight: window.getComputedStyle(divider).height,
        itemCount: items.length,
        fontSizeButtonWidth: fontSizeItem.width,
        triggerIndex: children.indexOf(button),
        dividerIndex: children.indexOf(divider)
      }
    })
    assert.ok(look, '应能找到气泡、按钮、分隔线与「字号」触发器')

    assert.equal(look.borderRadius, '12px', '气泡应被覆写成 12px 圆角（Crepe 默认 8px）')
    assert.equal(look.paddingLeft, '5px', '气泡应有自己的内边距（默认靠按钮 margin 撑开）')
    assert.equal(look.borderWidth, '1px', '气泡应有 1px 描边')
    assert.equal(look.itemWidth, '30px', '按钮宽度应为 30px（默认 32px）')
    assert.equal(look.itemHeight, '30px', '按钮高度应为 30px')
    assert.equal(look.itemRadius, '8px', '按钮圆角应为 8px（默认 4px）')
    assert.equal(look.itemIconWidth, '19px', '图标应为 19px（默认 24px）')
    assert.equal(look.dividerHeight, '18px', '分隔线应为 18px（默认 24px + 10px 外边距）')

    // ② 「字号」按钮真的被 buildToolbar 挂进来了，而且落在第一个分组（格式化组）里。
    //    同一组内不会有分隔线；若被塞进新分组，它前面会多出一条分隔线 —— 这里直接比下标。
    assert.ok(look.itemCount >= 7, `气泡里应有原生 6 项 + 字号，实际 ${look.itemCount} 项`)
    assert.ok(
      look.triggerIndex >= 0 && look.triggerIndex < look.dividerIndex,
      `「字号」应在第一个分组内（字号下标 ${look.triggerIndex}，分隔线下标 ${look.dividerIndex}）`
    )
    // ③ :has() 生效 → 该按钮比其余按钮宽（要给小箭头留位置），而不是被裁掉。
    assert.ok(
      Number.parseFloat(look.fontSizeButtonWidth) >= 30,
      `「字号」按钮应至少 30px 宽，实际 ${look.fontSizeButtonWidth}`
    )
  } finally {
    if (application?.electronApplication) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

test('选中气泡：选区贴着顶栏时必须翻到选区下方，不许被顶栏吃掉上半截', { timeout: 120_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-bubble-topbar-'))
  let application
  try {
    application = await launchApplication(userDataPath)
    const { page } = application
    // 单段文档 = 首行，选区必然贴着顶栏 —— 就是用户截图里的场景。
    await seedAndOpenNote(page, '气泡避让', '占位')
    await typeAndSelect(page, 'abcdefgh', 4)

    const hit = await readBubbleGeometry(page)
    assert.ok(hit, '应能读到气泡、顶栏与选区')
    // 前提：这**确实**是会撞上顶栏的场景。若哪天顶栏变矮 / 内边距变小导致撞不上，
    // 这条会先红，提醒改场景而不是让守卫静默失效。
    assert.ok(
      hit.naturalTop < hit.barBottom,
      `前提不成立：原生落点 ${hit.naturalTop} 应高过顶栏下沿 ${hit.barBottom}（否则这条守不到回归）`
    )

    // ① 🔴 气泡顶边必须在顶栏下沿之下。修复前实测 226.5 < 242（被盖 15.5px，连 12px 圆角一起）。
    assert.ok(
      hit.bubbleTop >= hit.barBottom,
      `气泡不许压住顶栏：气泡 top=${hit.bubbleTop}，顶栏 bottom=${hit.barBottom}`
    )
    // ② 事实上的落点：翻到**选区下方**（与钉钉 / Word 一致，而不是贴着顶栏）。
    assert.ok(
      hit.bubbleTop >= hit.selectionBottom - 0.5,
      `撞上顶栏时应翻到选区下方：气泡 top=${hit.bubbleTop}，选区 bottom=${hit.selectionBottom}`
    )
    // ③ 该点最上层必须是气泡本身（层级兜底：顶栏 z-index 20 > Crepe 给气泡的 10）。
    assert.match(hit.topMost, /milkdown-toolbar/, `气泡顶边处最上层应是气泡本身，实际 ${hit.topMost}`)
    // ④ 完全落在视口内。
    assert.ok(
      hit.bubbleBottom <= hit.viewportHeight,
      `气泡不许掉出视口：bottom=${hit.bubbleBottom}，视口高=${hit.viewportHeight}`
    )

    // ⑤ 对照组：换一篇多段文档，选**第三段** —— 没撞上顶栏时必须保持 floating-ui 的原生
    //    「上方」落点，证明避让只处理「会撞上」的那一种情况，没有把气泡无差别翻到下面去。
    //    ⚠️ 不能用 `Meta+Home` 挪光标：macOS 上它由系统层面接管，在 contenteditable 里
    //    不一定生效（实测没生效，剩下的 Enter 把上一轮的选区吃掉了，文档悄悄少了一段）。
    //    用真实点击定位，与用户操作同路径。
    await seedAndOpenNote(page, '气泡避让中段', '第一段正文内容\n\n第二段正文内容\n\n第三段正文内容\n\n第四段正文内容\n')
    await page.locator('.milkdown-editor-root .ProseMirror p').nth(2).click({ position: { x: 6, y: 8 } })
    await page.waitForTimeout(300)
    for (let index = 0; index < 4; index += 1) await page.keyboard.press('Shift+ArrowRight')
    await page.waitForSelector('.milkdown-toolbar[data-show="true"]', { timeout: 10_000 })
    await page.waitForTimeout(450)

    const mid = await readBubbleGeometry(page)
    assert.ok(mid, '应能读到中段选区的气泡几何')
    assert.ok(
      mid.naturalTop >= mid.barBottom,
      `前提不成立：中段选区的原生落点 ${mid.naturalTop} 应低于顶栏下沿 ${mid.barBottom}`
    )
    assert.ok(
      mid.bubbleBottom <= mid.selectionTop + 0.5,
      `没撞上顶栏时应保持原生「上方」落点：气泡 bottom=${mid.bubbleBottom}，选区 top=${mid.selectionTop}`
    )
  } finally {
    if (application?.electronApplication) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})

test('选中气泡：点开字号面板时气泡不消失，选完写进正文', { timeout: 120_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-bubble-fs-'))
  let application
  try {
    application = await launchApplication(userDataPath)
    const { page } = application
    const noteId = await seedAndOpenNote(page, '气泡字号', '占位')
    await typeAndSelect(page, 'abcdefgh', 4)

    const button = fontSizeBubbleButton(page)
    const buttonRect = await button.boundingBox()
    assert.ok(buttonRect, '应能取到「字号」按钮的位置')

    // ① 点开面板。按钮自身的展开动作挂在 pointerdown 上（Crepe 的 Toolbar 只监听 pointerdown）。
    await button.click()
    await bubbleFontSizePanel(page).waitFor({ timeout: 10_000 })

    // ② ⚠️ 本轮最险的一条：气泡**必须还在**。
    //    Crepe 的显示条件里有一条「document.activeElement 必须在正文或气泡内」，
    //    面板挂在 body 上 —— 只要 pointerdown 没被 preventDefault，焦点就会跑到面板上，
    //    气泡当场收摊；用户看到的是「点了一下，工具条和菜单一起消失」。
    assert.equal(
      await page.locator('.milkdown-toolbar').getAttribute('data-show'),
      'true',
      '打开字号面板后气泡不应消失'
    )

    // ③ 面板贴在按钮旁边，但**绝不许盖住按钮** —— 盖住的话既点不回去收起，
    //    松开鼠标时落点也注定落在面板里，`click` 的 target 会从按钮变成 BODY（见第 ⑧ 条）。
    const panelRect = await bubbleFontSizePanel(page).boundingBox()
    assert.ok(panelRect, '应能取到面板位置')
    const panelBelow = panelRect.y >= buttonRect.y + buttonRect.height - 2
    const panelAbove = panelRect.y + panelRect.height <= buttonRect.y + 2
    assert.ok(
      panelBelow || panelAbove,
      `面板不得覆盖按钮：按钮 ${buttonRect.y}~${buttonRect.y + buttonRect.height}，` +
        `面板 ${panelRect.y}~${panelRect.y + panelRect.height}`
    )
    assert.ok(
      panelRect.x + panelRect.width > buttonRect.x && panelRect.x < buttonRect.x + buttonRect.width,
      '面板应与按钮有水平重叠（居中在按钮处）'
    )
    assert.deepEqual(
      (await bubbleFontSizePanel(page).locator('.markdown-font-size-menu__item').allTextContents())
        .map((text) => text.trim()),
      ['9', '10', '11', '12', '14', '15', '16', '18', '20', '22', '24', '26', '28', '36', '42', '48', '72'],
      '气泡面板应与顶栏下拉用同一套档位'
    )
    // 当前选区（无标记）应打勾在 15。
    assert.deepEqual(
      (await bubbleFontSizePanel(page).locator('.markdown-font-size-menu__item[aria-checked="true"]')
        .allTextContents()).map((text) => text.trim()),
      ['15'],
      '未设字号时应打勾在 15'
    )

    // ④ 选 20：从气泡里改字号，效果与顶栏下拉完全一致 —— 写进正文、被选中文字放大。
    await bubbleFontSizePanel(page)
      .locator('.markdown-font-size-menu__item')
      .filter({ hasText: /^20$/ })
      .click()
    await page.waitForTimeout(400)

    const span = await readFontSizeSpan(page)
    assert.ok(span, '从气泡设字号后应生成行内字号 span')
    assert.equal(span.text, 'efgh', 'span 应恰好包住选中的文字')
    assert.equal(span.fontSize, 20, `选中文字的计算字号应为 20px，实际 ${span.fontSize}px`)

    // ⑤ 面板已收起，且气泡还在（选区没变），用户可以接着改别的格式。
    assert.equal(await bubbleFontSizePanel(page).count(), 0, '选完后面板应收起')
    assert.equal(
      await page.locator('.milkdown-toolbar').getAttribute('data-show'),
      'true',
      '应用字号后气泡应仍然可见'
    )

    // ⑥ 落盘为标准 HTML（与顶栏下拉同一条落库路径）。
    const content = await waitForStored(page, noteId, { includes: 'font-size:20px' })
    assert.match(
      content,
      /abcd<span style="font-size:20px">efgh<\/span>/,
      `落盘正文应包住选中的 efgh，实际：${JSON.stringify(content)}`
    )

    // ⑦ 再点一次按钮 → 面板开合并（同一按钮开合，不需要点别处）。
    await button.click()
    await bubbleFontSizePanel(page).waitFor({ timeout: 10_000 })
    await button.click()
    await page.waitForTimeout(300)
    assert.equal(await bubbleFontSizePanel(page).count(), 0, '再次点击「字号」按钮应收起面板')

    // ⑧ ⚠️⚠️ 真实鼠标不是合成点击：按下与松开之间落点一定会动。
    //    而 `click` 的 target 是 mousedown / mouseup 两点的**最近公共祖先** —— 面板就贴在
    //    按钮下方 8px 处展开，松开时只要比按下时低 8px，mouseup 就落进面板，target 从
    //    `BUTTON.toolbar-item` 直接变成 `BODY`，任何按落点判定的守卫都**静默落空**，
    //    面板当场被 document 上的 closeToolbarMenus 关掉（现象：「必须按住才在，一松手就没」）。
    //    Playwright 的 `click()` 是零位移合成点击，所以这条必须自己造位移才守得住。

    // ⑧-1 按在图标以外的空白处（按钮被 :has() 放宽到 43px，标记 span 只有 33px，左右各有留白）。
    const freshRect = await button.boundingBox()
    assert.ok(freshRect, '应能取到「字号」按钮的最新位置')
    const blankPoint = await page.evaluate(({ x, y, width }) => {
      for (let offset = 1; offset <= width / 2; offset += 1) {
        const pointX = x + width - offset
        const element = document.elementFromPoint(pointX, y)
        const className = String(element?.className ?? '')
        if (className.includes('toolbar-item')) return { x: pointX, y, hit: `${element.tagName}|${className}` }
      }
      return null
    }, { x: freshRect.x, y: freshRect.y + freshRect.height / 2, width: freshRect.width })
    assert.ok(blankPoint, '应能在按钮上找到图标以外的空白可点区（本用例要守的位置）')
    // 该落点上「回按钮再反查」必须命中：只认标记 span 的判定会落空（span 是按钮的后代而非祖先）。
    assert.equal(
      await page.evaluate(({ x, y }) => {
        const element = document.elementFromPoint(x, y)
        const item = element?.closest?.('.milkdown-toolbar .toolbar-item')
        return Boolean(item?.querySelector?.('.xynote-fs-trigger'))
      }, { x: blankPoint.x, y: blankPoint.y }),
      true,
      '按钮留白处必须能反查回「字号」按钮'
    )

    // ⑧-2 按下与松开都停在按钮上 → 面板保留。
    await page.mouse.move(blankPoint.x, blankPoint.y)
    await page.mouse.down()
    await page.mouse.up()
    await bubbleFontSizePanel(page).waitFor({ timeout: 10_000 })
    await page.waitForTimeout(300)
    assert.equal(await bubbleFontSizePanel(page).count(), 1, `点按钮留白（${blankPoint.hit}）打开的面板必须保留`)

    // 收起，给下一条腾出「面板未打开」的初始态。
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    assert.equal(await bubbleFontSizePanel(page).count(), 0, 'Esc 应收起面板')

    // ⑧-3 按下在按钮上、松开时向下漂移 20px（真人手抖的下限）→ 面板**必须仍然保留**。
    const driftPoint = { x: blankPoint.x, y: blankPoint.y + 20 }
    const driftShape = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y)
      return {
        hit: `${element?.tagName}|${String(element?.className ?? '').slice(0, 40)}`,
        stillInButton: Boolean(element?.closest?.('.milkdown-toolbar .toolbar-item'))
      }
    }, driftPoint)
    assert.equal(
      driftShape.stillInButton,
      false,
      `漂移点上落点应已离开按钮（否则这条用例守不到回归）：${driftShape.hit}`
    )

    await page.mouse.move(blankPoint.x, blankPoint.y)
    await page.mouse.down()
    await page.waitForTimeout(150)
    await page.mouse.move(driftPoint.x, driftPoint.y)
    await page.waitForTimeout(150)
    await page.mouse.up()
    await page.waitForTimeout(400)
    assert.equal(
      await bubbleFontSizePanel(page).count(),
      1,
      `松开时落点离开按钮（${driftShape.hit}）也不许把面板关掉 —— 判定必须用按下的落点`
    )
  } finally {
    if (application?.electronApplication) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
  }
})
