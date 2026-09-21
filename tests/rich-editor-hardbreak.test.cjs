/**
 * 富文本编辑器「内联 `<br>` 保真」扩展的静态约束。
 *
 * 这是**回归护栏**：这些断言每一条都对应一个已踩过的坑，
 * 改动 `src/editor/xynote-hardbreak.ts` 或编辑器接线时若破坏它们，
 * `<br>` 会再次静默丢失（页面不报错，只是保存后内容变了），
 * 因此用单测把关键实现细节钉住。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const readSource = (filePath) => readFileSync(resolve(projectRoot, filePath), 'utf8')

test('硬换行扩展：内置插件只能追加，必须前置插入才能抢在内置删除逻辑之前', () => {
  const source = readSource('src/editor/xynote-hardbreak.ts')

  // $remark 会把插件 push 到 remarkPluginsCtx 尾部 → 排在内置 preserve 插件之后，
  // 那时 <br> 早被删掉，抢救无效。因此必须直接操作 remarkPluginsCtx 做前置插入。
  assert.match(source, /remarkPluginsCtx/, '应直接操作 remarkPluginsCtx 实现前置插入')
  assert.match(
    source,
    /ctx\.update\(remarkPluginsCtx,\s*\(list[^)]*\)\s*=>\s*\[entry,\s*\.\.\.list\]\)/,
    '应把本插件插到插件链最前（[entry, ...list]）'
  )
  assert.match(source, /await ctx\.wait\(InitReady\)/, '须等 InitReady 后再改插件链')
})

test('硬换行扩展：跳过块容器子级与段落唯一子级，保住空段落占位符语义', () => {
  const source = readSource('src/editor/xynote-hardbreak.ts')

  // Milkdown 把独立 `<br />` 当「空段落占位符」：解析时删除、序列化空段落时写回。
  // 若我们的规则把它也抢走，文档里会多出真实换行 —— 必须保留这两条跳过判断。
  assert.match(source, /BLOCK_CONTAINER_TYPES\s*=\s*\[[^\]]*'root'[^\]]*'blockquote'[^\]]*'listItem'[^\]]*\]/)
  assert.match(source, /isBlockContainerChild/, '应跳过块容器的直接子级')
  assert.match(source, /isSoleParagraphChild/, '应跳过 paragraph 的唯一子级')
  assert.match(source, /parent\s*\.\s*type\s*===\s*'paragraph'|node\.type === 'paragraph'/)
})

test('硬换行节点：parseDOM 优先级必须高于内置 hardbreak，否则粘贴链路会降级节点', () => {
  const source = readSource('src/editor/xynote-hardbreak.ts')

  // 粘贴链路是 parser(text) → DOMSerializer → parseSlice，节点要经 DOM 往返。
  // 内置 hardbreakSchema 有 `parseDOM: [{ tag: "br" }]`（默认 priority 50），
  // 不提高优先级就会被它抢走 → 段落里变 `\`+换行、表格里被压成空格。
  const priorityMatch = source.match(/priority:\s*(\d+)/)
  assert.ok(priorityMatch, 'parseDOM 必须声明 priority')
  assert.ok(
    Number(priorityMatch[1]) > 50,
    `parseDOM priority 必须大于内置 hardbreak 的默认 50，当前：${priorityMatch[1]}`
  )
  // 必须带上可精确识别的属性选择器，避免误伤普通 <br>
  assert.match(source, /tag:\s*'br\[data-type="xynote-hardbreak"\]'/, 'parseDOM 应使用带 data-type 的属性选择器')
  assert.match(source, /toDOM:\s*\(\)\s*=>\s*\['br',\s*\{\s*'data-type':\s*'xynote-hardbreak'\s*\}\]/)
})

test('硬换行节点：toMarkdown 回写 html `<br>`，而非 break 节点', () => {
  const source = readSource('src/editor/xynote-hardbreak.ts')

  // 写回 `break` 节点时 remark-stringify 在表格里会把换行压成空格 —— 正是要修的 bug。
  assert.match(source, /state\.addNode\('html',\s*undefined,\s*'<br>'\)/)
})

test('编辑器接入硬换行 feature，与嵌入卡片 feature 并列', () => {
  const editorSource = readSource('src/components/MarkdownVisualEditor.vue')

  // 导入里除 installHardbreakFeature 外还带了节点名/单元格名常量（供 Shift+Enter 复用）
  assert.match(editorSource, /import \{[^}]*installHardbreakFeature[^}]*\} from '\.\.\/editor\/xynote-hardbreak'/)
  assert.match(editorSource, /crepe\.addFeature\(installHardbreakFeature\)/)
})

test('表格单元格内 Shift+Enter 接管为自定义硬换行节点', () => {
  const editorSource = readSource('src/components/MarkdownVisualEditor.vue')

  // 背景：内置 hardbreakFilterPlugin 读 hardbreakFilterNodes（默认含 table）→ 单元格内 Shift+Enter 静默失效。
  // 修复：在 handleSuggestKeydown 最前面按「选中区在单元格内」判断并改用 xynoteHardbreak 节点。
  assert.match(editorSource, /function insertTableCellHardBreak/)
  assert.match(editorSource, /event\.key !== 'Enter' \|\| !event\.shiftKey/)
  assert.match(editorSource, /function isSelectionInTableCell/)
  // 必须抢在内置 keymap 之前 —— 即挂在 handleSuggestKeydown 里且先于补全判断返回
  assert.match(editorSource, /if \(insertTableCellHardBreak\(view as ProseMirrorView, event\)\) return true/)
  // 节点类型取 schema 里的自定义节点，而非内置 hardbreak
  assert.match(editorSource, /view\.state\.schema\.nodes\[HARDBREAK_NODE_NAME\]/)
  assert.match(editorSource, /replaceSelectionWith\(type\.create\(\)\)/)
})

test('右键菜单提供三种粘贴方式，且只读态置灰', () => {
  const editorSource = readSource('src/components/MarkdownVisualEditor.vue')

  // 三项菜单
  assert.match(editorSource, /menuItem\('paste',\s*'粘贴'/)
  assert.match(editorSource, /menuItem\('pastePlain',\s*'粘贴为纯文本'/)
  assert.match(editorSource, /menuItem\('pasteMarkdown',\s*'粘贴为 Markdown'/)
  // 两项新粘贴均须在不可编辑时置灰
  assert.match(editorSource, /menuItem\('pastePlain',\s*'粘贴为纯文本',\s*\{[^}]*disabled:\s*!canEdit/)
  assert.match(editorSource, /menuItem\('pasteMarkdown',\s*'粘贴为 Markdown',\s*\{[^}]*disabled:\s*!canEdit/)
  // 动作分发须包含两个新 action
  assert.match(editorSource, /action === 'pastePlain'/)
  assert.match(editorSource, /action === 'pasteMarkdown'/)
})

test('「粘贴为 Markdown」用 markdownToSlice 解析，而非纯文本插入', () => {
  const editorSource = readSource('src/components/MarkdownVisualEditor.vue')

  assert.match(editorSource, /import \{[^}]*markdownToSlice[^}]*\} from '@milkdown\/kit\/utils'/)
  assert.match(editorSource, /markdownToSlice\(text\)\(ctx\)/)
})

test('剪贴板读取经主进程 IPC（渲染层拿不到 text/html）', () => {
  const preloadSource = readSource('electron/preload.cjs')
  const handlerSource = readSource('electron/ipc-handlers.cjs')
  const mainSource = readSource('electron/main.cjs')

  assert.match(preloadSource, /readClipboard:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("clipboard:read"\)/)
  assert.match(handlerSource, /ipcMain\.handle\("clipboard:read"/)
  assert.match(mainSource, /readClipboard:\s*\(\)\s*=>/)
  // 主进程须真的用到 clipboard 模块的 HTML 读取
  assert.match(mainSource, /clipboard\.readHTML\(\)/)
})
