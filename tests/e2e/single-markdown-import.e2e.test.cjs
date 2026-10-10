/**
 * 单个 Markdown 文件导入 —— 端到端回归。
 *
 * ## 背景
 *
 * 此前只能「导入 Markdown 文件夹或 ZIP」，导一个 `.md` 得先塞进一个文件夹，
 * 用户因此改用「复制粘贴正文」，但粘贴只带文字 —— 图片会全部断链。
 *
 * 本次新增「导入单个 Markdown 文件」：不建来源文件夹，但把它引用的本地图片一并搬进来。
 *
 * ⚠️ 对话框是原生 `showOpenDialog`，无人值守环境无法驱动，因此按既有 e2e 的惯例
 * stub 掉「选路径」这一步；其余链路（IPC → 主进程读盘 → 图片落附件目录 → 写库）都是真实实现。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const zlib = require('node:zlib')

const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '../..')
const extraLaunchArgs = (process.env.XINYUE_E2E_ELECTRON_ARGS || '').split(/\s+/).filter(Boolean)

/** 预览图片的固定尺寸：够大才好悬停、好点击（1×1 的图连鼠标都点不准）。 */
const FIXTURE_IMAGE_WIDTH = 240
const FIXTURE_IMAGE_HEIGHT = 120

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/**
 * 生成一张纯色 PNG。
 *
 * 项目里没有可复用的位图资源，而「图片可悬停、可点击」这类交互必须有一个够大的真实图片才测得动，
 * 所以就地按 PNG 规范拼一张（zlib 是 Node 自带的，只差一个 CRC32 表）。
 */
function createSolidPng(width, height) {
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * stride
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = 0x33
      raw[row + 1 + x * 3 + 1] = 0x66
      raw[row + 1 + x * 3 + 2] = 0x99
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

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

/** 让原生文件对话框返回固定路径（对话框本身无法被自动化驱动）。 */
async function stubOpenDialog(application, openPath) {
  await application.electronApplication.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p })
  }, openPath)
}

/** 展开「未分类」并按标题选中笔记，返回其正文。 */
async function openNoteByTitle(page, title) {
  const unclassified = page.getByRole('button', { name: /未分类/ }).first()
  if ((await unclassified.getAttribute('aria-expanded')) === 'false') await unclassified.click()
  await page.waitForSelector('.navigation-panel .sidebar-note-main')
  await page.locator('.navigation-panel .sidebar-note-main').filter({ hasText: title }).first().click()
  await page.locator('.milkdown-editor-root .ProseMirror').waitFor()
  await page.waitForTimeout(800)
  return page.evaluate(() => window.notesDesktop.listWorkspace())
}

