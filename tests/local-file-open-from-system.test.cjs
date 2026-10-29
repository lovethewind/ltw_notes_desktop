/**
 * 「把 .md 拖到应用图标上打不开」的接线守卫。
 *
 * 这条链路是三段拼起来的，任何一段没接上表现都一样（拖上去毫无反应）：
 * 1. 打包声明 —— Info.plist 里没有 CFBundleDocumentTypes，macOS 连请求都不派发；
 * 2. 主进程 —— 没有 open-file 监听，系统派发了也没人接；
 * 3. 渲染层 —— 收到路径后得走「按路径打开外部文件」那条既有通道。
 *
 * 这里逐段钉住，避免以后重构时又断一段而没人发现。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const projectRoot = path.resolve(__dirname, '..')

function readSource(...segments) {
  return fs.readFileSync(path.join(projectRoot, ...segments), 'utf8')
}

/** 统计某个字面量在源码里出现的次数，用来钉「只定义一处」。 */
function countOccurrences(source, needle) {
  return source.split(needle).length - 1
}

test('打包配置声明了能打开 Markdown 文档', () => {
  const pkg = JSON.parse(readSource('package.json'))
  const associations = Array.isArray(pkg.build?.fileAssociations) ? pkg.build.fileAssociations : []
  const markdown = associations.find((item) => (
    (item.ext || []).map((ext) => String(ext).toLowerCase()).includes('md')
  ))
  assert.ok(markdown, '缺少 build.fileAssociations，打包后 Info.plist 不会有 CFBundleDocumentTypes')
  assert.equal(markdown.role, 'Editor')
  for (const ext of ['markdown', 'mdown']) {
    assert.ok(markdown.ext.includes(ext), `文件关联缺少 ${ext} 扩展名`)
  }
})

test('主进程在 ready 之前就注册了 open-file 并拦掉默认行为', () => {
  const source = readSource('electron', 'main.cjs')
  const handlerIndex = source.indexOf('app.on("open-file"')
  assert.ok(handlerIndex > -1, '没有 open-file 监听：系统派发打开请求后没人接')

  const readyIndex = source.indexOf('app.whenReady()')
  assert.ok(readyIndex > -1, '找不到 app.whenReady()')
  // 冷启动时 open-file 可能早于 ready，注册晚了就直接丢事件。
  assert.ok(handlerIndex < readyIndex, 'open-file 必须在 app.whenReady() 之前注册')

  const handlerBody = source.slice(handlerIndex, handlerIndex + 400)
  assert.match(handlerBody, /event\.preventDefault\(\)/)
})

test('系统投递的文件路径走独立通道交给渲染层', () => {
  const source = readSource('electron', 'main.cjs')
  assert.match(source, /local-file:open-paths/)
  assert.match(source, /function flushPendingOpenFiles\(\)[\s\S]{0,600}?webContents\.send\("local-file:open-paths"/)
  // 窗口还在加载时不能直接 send：路径先攒着，等加载完成补投。
  assert.match(source, /function flushPendingOpenFiles\(\)[\s\S]{0,400}?isLoading\(\)/)
  assert.match(source, /once\("did-finish-load"[\s\S]{0,200}?flushPendingOpenFiles\(\)/)
})

test('第二个实例把文件参数交给已运行的窗口', () => {
  const source = readSource('electron', 'main.cjs')
  assert.match(source, /app\.on\("second-instance"[\s\S]{0,600}?collectOpenablePathsFromArgv\(argv\)/)
  assert.match(source, /requestSingleInstanceLock\(\)/)
  // E2E 用的是「一个用例一个 userData」，加锁会让并行用例互相顶掉。
  assert.match(source, /const hasSingleInstanceLock = e2eRuntime \? true : app\.requestSingleInstanceLock\(\)/)
})

test('preload 暴露订阅并能取消', () => {
  const source = readSource('electron', 'preload.cjs')
  assert.match(source, /onOpenLocalFilePaths:[\s\S]{0,400}?ipcRenderer\.on\("local-file:open-paths"/)
  assert.match(source, /onOpenLocalFilePaths:[\s\S]{0,700}?removeListener\("local-file:open-paths"/)

  const types = readSource('src', 'types.ts')
  assert.match(types, /onOpenLocalFilePaths\(callback: \(filePaths: string\[\]\) => void\): \(\) => void/)
})

test('渲染层按队列串行打开系统投递的文件', () => {
  const source = readSource('src', 'App.vue')
  // 串行是硬要求：并发读盘会让标签顺序跟着 IO 完成时间乱跳。
  assert.match(source, /function openLocalFilesFromSystem\(filePaths: string\[\]\): void \{[\s\S]{0,600}?openLocalFileChain\s*=\s*openLocalFileChain\s*\n?\s*\.then/)
  assert.match(source, /async function openSingleLocalFileFromSystem\(filePath: string\): Promise<void> \{[\s\S]{0,500}?await openMarkdownFileByPath\(filePath\)/)
  // 单个文件失败不能断链。
  assert.match(source, /\.catch\(\(\) => \{\}\)/)

  // 订阅要在挂载时装上、卸载时摘掉，否则热更新会叠出多份监听。
  assert.match(source, /disposeOpenLocalFilePaths = window\.notesDesktop\.onOpenLocalFilePaths/)
  assert.match(source, /disposeOpenLocalFilePaths\?\.\(\)/)
})

test('可打开后缀只在 App.vue 定义一处，拖放与系统打开共用', () => {
  const source = readSource('src', 'App.vue')
  const pattern = '/\\.(md|markdown|mdown|txt|text)$/i'
  assert.equal(countOccurrences(source, pattern), 1, '白名单被复制成了多份，早晚会改漏一处')
  assert.match(source, /const OPENABLE_FILE_PATTERN = \/\\\.\(md\|markdown\|mdown\|txt\|text\)\$\/i/)
  // 两个入口都要过白名单，别让系统请求绕过检查。
  assert.match(source, /async function openSingleLocalFileFromSystem[\s\S]{0,400}?OPENABLE_FILE_PATTERN\.test\(filePath\)/)
  assert.match(source, /function handleWindowFileDrop[\s\S]{0,900}?OPENABLE_FILE_PATTERN\.test\(filePath\)/)
})
