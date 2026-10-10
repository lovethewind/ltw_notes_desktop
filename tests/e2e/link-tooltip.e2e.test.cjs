/**
 * 链接气泡（Crepe `Feature.LinkTooltip`）—— 端到端回归。
 *
 * ## 背景（改前实测）
 *
 * 点链接弹出来的那条气泡，左侧图标是「复制」、右侧是「编辑 / 删除」，而**中间的 URL 文字
 * 点了什么都不发生**：`handleEditorLinkClick` 挂在编辑器根节点上，用 `closest('a[href]')`
 * 把气泡里那个 `<a>` 也抓走了，`preventDefault()` 之后又因「编辑态且没按 ⌘」直接 return
 * —— 点击被吞、默认行为也没了。左侧图标则是静默复制（`onCopyLink` 是空函数），零反馈。
 *
 * ## 本轮
 *
 * 1. 气泡里的 URL 文本整条收起（地址改由编辑浮层承担）；
 * 2. 左侧「打开」按钮带文字标签（只剩图标就看不出哪个是主操作）；
 * 3. 点「编辑」不再弹 Crepe 那条光秃秃的输入框，而是自研的表单浮层
 *    （标题 / 地址 / 取消链接 / 保存）—— 靠覆写 `linkTooltipAPI` 的 editLink / addLink 实现。
 *
 * ⚠️ 跳转是否发生**只能看主进程的 `shell.openExternal`**（渲染层拿不到任何痕迹），
 * 所以这里在 main 里打桩记录调用；剪贴板同理，从 main 的 `clipboard` 模块读，
 * 不走渲染层的 `navigator.clipboard`（后者要权限，且读回的是同一个东西，容易假绿）。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '../..')
const extraLaunchArgs = (process.env.XINYUE_E2E_ELECTRON_ARGS || '').split(/\s+/).filter(Boolean)

const LINK_URL = 'https://www.yuque.com/sshb9/mab60tz'
const CLIPBOARD_SENTINEL = 'xinyue-sentinel-please-ignore'

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

async function openNoteByTitle(page, title) {
  const unclassified = page.getByRole('button', { name: /未分类/ }).first()
  if ((await unclassified.getAttribute('aria-expanded')) === 'false') await unclassified.click()
  await page.waitForSelector('.navigation-panel .sidebar-note-main')
  await page.locator('.navigation-panel .sidebar-note-main').filter({ hasText: title }).first().click()
  await page.locator('.milkdown-editor-root .ProseMirror').waitFor()
  await page.waitForTimeout(900)
}

/** 让链接气泡弹出来（它是 hover 触发的，且要求编辑器有焦点）。 */
async function hoverLink(page, anchor) {
  const box = await anchor.boundingBox()
  assert.ok(box, '应能拿到链接的位置')
  const cx = Math.round(box.x + box.width / 2)
  const cy = Math.round(box.y + box.height / 2)
  await page.mouse.move(cx, cy)
  await page.waitForTimeout(200)
  await page.mouse.move(cx + 1, cy + 1)
  await page.waitForTimeout(400)
  return { cx, cy }
}

/** 元素中心的实际形状（真几何，正则证不了「生效」）。 */
function readShape(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const style = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      borderRadius: style.borderRadius,
      borderWidth: style.borderTopWidth,
      background: style.backgroundColor,
      boxShadow: style.boxShadow,
      fontSize: style.fontSize,
      zIndex: style.zIndex,
      cursor: style.cursor
    }
  }, selector)
}

