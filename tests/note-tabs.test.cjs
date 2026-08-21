const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const test = require('node:test')

const projectRoot = resolve(__dirname, '..')

async function loadNoteTabs() {
  return import('../src/utils/note-tabs.ts')
}

test('普通打开会复用已有标签或替换当前标签', async () => {
  const { activateNoteInCurrentTab } = await loadNoteTabs()

  assert.deepEqual(
    activateNoteInCurrentTab({ noteIds: ['a', 'b'], activeNoteId: 'b' }, 'c'),
    { noteIds: ['a', 'c'], activeNoteId: 'c' },
  )
  assert.deepEqual(
    activateNoteInCurrentTab({ noteIds: ['a', 'b'], activeNoteId: 'b' }, 'a'),
    { noteIds: ['a', 'b'], activeNoteId: 'a' },
  )
})

test('在新标签页打开时追加标签且不重复', async () => {
  const { activateNoteInNewTab } = await loadNoteTabs()

  assert.deepEqual(
    activateNoteInNewTab({ noteIds: ['a'], activeNoteId: 'a' }, 'b'),
    { noteIds: ['a', 'b'], activeNoteId: 'b' },
  )
  assert.deepEqual(
    activateNoteInNewTab({ noteIds: ['a', 'b'], activeNoteId: 'b' }, 'a'),
    { noteIds: ['a', 'b'], activeNoteId: 'a' },
  )
})

test('关闭当前标签后优先选择右侧相邻标签', async () => {
  const { closeNoteTab } = await loadNoteTabs()

  assert.deepEqual(
    closeNoteTab({ noteIds: ['a', 'b', 'c'], activeNoteId: 'b' }, 'b'),
    { noteIds: ['a', 'c'], activeNoteId: 'c' },
  )
  assert.deepEqual(
    closeNoteTab({ noteIds: ['a'], activeNoteId: 'a' }, 'a'),
    { noteIds: [], activeNoteId: null },
  )
})

test('清理已删除标签时保留仍然有效的当前标签', async () => {
  const { reconcileNoteTabs } = await loadNoteTabs()

  assert.deepEqual(
    reconcileNoteTabs({ noteIds: ['a', 'b'], activeNoteId: 'b' }, ['b', 'c']),
    { noteIds: ['b'], activeNoteId: 'b' },
  )
})

test('笔记列表右键菜单提供在新标签页打开入口', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')

  assert.match(appSource, /aria-label="已打开笔记"/)
  assert.match(appSource, /openContextNoteInNewTab/)
  assert.match(appSource, />在新标签页打开</)
})

test('标签支持关闭其他和关闭右侧', async () => {
  const { closeOtherNoteTabs, closeNoteTabsToRight } = await loadNoteTabs()
  const state = { noteIds: ['a', 'b', 'c', 'd'], activeNoteId: 'd' }

  assert.deepEqual(closeOtherNoteTabs(state, 'b'), { noteIds: ['b'], activeNoteId: 'b' })
  assert.deepEqual(
    closeOtherNoteTabs(state, 'b', ['a']),
    { noteIds: ['a', 'b'], activeNoteId: 'b' }
  )
  assert.deepEqual(closeNoteTabsToRight(state, 'b'), { noteIds: ['a', 'b'], activeNoteId: 'b' })
})

test('标签溢出时确保当前标签可见，其余进入下拉列表', async () => {
  const { partitionNoteTabs } = await loadNoteTabs()

  assert.deepEqual(partitionNoteTabs(['a', 'b', 'c', 'd'], 'd', 2), {
    visibleNoteIds: ['c', 'd'],
    overflowNoteIds: ['a', 'b']
  })
  assert.deepEqual(partitionNoteTabs(['a', 'b'], 'a', 3), {
    visibleNoteIds: ['a', 'b'],
    overflowNoteIds: []
  })
})

test('固定标签排在普通标签前且普通打开不会覆盖固定标签', async () => {
  const { activateNoteInCurrentTab, togglePinnedNoteTab } = await loadNoteTabs()

  const pinned = togglePinnedNoteTab({
    noteIds: ['a', 'b', 'c'],
    pinnedNoteIds: []
  }, 'b')
  assert.deepEqual(pinned, {
    noteIds: ['b', 'a', 'c'],
    pinnedNoteIds: ['b']
  })
  assert.deepEqual(
    activateNoteInCurrentTab(
      { noteIds: pinned.noteIds, activeNoteId: 'b' },
      'd',
      pinned.pinnedNoteIds
    ),
    { noteIds: ['b', 'a', 'c', 'd'], activeNoteId: 'd' }
  )
})

