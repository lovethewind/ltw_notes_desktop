/**
 * 预览图片交互的守卫。
 *
 * 分两层：
 *  1. **真实行为**：缩放数学直接用真数据跑（`zoomPreviewImageAtPoint` 的不变量、
 *     「适应窗口」对小图不放大）—— 这类算错只会表现为「放大后想看的角落跑出屏幕」，
 *     字符串级断言完全看不出来。
 *  2. **接线守卫**：两处预览（笔记 / 本地文件）必须共用同一份实现，且都走主进程的图片读取链路。
 *     上一轮「图片断链」就是因为三个渲染入口各写一份清洗，口径一散就漏 —— 这里把口径钉住。
 */

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const projectRoot = resolve(__dirname, '..')

let tools
test.before(async () => {
  tools = await import(pathToFileURL(resolve(projectRoot, 'src/utils/preview-image-tools.ts')).href)
})

/** 读源码做接线断言；`tests/` 下的单测读 `src/` 是既有惯例。 */
function readSource(relativePath) {
  return readFileSync(resolve(projectRoot, relativePath), 'utf8')
}

test('缩放值被钳在合法区间内', () => {
  assert.equal(tools.clampPreviewImageScale(1), 1)
  assert.equal(tools.clampPreviewImageScale(0.001), tools.PREVIEW_IMAGE_MIN_SCALE)
  assert.equal(tools.clampPreviewImageScale(999), tools.PREVIEW_IMAGE_MAX_SCALE)
  // NaN 传进去会把整层 transform 弄没（图片直接消失），必须兜住。
  assert.equal(tools.clampPreviewImageScale(Number.NaN), 1)
})

test('「适应窗口」只缩小不放大', () => {
  // 大图：按较小的一边缩到能整张看见。
  assert.equal(tools.computePreviewImageFitScale(1600, 1200, 800, 600), 0.5)
  assert.equal(tools.computePreviewImageFitScale(4000, 100, 800, 600), 0.2)
  // 小图：不放大 —— 否则 16px 的图标会被拉满全屏、糊成一片。
  assert.equal(tools.computePreviewImageFitScale(16, 16, 800, 600), 1)
  // 尺寸取不到（图片还没加载完）时按 1 处理，别算出 Infinity。
  assert.equal(tools.computePreviewImageFitScale(0, 0, 800, 600), 1)
})

test('以光标为锚缩放：锚点下的内容不跑', () => {
  const before = { scale: 1, offsetX: 0, offsetY: 0, pointX: 100, pointY: -50 }
  const next = tools.zoomPreviewImageAtPoint({ ...before, nextScale: 2 })
  assert.equal(next.scale, 2)
  // 不变量：锚点在图片上的原始坐标 q = (P - offset) / scale 缩放前后必须相同。
  const qBefore = { x: before.pointX / before.scale, y: before.pointY / before.scale }
  const qAfter = { x: (before.pointX - next.offsetX) / next.scale, y: (before.pointY - next.offsetY) / next.scale }
  assert.equal(qAfter.x, qBefore.x)
  assert.equal(qAfter.y, qBefore.y)
})

test('以光标为锚缩放：光标在正中心时位移保持为 0', () => {
  const next = tools.zoomPreviewImageAtPoint({
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    nextScale: 1.5,
    pointX: 0,
    pointY: 0
  })
  assert.equal(next.offsetX, 0)
  assert.equal(next.offsetY, 0)
})

test('以光标为锚缩放：目标缩放超限时按上限算，位移与最终缩放一致', () => {
  const next = tools.zoomPreviewImageAtPoint({
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    nextScale: 1000,
    pointX: 60,
    pointY: 0
  })
  assert.equal(next.scale, tools.PREVIEW_IMAGE_MAX_SCALE)
  // 位移用的比例必须也是钳制后的 —— 否则拖拽手感与实际缩放对不上。
  assert.equal(next.offsetX, 60 - 60 * tools.PREVIEW_IMAGE_MAX_SCALE)
})

