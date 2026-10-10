/**
 * 编辑态（Crepe）图片交互。
 *
 * 背景：编辑器里的图片是 Crepe 的 nodeView，结构为
 * `.milkdown-image-block > .image-wrapper > img`，而 **wrapper 盖在 img 之上**（拦截指针事件），
 * 且 wrapper 里还住着 Crepe 自己的图注按钮与缩放手柄 —— 容器事件委托的图片判定必须为它兜底，
 * 否则「点不到图片」，而右键菜单还会因为两个 handler 口径不一致一次弹出两个。
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

/** 生成一张实心 PNG —— 1×1 的图连鼠标都点不准，交互断言需要够大的靶子。 */
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

async function openNoteByTitle(page, title) {
  const unclassified = page.getByRole('button', { name: /未分类/ }).first()
  if ((await unclassified.getAttribute('aria-expanded')) === 'false') await unclassified.click()
  await page.waitForSelector('.navigation-panel .sidebar-note-main')
  await page.locator('.navigation-panel .sidebar-note-main').filter({ hasText: title }).first().click()
  await page.locator('.milkdown-editor-root .ProseMirror').waitFor()
  await page.waitForTimeout(900)
}

/** 当前可见的自定义右键菜单（`position: fixed`，只能用 getClientRects 判可见）。 */
function listMenus(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.resource-context-menu'))
      .filter((node) => node.getClientRects().length > 0)
      .map((node) => (node.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40))
  )
}

/** 两个菜单的关闭逻辑都挂在 document 的 pointerdown 上。 */
async function closeMenus(page) {
  await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
  await page.waitForTimeout(200)
}

test('编辑态图片：悬停出工具条、点击进全屏、拖缩放手柄不误触、右键只出一个菜单', { timeout: 180_000 }, async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-editor-image-'))
  const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xinyue-editor-image-src-'))
  const filePath = path.join(sourceDir, '编辑态图片.md')
  let application

  try {
    const png = createSolidPng(240, 120)
    await fs.mkdir(path.join(sourceDir, 'images'), { recursive: true })
    await fs.writeFile(path.join(sourceDir, 'images', 'a.png'), png)
    await fs.writeFile(filePath, ['# 编辑态图片', '', '![示意图](images/a.png)', ''].join('\n'), 'utf8')

    application = await launchApplication(userDataPath)
    const { page } = application
    await application.electronApplication.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
    }, filePath)
    await page.evaluate(() => window.notesDesktop.importSingleMarkdown(null))
    await page.reload()
    await page.waitForFunction(() => Boolean(window.notesDesktop))
    await openNoteByTitle(page, '编辑态图片')

    const image = page.locator('.milkdown-editor-root .milkdown-image-block img').first()
    await image.waitFor()
    const box = await image.boundingBox()
    assert.ok(box, '编辑态应能拿到图片的位置')
    const cx = Math.round(box.x + box.width / 2)
    const cy = Math.round(box.y + box.height / 2)

    // ---- 悬停出工具条 ----
    await page.mouse.move(cx, cy)
    await page.waitForSelector('.preview-image-bar')
    assert.equal(await page.locator('.preview-image-bar').count(), 1, '编辑态悬停图片应出工具条')

    // ---- 点击进全屏 ----
    await page.mouse.click(cx, cy)
    await page.waitForSelector('.preview-image-viewer')
    assert.equal(await page.locator('.preview-image-viewer').count(), 1, '编辑态点击图片应进全屏')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    assert.equal(await page.locator('.preview-image-viewer').count(), 0, 'Esc 应关闭全屏')
    await closeMenus(page)

    // ---- 拖拽缩放手柄不应误触全屏 ----
    // Crepe 的缩放手柄在自己的 pointerdown 里 stopPropagation，若监听挂在冒泡阶段，
    // press 坐标就永远是旧的、位移判定失效，拖完松手会顺手弹出全屏。
    const handle = page.locator('.milkdown-editor-root .milkdown-image-block .image-resize-handle').first()
    const handleBox = await handle.boundingBox()
    assert.ok(handleBox, '应能拿到缩放手柄的位置')
    const hx = Math.round(handleBox.x + handleBox.width / 2)
    const hy = Math.round(handleBox.y + handleBox.height / 2)
    await page.mouse.move(hx, hy)
    await page.mouse.down()
    await page.mouse.move(hx, hy + 30, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(400)
    assert.equal(
      await page.locator('.preview-image-viewer').count(),
      0,
      '拖拽缩放手柄不应打开全屏'
    )
    await closeMenus(page)

    // ---- 右键图片只出一个菜单 ----
    // 两个 contextmenu 监听器挂在同一个元素上，`stopPropagation` 挡不住兄弟监听器：
    // 图片菜单有 `.image-wrapper` 兜底、正文菜单只查 `closest('img')`，口径不一致就会同时弹两个。
    await page.mouse.click(cx, cy, { button: 'right' })
    await page.waitForTimeout(400)
    const menus = await listMenus(page)
    assert.equal(menus.length, 1, `右键图片应只出一个菜单，实际：${JSON.stringify(menus)}`)
    assert.match(menus[0], /复制图片地址/, '右键图片出的应是图片菜单')
  } finally {
    if (application) await application.electronApplication.close().catch(() => {})
    await fs.rm(userDataPath, { recursive: true, force: true })
    await fs.rm(sourceDir, { recursive: true, force: true })
  }
})