test('拖动标签只在固定或普通分组内部调整顺序', async () => {
  const { reorderNoteTabs } = await loadNoteTabs()
  const state = { noteIds: ['p', 'a', 'b', 'c'], pinnedNoteIds: ['p'] }

  assert.deepEqual(reorderNoteTabs(state, 'c', 'a'), {
    noteIds: ['p', 'c', 'a', 'b'],
    pinnedNoteIds: ['p']
  })
  assert.deepEqual(reorderNoteTabs(state, 'p', 'a'), state)
})

test('标签会话、拖动、固定和滚动位置接入桌面持久化', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const editorSource = readFileSync(
    resolve(projectRoot, 'src/components/MarkdownVisualEditor.vue'),
    'utf8'
  )
  const preloadSource = readFileSync(resolve(projectRoot, 'electron/preload.cjs'), 'utf8')
  const ipcSource = readFileSync(resolve(projectRoot, 'electron/ipc-handlers.cjs'), 'utf8')

  assert.match(appSource, /getWorkspaceSession\(\)/)
  assert.match(appSource, /saveWorkspaceSession\(/)
  assert.match(appSource, /saveNoteViewState\(/)
  assert.match(appSource, /draggable="true"/)
  assert.match(appSource, />固定标签</)
  assert.match(editorSource, /scroll-position-change/)
  assert.match(preloadSource, /workspace-session:get/)
  assert.match(ipcSource, /workspace-session:save-view-state/)
})

test('全屏模态弹窗提供右上角关闭按钮', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const quickOpenSource = readFileSync(resolve(projectRoot, 'src/components/QuickOpenDialog.vue'), 'utf8')
  const generalSettingsSource = readFileSync(resolve(projectRoot, 'src/components/GeneralSettingsDialog.vue'), 'utf8')
  const closeButtonCount = [appSource, quickOpenSource, generalSettingsSource]
    .reduce((count, source) => count + (source.match(/class="dialog-close-button"/g)?.length ?? 0), 0)

  assert.equal(closeButtonCount, 11)
  assert.match(appSource, /aria-label="关闭同步设置"/)
  assert.match(appSource, /aria-label="关闭更新窗口"/)
})

test('同步设置明确展示线上默认地址', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')

  assert.match(appSource, /class="sync-default-address"/)
  assert.match(appSource, /线上默认地址：https:\/\/lovethewind\.cn/)
  assert.match(appSource, /后端与网页通用/)
})

test('Markdown导入界面支持选择文件夹或ZIP压缩包', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')

  assert.match(appSource, /<strong>导入 Markdown 文件夹或 ZIP<\/strong>/)
  assert.match(appSource, /选择文件夹或 ZIP 压缩包/)
})

test('笔记属性与标题同行且编辑器工具栏保持紧凑', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const styleSource = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')

  assert.match(appSource, /class="editor-title-row"[\s\S]*class="properties-row"/)
  assert.match(styleSource, /\.editor-title-row > \.properties-row/)
  assert.match(styleSource, /\.milkdown-top-bar[^{}]*\{[^}]*min-height: 48px/)
  assert.match(styleSource, /\.top-bar-item[^{}]*\{[^}]*height: 40px/)
})

test('只缩窄左侧与文件夹弹层滚动条并保持正文主滚动条不变', () => {
  const styleSource = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')

  assert.match(styleSource, /\.sidebar-resource-scroll,\s*\.folder-picker-scroll\s*\{[^}]*scrollbar-width:\s*auto;[^}]*scrollbar-color:\s*auto/)
  assert.match(styleSource, /:is\(\.sidebar-resource-scroll, \.folder-picker-scroll\)::-webkit-scrollbar\s*\{[^}]*width:\s*5px/)
  assert.doesNotMatch(styleSource, /\.editor-panel \.editor-body \.milkdown-editor-scroll\s*\{[^}]*scrollbar-width:/)
})