test('导入单个 Markdown 文件：不建文件夹、正文入库、本地图片一并搬入', { timeout: 120_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-single-import-'))
  const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-single-src-'))
  const filePath = path.join(sourceDir, '接口说明.md')
  let application

  try {
    // 一张真实尺寸的 PNG，用来验证图片真的被搬进附件目录而不是断链。
    const png = createSolidPng(FIXTURE_IMAGE_WIDTH, FIXTURE_IMAGE_HEIGHT)
    await fs.mkdir(path.join(sourceDir, 'images'), { recursive: true })
    await fs.writeFile(path.join(sourceDir, 'images', 'a.png'), png)
    await fs.writeFile(
      filePath,
      ['# 接口说明', '', '正文第一段', '', '![示意图](images/a.png)', ''].join('\n'),
      'utf8'
    )

    application = await launchApplication(userDataPath)
    const { page } = application
    await stubOpenDialog(application, filePath)

    // 走真实链路：stub 掉原生选路径对话框后，直接调 IPC（对话框之外的环节都是真实实现）
    const imported = await page.evaluate(() => window.notesDesktop.importSingleMarkdown(null))
    assert.equal(imported.canceled, false, '导入不应被取消')
    assert.equal(imported.importedNotes, 1, `应导入 1 篇笔记，实际：${JSON.stringify(imported)}`)
    // 关键：单文件导入不建来源文件夹。
    assert.equal(imported.importedFolders, 0, `单文件导入不该建文件夹，实际：${JSON.stringify(imported)}`)
    assert.match(imported.message, /接口说明/, '结果消息应带上笔记标题')
    assert.match(imported.message, /1 个图片资源/, '结果消息应说明搬入了图片')

    await page.reload()
    await page.waitForFunction(() => Boolean(window.notesDesktop))

    const workspace = await openNoteByTitle(page, '接口说明')
    const note = workspace.notes.find((item) => item.title === '接口说明')
    assert.ok(note, '导入的笔记应出现在工作区里')

    const detail = await page.evaluate((id) => window.notesDesktop.getNote(id), note.id)
    assert.match(detail.content, /正文第一段/, '正文应完整入库')
    // 图片引用必须已被改写成附件地址，而不是留下相对路径（相对路径在新位置必然是断链）。
    assert.doesNotMatch(detail.content, /images\/a\.png/, `图片引用应被改写，实际：${JSON.stringify(detail.content)}`)
    assert.match(detail.content, /xinyue-asset\.local|xinyue-asset:\/\//, '图片应指向应用内附件地址')

    // 关键回归：**预览模式下图片必须真的显示**。
    //
    // 正文里的地址是 `xinyue-asset://local/<id>`，而 DOMPurify 的默认 URI 白名单不含这个协议，
    // 清洗时会把整个 `src` 剥掉（元素还在、图片没了）—— 编辑器不走这条链路，于是
    // 「编辑模式正常、切预览全断」会并存。字符串级单测看不出这个，只有真窗口能量。
    await page.locator('.markdown-note-mode-bar__mode-button').filter({ hasText: '预览' }).click()
    await page.waitForSelector('.markdown-note-preview__doc')
    await page.waitForTimeout(1500)
    const previewImage = await page.evaluate(() => {
      const image = document.querySelector('.markdown-note-preview__doc img')
      return image
        ? { src: image.getAttribute('src'), complete: image.complete, naturalWidth: image.naturalWidth }
        : null
    })
    assert.ok(previewImage, '预览里应该有图片元素')
    assert.match(
      String(previewImage.src),
      /^xinyue-asset:\/\/local\//,
      `预览图片的 src 不该被清洗剥掉，实际：${JSON.stringify(previewImage)}`
    )
    assert.equal(previewImage.complete, true, `图片应完成加载，实际：${JSON.stringify(previewImage)}`)
    assert.equal(
      previewImage.naturalWidth,
      FIXTURE_IMAGE_WIDTH,
      `预览里的图片应是原尺寸渲染（不被压扁），实际：${JSON.stringify(previewImage)}`
    )

    // 图片操作（与本地文件预览共用一套实现）：悬停出工具条、点图进全屏、Esc 退出。
    const previewImageLocator = page.locator('.markdown-note-preview__doc img').first()
    await previewImageLocator.hover()
    await page.waitForSelector('.preview-image-bar')
    assert.equal(
      await page.locator('.preview-image-bar__button').count(),
      4,
      '工具条应有四个操作（全屏 / 复制 / 另存为 / 浏览器打开）'
    )
    assert.equal(
      await page.locator('.preview-image-bar__button').last().isDisabled(),
      true,
      '附件图片不是网络图片，「在浏览器打开」应为禁用态'
    )

    await previewImageLocator.click()
    await page.waitForSelector('.preview-image-viewer')
    // 全屏层必须真的盖在最上面 —— 命中测试比「DOM 里存在」更能说明用户看得见它。
    const topMostClass = await page.evaluate(() => {
      const node = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
      return node ? node.className : ''
    })
    assert.match(
      String(topMostClass),
      /preview-image-viewer/,
      `全屏层应盖在最上面，实际命中：${topMostClass}`
    )

    // 覆盖层是 inset:0，左上角正对窗口交通灯（原生控件浮在内容之上，x≈18、右边界≈70px）。
    // header 必须真的让出安全区，否则「3 / 4」计数被压在红黄绿按钮底下（真机截图确认过）。
    const headerPaddingLeft = await page
      .locator('.preview-image-viewer__header')
      .evaluate((node) => parseFloat(getComputedStyle(node).paddingLeft))
    assert.ok(
      headerPaddingLeft >= 80,
      `查看器 header 应让开交通灯，左边距实际只有 ${headerPaddingLeft}px`
    )

    // 240×120 的图不放大：初始就是 100%。
    assert.equal(
      await page.locator('.preview-image-viewer__percent').innerText(),
      '100%',
      '「适应窗口」对小图不应放大'
    )
    // 滚轮放大 → 百分比必须变；再点 1:1 → 回到 100%。
    await page.mouse.move(
      Math.round((await page.evaluate(() => window.innerWidth)) / 2),
      Math.round((await page.evaluate(() => window.innerHeight)) / 2)
    )
    await page.mouse.wheel(0, -240)
    assert.notEqual(
      await page.locator('.preview-image-viewer__percent').innerText(),
      '100%',
      '滚轮应改变缩放'
    )
    await page.locator('.preview-image-viewer__tool').filter({ hasText: '1:1' }).click()
    assert.equal(
      await page.locator('.preview-image-viewer__percent').innerText(),
      '100%',
      '1:1 应回到原始像素'
    )

    await page.keyboard.press('Escape')
    await page.waitForSelector('.preview-image-viewer', { state: 'detached' })
    assert.equal(await page.locator('.preview-image-viewer').count(), 0, 'Esc 应关闭全屏层')
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
    await fs.rm(sourceDir, { recursive: true, force: true })
  }
})