test('链接气泡：不展示 URL、打开/复制分流、编辑走自研浮层、不被顶栏吃掉', { timeout: 180_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-link-tooltip-'))
  const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-link-tooltip-src-'))
  const filePath = path.join(sourceDir, '链接气泡.md')
  let application

  try {
    // ⚠️ 末尾这批填充段是**必要的前提**：⑥ 要把链接滚到「顶栏下沿正下方」，
    // 内容不够长时滚动容器压根滚不动（`scrollTop` 被夹到 0），那个场景会静默失效。
    const filler = Array.from({ length: 40 }, (_v, i) => `填充段落 ${i + 1}：用来把滚动容器撑得足够长。`)
    await fs.writeFile(
      filePath,
      [
        '# 链接气泡',
        '',
        `正文里带一个 [测试链接](${LINK_URL}) ，用来触发气泡。`,
        '',
        ...filler.flatMap((line) => [line, '']),
        ''
      ].join('\n'),
      'utf8'
    )

    application = await launchApplication(userDataPath)
    const { page, electronApplication } = application

    // 主进程打桩：记 shell.openExternal 调用；剪贴板从 main 的 clipboard 模块读。
    await electronApplication.evaluate(({ shell }) => {
      globalThis.__openedLinks = []
      const original = shell.openExternal.bind(shell)
      shell.openExternal = async (url) => {
        globalThis.__openedLinks.push(String(url))
        return original(url)
      }
    })
    const resetOpened = () => electronApplication.evaluate(() => { globalThis.__openedLinks = [] })
    const readOpened = () => electronApplication.evaluate(() => globalThis.__openedLinks)
    const writeClipboard = (text) =>
      electronApplication.evaluate(({ clipboard }, value) => clipboard.writeText(value), text)
    const readClipboard = () => electronApplication.evaluate(({ clipboard }) => clipboard.readText())

    await electronApplication.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
    }, filePath)
    await page.evaluate(() => window.notesDesktop.importSingleMarkdown(null))
    await page.reload()
    await page.waitForFunction(() => Boolean(window.notesDesktop))
    await openNoteByTitle(page, '链接气泡')

    const anchor = page.locator('.milkdown-editor-root .ProseMirror a[href]').first()
    await anchor.waitFor()
    // 先点一下让编辑器拿到焦点（气泡的显示条件是 `view.hasFocus()`）；编辑态裸点击只落光标、不跳转。
    const box = await anchor.boundingBox()
    await page.mouse.click(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2))
    await page.waitForTimeout(250)
    assert.deepEqual(await readOpened(), [], '编辑态点链接正文只应落光标，不应跳转')

    await hoverLink(page, anchor)
    const tooltip = page.locator('.milkdown-link-preview')
    await tooltip.waitFor()
    assert.equal(
      await page.locator('.milkdown-link-preview[data-show="true"]').count(),
      1,
      '悬停链接应弹出气泡'
    )

    // ---- ① 气泡不再展示 URL 文本（地址移交给编辑浮层）----
    await resetOpened()
    assert.equal(
      await page.locator('.milkdown-link-preview .link-display').count(),
      1,
      '⚠️ URL 节点**只隐藏、不许删** ——「打开」按钮点击的就是这个 <a>'
    )
    assert.equal(
      await page.locator('.milkdown-link-preview .link-display').isVisible(),
      false,
      'URL 文本应整条收起（地址改由编辑浮层的「地址」一行承担）'
    )

    // ---- ② 点「打开」→ 跳转 + 带文字标签 + 不许顺手改剪贴板 ----
    await writeClipboard(CLIPBOARD_SENTINEL)
    await resetOpened()
    await hoverLink(page, anchor)
    const openLabel = (await page
      .locator('.milkdown-link-preview .xynote-link-tooltip-open-label')
      .innerText()
      .catch(() => '')).trim()
    assert.equal(openLabel, '打开', '「打开」按钮应带文字标签（只剩图标看不出哪个是主操作）')
    await page.locator('.xynote-link-tooltip-open').click()
    await page.waitForTimeout(600)
    assert.deepEqual(await readOpened(), [LINK_URL], '点「打开」应跳转')
    assert.equal(
      await readClipboard(),
      CLIPBOARD_SENTINEL,
      '点「打开」不应顺手覆盖剪贴板（那会退化成 Crepe 自带的复制行为）'
    )

    // ---- ③ 点「复制」→ 写剪贴板 + 出提示 ----
    await hoverLink(page, anchor)
    await page.locator('.xynote-link-tooltip-copy').click()
    await page.waitForTimeout(400)
    assert.equal(await readClipboard(), LINK_URL, '点「复制」应把链接写进剪贴板')
    assert.equal(
      (await page.locator('.editor-feedback').innerText().catch(() => '')).trim(),
      '链接已复制',
      '复制后应给出反馈（改前是静默复制）'
    )

    // ---- ④ 外观：美化真的生效（正则只能证明「写了」）----
    await hoverLink(page, anchor)
    const container = await readShape(page, '.milkdown-link-preview > .link-preview')
    assert.equal(container.borderRadius, '12px', `气泡圆角应为 12px，实际 ${container?.borderRadius}`)
    assert.equal(container.borderWidth, '1px', `气泡应有 1px 描边，实际 ${container?.borderWidth}`)
    assert.ok(
      container.width < 220,
      `拿掉 URL 后气泡应明显变窄（改前含 220px URL 时约 360px），实际 ${container?.width}`
    )
    // z-index 在**外层定位元素**上（`.link-preview` 只是它里面的 flex 条）。
    const positioner = await readShape(page, '.milkdown-link-preview')
    assert.equal(positioner.zIndex, '30', `气泡 z-index 应为 30（兜底不许被顶栏吃掉），实际 ${positioner?.zIndex}`)
    assert.equal(await page.locator('.milkdown-link-preview .xynote-link-tooltip-open').count(), 1, '应有一个「打开」按钮')
    assert.equal(await page.locator('.milkdown-link-preview .xynote-link-tooltip-copy').count(), 1, '应有一个「复制」按钮')
    const openButton = await readShape(page, '.xynote-link-tooltip-open')
    assert.ok(openButton.width > 30, `「打开」带文字标签后应比 30px 方块宽，实际 ${openButton?.width}`)
    assert.equal(openButton.height, 30, `「打开」按钮高应为 30px，实际 ${openButton?.height}`)
    const button = await readShape(page, '.xynote-link-tooltip-copy')
    assert.equal(button.width, 30, `「复制」仍应是 30px 方块，实际 ${button?.width}`)
    assert.equal(button.height, 30, `「复制」仍应是 30px 方块，实际 ${button?.height}`)
    const iconSize = await page.evaluate(() => {
      const svg = document.querySelector('.milkdown-link-preview .xynote-link-tooltip-open svg')
      if (!svg) return null
      const rect = svg.getBoundingClientRect()
      return Math.round(rect.width)
    })
    assert.equal(iconSize, 19, `图标应为 19px（与选中气泡同规格），实际 ${iconSize}`)
    await page.screenshot({ path: '/tmp/link-tooltip-after.png' })

    // ---- ⑤ 点「编辑」→ 自研表单浮层；Crepe 自带的输入框气泡不许再出现 ----
    await hoverLink(page, anchor)
    await page.locator('.milkdown-link-preview .link-edit-button').click()
    await page.waitForTimeout(400)
    // ⚠️ 先查「Crepe 自带气泡没出现」再等自研浮层：反过来一旦覆写失效，
    // 会先卡在「浮层等不到」上，真正的原因（两套编辑界面并存）就被掩盖了。
    assert.equal(
      await page.locator('.milkdown-link-edit[data-show="true"]').count(),
      0,
      'Crepe 自带的编辑气泡已被接管，不该再出现（否则两套编辑界面并存）'
    )
    const popover = page.locator('.link-edit-popover')
    await popover.waitFor()
    const titleInput = page.locator('.link-edit-popover__input').first()
    const hrefInput = page.locator('.link-edit-popover__input--mono')
    assert.equal(await titleInput.inputValue(), '测试链接', '「标题」应预填当前链接文字')
    assert.equal(await hrefInput.inputValue(), LINK_URL, '「地址」应预填当前链接地址')
    // 浮层必须完整落在窗口内 —— 链接贴右缘 / 窗口不高时最容易跑出屏幕。
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    const popRect = await popover.boundingBox()
    assert.ok(popRect, '应能拿到浮层位置')
    assert.ok(
      popRect.x >= 0 &&
        popRect.y >= 0 &&
        popRect.x + popRect.width <= viewport.width + 1 &&
        popRect.y + popRect.height <= viewport.height + 1,
      `浮层应完整落在窗口内：${JSON.stringify(popRect)} / 窗口 ${JSON.stringify(viewport)}`
    )
    await page.screenshot({ path: '/tmp/link-tooltip-popover.png' })

    // 标题与地址都要能改，并写回正文。
    await titleInput.fill('改过的标题')
    await hrefInput.fill(`${LINK_URL}?updated=1`)
    await page.locator('.link-edit-popover__save').click()
    await page.waitForTimeout(500)
    assert.equal(await popover.count(), 0, '保存后浮层应关闭')
    const editedLink = page.locator('.milkdown-editor-root .ProseMirror a[href]').first()
    assert.equal(await editedLink.innerText(), '改过的标题', '「标题」应写回链接文字')
    assert.equal(await editedLink.getAttribute('href'), `${LINK_URL}?updated=1`, '「地址」应写回 href')

    // ---- ⑥ 链接紧贴顶栏时，气泡不许被顶栏吃掉 ----
    // 顶栏是 sticky 且 z-index 20，Crepe 只给气泡 10 —— 链接落在顶栏下沿一个气泡高之内时，
    // floating-ui 会认为「上方有空间」（它只按滚动容器算，顶栏就在容器里），把气泡放进顶栏那条带里。
    await page.evaluate(() => {
      const prose = document.querySelector('.milkdown-editor-root .ProseMirror')
      prose?.focus()
    })
    const setup = await page.evaluate(() => {
      const container = document.querySelector('.milkdown-editor-scroll')
      const bar = document.querySelector('.milkdown-top-bar')
      const link = document.querySelector('.milkdown-editor-root .ProseMirror a[href]')
      if (!container || !bar || !link) return null
      // 把链接滚到「顶栏下沿再往下 10px」处 —— 正是会被盖住的那条带。
      const target = bar.getBoundingClientRect().bottom + 10
      container.scrollTop += link.getBoundingClientRect().top - target
      return {
        barBottom: Math.round(bar.getBoundingClientRect().bottom),
        linkTop: Math.round(link.getBoundingClientRect().top)
      }
    })
    assert.ok(setup, '场景准备失败：拿不到滚动容器 / 顶栏 / 链接')
    await page.waitForTimeout(300)
    // ⚠️ 用 page.mouse.move 触发（真实事件走编辑器自己的 mousemove 处理器）；不要点击 ——
    // 点击会落光标，浏览器随即把光标滚进视野，前面的滚动量就白调了。
    await page.mouse.move(0, 0)
    await page.waitForTimeout(150)
    const linkBox = await anchor.boundingBox()
    await page.mouse.move(
      Math.round(linkBox.x + linkBox.width / 2),
      Math.round(linkBox.y + linkBox.height / 2)
    )
    await page.waitForTimeout(500)
    const overlap = await page.evaluate(() => {
      const tooltipEl = document.querySelector('.milkdown-link-preview')
      const barEl = document.querySelector('.milkdown-top-bar')
      if (!tooltipEl || !barEl) return null
      const tr = tooltipEl.getBoundingClientRect()
      const br = barEl.getBoundingClientRect()
      const cx = Math.round(tr.left + tr.width / 2)
      const cy = Math.round(tr.top + tr.height / 2)
      const topmost = document.elementsFromPoint(cx, cy)[0] || null
      return {
        tooltipTop: Math.round(tr.top),
        barBottom: Math.round(br.bottom),
        coveredBy: Math.round(Math.max(0, br.bottom - tr.top)),
        topmostIsTooltip: Boolean(topmost && topmost.closest('.milkdown-link-preview'))
      }
    })
    assert.ok(overlap, '场景失效：气泡或顶栏不存在')
    assert.ok(overlap.coveredBy > 0, `场景失效：气泡未压到顶栏（覆盖 ${overlap.coveredBy}px），守卫守不到回归`)
    assert.ok(
      overlap.topmostIsTooltip,
      `气泡不许被顶栏吃掉：气泡 top=${overlap.tooltipTop}，顶栏 bottom=${overlap.barBottom}`
    )

    // ---- ⑦「取消链接」只摘链接、保留文字 ----
    await hoverLink(page, anchor)
    await page.locator('.milkdown-link-preview .link-edit-button').click()
    await page.locator('.link-edit-popover').waitFor()
    await page.locator('.link-edit-popover__remove').click()
    await page.waitForTimeout(500)
    assert.equal(await page.locator('.link-edit-popover').count(), 0, '取消链接后浮层应关闭')
    assert.equal(
      await page.locator('.milkdown-editor-root .ProseMirror a[href]').count(),
      0,
      '链接标记应被摘掉'
    )
    const proseText = await page.locator('.milkdown-editor-root .ProseMirror').first().innerText()
    assert.ok(proseText.includes('改过的标题'), '「取消链接」只摘链接，文字必须原样保留')
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true }).catch(() => {})
    await fs.rm(sourceDir, { recursive: true, force: true }).catch(() => {})
  }
})