test('只有网络图片算「可在浏览器打开」', () => {
  assert.equal(tools.isRemoteImageSource('https://example.com/a.png'), true)
  assert.equal(tools.isRemoteImageSource('http://example.com/a.png'), true)
  assert.equal(tools.isRemoteImageSource('xinyue-asset://local/abc'), false)
  assert.equal(tools.isRemoteImageSource('file:///Users/x/a.png'), false)
  assert.equal(tools.isRemoteImageSource('/Users/x/a.png'), false)
  assert.equal(tools.isRemoteImageSource(''), false)
})

test('三处入口共用同一份图片交互实现', () => {
  const visualEditor = readSource('src/components/MarkdownVisualEditor.vue')
  const sourceEditor = readSource('src/components/MarkdownSourceEditor.vue')

  // 笔记编辑器一个实例管两个态：预览层用预览滚动容器，编辑态用编辑器滚动容器。
  assert.match(
    visualEditor,
    /usePreviewImageTools\(imageToolsContainer/,
    '笔记编辑器应接入共用的图片交互（预览态与编辑态共用一个实例）'
  )
  assert.match(sourceEditor, /usePreviewImageTools\(previewScroller\)/, '本地文件预览应接入共用的图片交互')

  for (const [name, source] of [['笔记编辑器', visualEditor], ['本地文件预览', sourceEditor]]) {
    assert.match(source, /<PreviewImageBar/, `${name}应渲染悬停工具条`)
    assert.match(source, /<PreviewImageViewer/, `${name}应渲染全屏查看器`)
    assert.match(source, /:anchor="imageBarAnchor"/, `${name}的工具条应跟随悬停图片的坐标`)
    assert.match(source, /@update:index="setImageViewerIndex"/, `${name}的查看器应支持左右切换`)
  }
})

test('图片交互走容器事件委托（正文是死 HTML / nodeView，图片挂不上事件）', () => {
  const composable = readSource('src/composables/usePreviewImageTools.ts')
  assert.match(composable, /element\.addEventListener\('mouseover', handlePointerOver\)/)
  assert.match(composable, /element\.addEventListener\('mouseleave', handlePointerLeave\)/)
  // ⚠️ 必须走**捕获**阶段：Crepe 的缩放手柄在自己的 pointerdown 里 stopPropagation，
  // 冒泡阶段收不到，press 坐标就永远是旧的、位移判定失效。
  assert.match(composable, /element\.addEventListener\('mousedown', handlePointerDown, true\)/)
  assert.match(composable, /element\.addEventListener\('click', handleClick, true\)/)
  // 图片判定收敛到 utils 的共用函数（编辑态的 .image-wrapper 兜底也在那里）。
  assert.match(composable, /resolvePreviewImageElement\(event\.target\)/)
  // 复制与另存为必须走主进程：file:// 与私有协议在渲染层都拿不到可写的 Blob。
  assert.match(composable, /window\.notesDesktop\.copyPreviewImage\(src\)/)
  assert.match(composable, /window\.notesDesktop\.savePreviewImageAs\(src\)/)
})

test('鼠标移出图片后工具条不会立刻消失（否则来不及点到）', () => {
  const composable = readSource('src/composables/usePreviewImageTools.ts')
  assert.match(composable, /const BAR_HIDE_DELAY = \d+/)
  assert.match(composable, /hideTimer = window\.setTimeout\(dismissBar, BAR_HIDE_DELAY\)/)
})

test('悬停工具条：四个操作齐备，非网络图的「浏览器打开」是禁用态', () => {
  const bar = readSource('src/components/PreviewImageBar.vue')
  // 「在浏览器打开」的 title 是三元表达式（可用/禁用两种文案），所以按文案而不是 title 属性断言。
  for (const label of ['全屏查看', '复制图片', '另存为', '在浏览器打开']) {
    assert.ok(bar.includes(label), `工具条应有「${label}」`)
  }
  assert.match(bar, /:disabled="!canOpenExternal"/, '非网络图片的「在浏览器打开」应禁用而不是隐藏（保持工具条宽度稳定）')
  assert.match(bar, /@mouseenter="emit\('keep'\)"/, '指针移到工具条上应取消收起')
  // 工具条贴在图片右上角，且不许跑出视口左边。
  assert.match(bar, /props\.anchor\.right - width - 8/)
  assert.match(bar, /Math\.max\(8,/)
  // 必须传送到 body：挂在预览容器里会被 overflow 裁掉，也会随滚动错位。
  assert.match(bar, /<Teleport to="body">/)
})

test('全屏查看器：缩放 / 平移 / 快捷键 / 层级齐备', () => {
  const viewer = readSource('src/components/PreviewImageViewer.vue')
  assert.match(viewer, /@wheel\.prevent="handleWheel"/, '滚轮要能缩放，并且要拦住背景滚动')
  assert.match(viewer, /zoomPreviewImageAtPoint\(/, '滚轮缩放必须以光标为锚点')
  assert.match(viewer, /@pointermove="handlePointerMove"/, '拖拽平移')
  assert.match(viewer, /transform-origin: center center/, '位移与 transform-origin 必须同一套坐标系')
  assert.match(viewer, /max-width: none/, '不放开 max-width 的话缩放没有意义')
  assert.match(viewer, /event\.key === 'Escape'/)
  assert.match(viewer, /event\.key === 'ArrowLeft'/)
  assert.match(viewer, /event\.key === 'ArrowRight'/)
  assert.match(viewer, /适应窗口/)
  assert.match(viewer, /1:1/)
  // 层级必须高于预览层（z-index: 40），否则全屏层会被压在下面点不到。
  assert.match(viewer, /z-index: 2200/)
  assert.match(readSource('src/components/PreviewImageBar.vue'), /z-index: 2100/)
})

test('预览里的图片给出可点击提示，且两处都有', () => {
  assert.match(
    readSource('src/components/MarkdownVisualEditor.vue'),
    /\.markdown-note-preview__doc img \{ cursor: zoom-in; \}/
  )
  assert.match(
    readSource('src/components/MarkdownSourceEditor.vue'),
    /\.markdown-source-editor__preview img \{ cursor: zoom-in; \}/
  )
})

test('主进程：四种来源都能读成字节，复制与另存为都在主进程做', () => {
  const main = readSource('electron/main.cjs')
  assert.match(main, /function resolveImageSourcePath\(/, '应有地址 → 磁盘路径的解析')
  assert.match(main, /\$\{LOCAL_ASSET_PROTOCOL\}:\/\//, '私有资产协议应被识别')
  assert.match(main, /PORTABLE_ASSET_HOSTNAME/, '导出后可移植地址（xinyue-asset.local）也要能读')
  assert.match(main, /source\.startsWith\("file:"\) \? fileURLToPath\(source\) : source/, 'file:// 与绝对路径')
  assert.match(main, /await net\.fetch\(source\)/, '网络图片走主进程下载')
  assert.match(main, /nativeImage\.createFromBuffer\(buffer\)/)
  assert.match(main, /clipboard\.writeImage\(image\)/)
  assert.match(main, /dialog\.showSaveDialog\(mainWindow, \{ title: "保存图片"/)
  // 失败要回成 { ok: false, message } 而不是抛异常：IPC 的异常消息会被包一层前缀，提示很难看。
  assert.match(main, /return \{ ok: false, message: error\?\.message \|\| "复制图片失败" \}/)
})

test('主进程 IPC 与 preload 接线', () => {
  const handlers = readSource('electron/ipc-handlers.cjs')
  assert.match(handlers, /ipcMain\.handle\("image:copy"/)
  assert.match(handlers, /ipcMain\.handle\("image:save-as"/)

  const preload = readSource('electron/preload.cjs')
  assert.match(preload, /copyPreviewImage: \(src\) => ipcRenderer\.invoke\("image:copy", src\)/)
  assert.match(preload, /savePreviewImageAs: \(src\) => ipcRenderer\.invoke\("image:save-as", src\)/)

  const types = readSource('src/types.ts')
  assert.match(types, /copyPreviewImage\(src: string\): Promise<\{ ok: boolean, message: string \}>/)
  assert.match(types, /savePreviewImageAs\(src: string\): Promise</)
})

test('图片判定收敛成一个共用函数，并为编辑态的 .image-wrapper 兜底', () => {
  const tools = readSource('src/utils/preview-image-tools.ts')
  assert.match(tools, /export function resolvePreviewImageElement\(/, '图片判定应收敛成一个共用函数')
  // Crepe 的 wrapper 盖在 img 之上（拦截指针事件），只查 closest('img') 必然漏判。
  assert.match(tools, /target\.closest\('\.image-wrapper'\)/)
  assert.match(tools, /wrapper\.querySelector\('img'\)/)
  // 图注按钮 / 缩放手柄有自己的职责，不能被当成「点了图片」。
  assert.match(tools, /target\.closest\('\.operation'\)/, '图注按钮不算点图片')
  assert.match(tools, /target\.closest\('\.image-resize-handle'\)/, '缩放手柄不算点图片')
})

test('右键菜单的两个 handler 共用同一图片判定（口径一散就一次弹两个菜单）', () => {
  const visualEditor = readSource('src/components/MarkdownVisualEditor.vue')
  // 两个 contextmenu 监听器挂在**同一个元素**上，stopPropagation 挡不住兄弟监听器。
  assert.match(
    visualEditor,
    /function resolveContextMenuImage\(target: Element \| null\): HTMLImageElement \| null \{\s*return resolvePreviewImageElement\(target\)/,
    'resolveContextMenuImage 必须转调共用的 resolvePreviewImageElement'
  )
  const uses = visualEditor.match(/resolveContextMenuImage\(target\)/g) || []
  assert.ok(
    uses.length >= 2,
    `图片菜单与正文菜单都应调用 resolveContextMenuImage，实际出现 ${uses.length} 次`
  )
})

test('编辑态拖拽缩放手柄不误触全屏', () => {
  const composable = readSource('src/composables/usePreviewImageTools.ts')
  assert.match(composable, /const DRAG_SLOP = \d+/)
  assert.match(composable, /const moved = pressed \? Math\.hypot\(/)
  assert.match(composable, /if \(moved > DRAG_SLOP\) return/)
})

test('编辑态的图片交互挂在编辑器容器上，工具条改左对齐避让 Crepe 图注按钮', () => {
  const visualEditor = readSource('src/components/MarkdownVisualEditor.vue')
  // 预览态用预览滚动容器、编辑态用编辑器滚动容器 —— 同一套交互跟着可见的那层走。
  assert.match(visualEditor, /previewMode\.value \? previewScrollerRef\.value : editorScrollRef\.value/)
  assert.match(visualEditor, /align: \(\) => \(previewMode\.value \? 'right' : 'left'\)/)
  assert.match(visualEditor, /:align="imageBarAlign"/)
  // 编辑态图片也要有「可点击」的光标提示。
  assert.match(
    visualEditor,
    /\.milkdown-editor-root \.milkdown-image-block \.image-wrapper img \{ cursor: zoom-in; \}/
  )
})

test('工具条支持左右两侧对齐', () => {
  const bar = readSource('src/components/PreviewImageBar.vue')
  assert.match(bar, /align\?: 'left' \| 'right'/)
  assert.match(bar, /props\.align === 'left'/)
  assert.match(bar, /props\.anchor\.left \+ 8/)
})

test('全屏查看器让开左上角浮着的窗口交通灯', () => {
  const viewer = readSource('src/components/PreviewImageViewer.vue')
  // 覆盖层是 position: fixed; inset: 0，左上角正对 macOS 交通灯，header 必须让出安全区，
  // 否则「3 / 4」计数会被压在红黄绿按钮底下（真机截图确认）。
  assert.match(
    viewer,
    /padding: 12px 16px 12px var\(--titlebar-safe-left\)/,
    '全屏查看器 header 应复用标题栏安全区，不能写裸的 16px 内边距'
  )

  const style = readSource('src/style.css')
  assert.match(style, /--titlebar-safe-left: \d+px/, '安全区宽度应有唯一真源（CSS 变量）')
  // .titlebar 与浮层必须引用同一个变量：两处各写一个魔法数字，早晚走散。
  assert.match(style, /padding: 0 20px 0 var\(--titlebar-safe-left\)/)
  assert.doesNotMatch(style, /padding: 0 20px 0 86px/, '标题栏不应再保留硬编码的 86px')
})
