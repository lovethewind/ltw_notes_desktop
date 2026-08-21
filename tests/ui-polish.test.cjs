const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const test = require('node:test')

const projectRoot = resolve(__dirname, '..')

test('顶部只保留一个同步主入口并提供独立设置按钮', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')

  assert.match(appSource, /class="sync-control"/)
  assert.match(appSource, /class="sync-state"[\s\S]*@click\.stop="pullLatestData"/)
  assert.match(appSource, /:data-tooltip="syncActionLabel"/)
  assert.match(appSource, /class="sync-settings-button"[\s\S]*@click\.stop="openSyncSettings"/)
  assert.doesNotMatch(appSource, /class="pull-latest-button"/)
  assert.doesNotMatch(appSource, /class="local-state"/)
})

test('同步中心展示真实状态、同步范围和可恢复操作', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const styleSource = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')

  assert.match(appSource, /<h2>同步中心<\/h2>/)
  assert.match(appSource, /const syncCenterStateTitle = computed/)
  assert.match(appSource, /const syncCenterActionLabel = computed/)
  assert.match(appSource, /class="sync-center-overview"/)
  assert.match(appSource, /class="sync-center-metrics"[\s\S]*本地待上传[\s\S]*云端变更[\s\S]*同步时检查[\s\S]*自动同步/)
  assert.match(appSource, /class="sync-scope-grid"[\s\S]*笔记与回收站[\s\S]*文件夹与标签[\s\S]*图片与附件[\s\S]*历史与冲突副本/)
  assert.match(appSource, /syncStatus\.state === 'error'[^\n]*'重试同步'/)
  assert.match(appSource, /@click="pullLatestData"/)
  assert.match(styleSource, /\.sync-center-overview\s*\{/)
  assert.match(styleSource, /\.sync-center-metrics\s*\{/)
  assert.match(styleSource, /\.sync-scope-grid\s*\{/)
  assert.match(styleSource, /\.sync-dialog-actions\.is-inline\s*\{[^}]*display:\s*flex;[^}]*gap:\s*10px;/)
})

test('同步完成后展示本次统计、变更详情和冲突状态', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const mainSource = readFileSync(resolve(projectRoot, 'electron/main.cjs'), 'utf8')
  const styleSource = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')

  assert.match(mainSource, /createSyncResultSummary/)
  assert.match(mainSource, /uploadedAssetCount = await uploadPendingImageAssets/)
  assert.match(mainSource, /const lastResult = createSyncResultSummary/)
  assert.match(appSource, /class="sync-result-summary"/)
  assert.match(appSource, /class="sync-result-metrics"[\s\S]*上传[\s\S]*下载[\s\S]*删除[\s\S]*附件/)
  assert.match(appSource, /class="sync-result-change-list"/)
  assert.match(appSource, /0 个冲突，无需处理/)
  assert.match(styleSource, /\.sync-result-summary\s*\{/)
  assert.match(styleSource, /\.sync-result-change-list\s*\{/)
})

test('同步中心展示重启后可恢复的最近同步历史', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const mainSource = readFileSync(resolve(projectRoot, 'electron/main.cjs'), 'utf8')
  const typeSource = readFileSync(resolve(projectRoot, 'src/types.ts'), 'utf8')
  const styleSource = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')

  assert.match(mainSource, /loadSyncHistory/)
  assert.match(mainSource, /appendSyncHistory/)
  assert.match(typeSource, /history\?:\s*SyncResultSummary\[\]/)
  assert.match(appSource, /class="sync-history"/)
  assert.match(appSource, /最近同步记录/)
  assert.match(styleSource, /\.sync-history-list\s*\{/)
})

test('同步冲突提供版本对比和三种明确处理方式', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const ipcSource = readFileSync(resolve(projectRoot, 'electron/ipc-handlers.cjs'), 'utf8')
  const preloadSource = readFileSync(resolve(projectRoot, 'electron/preload.cjs'), 'utf8')
  const styleSource = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')

  assert.match(ipcSource, /note-conflict:resolve/)
  assert.match(preloadSource, /resolveNoteConflict/)
  assert.match(appSource, /class="conflict-center-dialog"/)
  assert.match(appSource, /本地冲突版本[\s\S]*当前云端版本/)
  assert.match(appSource, /保留本地[\s\S]*采用云端[\s\S]*两份都保留/)
  assert.match(styleSource, /\.conflict-compare-grid\s*\{/)
})

test('附件管理中心展示空间状态并提供定位、打开、重试和孤立清理操作', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const ipcSource = readFileSync(resolve(projectRoot, 'electron/ipc-handlers.cjs'), 'utf8')
  const attachmentSource = readFileSync(resolve(projectRoot, 'src/composables/useAttachmentManager.ts'), 'utf8')
  const preloadSource = readFileSync(resolve(projectRoot, 'electron/preload.cjs'), 'utf8')
  const styleSource = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')

  assert.match(ipcSource, /asset-management:list/)
  assert.match(ipcSource, /asset-management:reveal/)
  assert.match(ipcSource, /asset-management:delete-orphan/)
  assert.match(ipcSource, /asset-management:delete-all-orphans/)
  assert.match(ipcSource, /asset-management:repair-integrity/)
  assert.match(preloadSource, /listAttachmentInventory/)
  assert.match(preloadSource, /revealAttachment/)
  assert.match(preloadSource, /deleteOrphanAttachment/)
  assert.match(preloadSource, /deleteAllOrphanAttachments/)
  assert.match(preloadSource, /repairAttachmentIntegrity/)
  assert.match(appSource, /class="attachment-manager-dialog"/)
  assert.match(appSource, /class="dialog-backdrop confirmation-backdrop"/)
  assert.match(appSource, /本地占用[\s\S]*待上传[\s\S]*文件缺失[\s\S]*孤立附件/)
  assert.match(appSource, /定位笔记[\s\S]*打开文件[\s\S]*所在目录[\s\S]*重试上传[\s\S]*清理附件/)
  assert.match(attachmentSource, /cleanAllOrphanAttachments/)
  assert.match(appSource, /一键清理/)
  assert.match(attachmentSource, /repairAttachmentIntegrity/)
  assert.match(appSource, /检查并修复/)
  assert.match(styleSource, /\.attachment-manager-dialog\s*\{/)
  assert.match(styleSource, /\.attachment-manager-list\s*\{/)
  assert.match(styleSource, /\.confirmation-backdrop\s*\{[^}]*z-index:\s*260;/)
  assert.match(styleSource, /\.attachment-reference-picker\s*\{[^}]*grid-column:\s*2;[^}]*position:\s*static;/)
  assert.match(styleSource, /\.attachment-reference-picker\s*>\s*div\s*\{[^}]*position:\s*static;/)
})

test('单附件清理确认框可容纳超长且无分隔的文件名', () => {
  const attachmentSource = readFileSync(resolve(projectRoot, 'src/composables/useAttachmentManager.ts'), 'utf8')
  const styleSource = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')

  assert.match(attachmentSource, /requestConfirmation\(\s*'清理这个附件？',\s*`“\$\{current\.fileName\}”未被当前笔记或历史版本引用/)
  assert.match(styleSource, /\.confirmation-dialog\s*\{[^}]*box-sizing:\s*border-box;[^}]*max-height:\s*calc\(100vh - 24px\);[^}]*overflow-y:\s*auto;/)
  assert.match(styleSource, /\.confirmation-dialog h2,\s*\.confirmation-dialog p\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*word-break:\s*break-word;/)
})

test('附件管理区分笔记附件与外链缓存且保留任意站点下载', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const mainSource = readFileSync(resolve(projectRoot, 'electron/main.cjs'), 'utf8')
  const styleSource = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')
  const typeSource = readFileSync(resolve(projectRoot, 'src/types.ts'), 'utf8')

  assert.match(mainSource, /classifyAttachmentSource/)
  assert.match(mainSource, /managedCount:[^\n]*sourceKind === "managed"/)
  assert.match(mainSource, /externalCacheCount:[^\n]*sourceKind === "external-cache"/)
  assert.match(mainSource, /async function cacheRemoteImages[\s\S]*net\.fetch\(remoteUrl/)
  assert.match(mainSource, /async function cacheRemoteAttachments[\s\S]*net\.fetch\(reference\.url/)
  assert.match(typeSource, /sourceKind:\s*'managed'\s*\|\s*'external-cache'/)
  assert.match(typeSource, /externalCacheCount:\s*number/)
  assert.match(appSource, /attachmentSourceFilter/)
  assert.match(appSource, /全部来源[\s\S]*笔记附件[\s\S]*外链缓存/)
  assert.match(appSource, /asset\.sourceHost/)
  assert.match(styleSource, /\.attachment-source-badge\.external-cache\s*\{/)
})

test('附件卡片元信息统一为同一行的轻量标签', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const styleSource = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')

  assert.doesNotMatch(appSource, /<small>\{\{ formatAttachmentSize\(asset\.localExists \? asset\.localBytes : asset\.byteSize\) \}\}/)
  assert.match(appSource, /class="attachment-detail-badge"[^>]*>\{\{ formatAttachmentSize[\s\S]*asset\.mimeType/)
  assert.match(appSource, /class="attachment-reference-badge"[^>]*>\{\{ asset\.noteReferences\.length \}\} 篇笔记/)
  assert.match(
    styleSource,
    /\.attachment-source-badge,\s*\.attachment-state-badge,\s*\.attachment-detail-badge,\s*\.attachment-reference-badge,\s*\.attachment-orphan-badge\s*\{[^}]*border-radius:\s*999px;/,
  )
})

test('附件引用字号紧凑且操作按钮位于卡片右侧', () => {
  const styleSource = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')

  assert.match(styleSource, /\.attachment-reference-picker > div button\s*\{[^}]*font-size:\s*10px;/)
  assert.match(
    styleSource,
    /\.attachment-item-actions\s*\{[^}]*grid-column:\s*3;[^}]*grid-row:\s*1\s*\/\s*span\s*2;[^}]*justify-content:\s*flex-end;/,
  )
  assert.match(
    styleSource,
    /@media \(max-width:\s*760px\)[\s\S]*\.attachment-item-actions\s*\{[^}]*grid-row:\s*auto;[^}]*justify-content:\s*flex-start;/,
  )
})

test('笔记列表支持当前结果多选和批量管理', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const folderTreeSource = readFileSync(resolve(projectRoot, 'src/components/FolderTreeItem.vue'), 'utf8')
  const folderPickerSource = readFileSync(resolve(projectRoot, 'src/components/FolderPickerPopover.vue'), 'utf8')
  const ipcSource = readFileSync(resolve(projectRoot, 'electron/ipc-handlers.cjs'), 'utf8')
  const preloadSource = readFileSync(resolve(projectRoot, 'electron/preload.cjs'), 'utf8')
  const typeSource = readFileSync(resolve(projectRoot, 'src/types.ts'), 'utf8')
  const styleSource = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')

  assert.match(ipcSource, /note:bulk-update/)
  assert.match(ipcSource, /data:export-selected-markdown/)
  assert.match(preloadSource, /bulkUpdateNotes/)
  assert.match(preloadSource, /exportSelectedMarkdown/)
  assert.match(typeSource, /interface BulkNotePatch/)
  assert.match(appSource, /class="note-batch-toolbar"/)
  assert.match(appSource, /批量管理[\s\S]*全选[\s\S]*移动[\s\S]*标签[\s\S]*置顶[\s\S]*导出[\s\S]*回收站/)
  assert.match(appSource, /selectedNoteIds/)
  assert.match(appSource, /const showFilteredResults = computed\(\(\) => activeFilter\.kind === 'pinned'\)/)
  assert.match(appSource, /:batch-mode="noteBatchMode"/)
  assert.match(appSource, /@toggle-note-selection="toggleNoteBatchSelection"/)
  assert.match(appSource, /contextMenu\.note && noteBatchMode && selectedNoteIds\.has\(contextMenu\.note\.id\)/)
  assert.match(appSource, /enterNoteBatchModeFromContext/)
  assert.match(appSource, /tabler:square-check[\s\S]*<span>选择<\/span>/)
  assert.match(appSource, /class="property-popover note-batch-picker"/)
  assert.match(folderPickerSource, /class="folder-picker-search"/)
  assert.match(appSource, /<FolderPickerPopover[\s\S]*:folders="folderOptions"[\s\S]*@select="chooseNoteBatchTarget"/)
  assert.doesNotMatch(appSource, /class="note-batch-actions"/)
  assert.match(folderTreeSource, /batchMode\?: boolean/)
  assert.match(folderTreeSource, /selectedNoteIds\?: Set<string>/)
  assert.match(folderTreeSource, /toggleNoteSelection/)
  assert.match(styleSource, /\.note-batch-toolbar\s*\{/)
  assert.match(styleSource, /\.note-batch-picker\s*\{/)
  assert.match(styleSource, /\.sidebar-note-select\s*\{/)
  assert.match(styleSource, /\.sidebar-note-select\s*\{[^}]*top:\s*9px[^}]*transform:\s*none/)
  assert.match(styleSource, /\.sidebar-note-select \+ \.sidebar-note-main\s*\{[^}]*padding-left:\s*35px/)
  assert.doesNotMatch(styleSource, /\.sidebar-note-select \+ \.sidebar-note-main > svg\s*\{[^}]*display:\s*none/)
})

test('回收站支持进入多选并批量恢复或永久删除笔记', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const folderTreeSource = readFileSync(resolve(projectRoot, 'src/components/FolderTreeItem.vue'), 'utf8')

  assert.match(appSource, /activeFilter\.kind === 'trash'[\s\S]*class="note-batch-toggle"/)
  assert.match(appSource, /recycle[\s\S]*:batch-mode="noteBatchMode"[\s\S]*@toggle-note-selection="toggleNoteBatchSelection"/)
  assert.match(appSource, /standaloneDeletedNotes[\s\S]*v-if="noteBatchMode"[\s\S]*class="sidebar-note-select"/)
  assert.match(appSource, /function enterNoteBatchModeFromContext[\s\S]*noteBatchMode\.value = true/)
  assert.doesNotMatch(appSource, /if \(!note \|\| note\.isDeleted\) return/)
  assert.match(appSource, /handleNoteBatchContextCommand\(command: 'pin' \| 'unpin' \| 'export' \| 'trash' \| 'restore' \| 'delete'\)/)
  assert.match(appSource, /command === 'restore'[\s\S]*isDeleted: false/)
  assert.match(appSource, /contextMenu\.note\.isDeleted[\s\S]*handleNoteBatchContextCommand\('restore'\)[\s\S]*恢复所选/)
  assert.match(appSource, /contextMenu\.note\.isDeleted[\s\S]*handleNoteBatchContextCommand\('delete'\)[\s\S]*永久删除/)
  assert.match(appSource, /function deleteSelectedNotesPermanently[\s\S]*permanentlyDelete: true/)
  assert.doesNotMatch(appSource, /if \(activeFilter\.kind === 'trash'\) noteBatchMode\.value = false/)
  assert.match(folderTreeSource, /props\.recycle && note\.deletedByFolderId && !props\.batchMode/)
})

test('同步结果的范围与连接设置入口使用一致的图标尺寸', () => {
  const styleSource = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')

  assert.match(
    styleSource,
    /\.sync-result-scope summary > span > svg,\s*\.sync-advanced-settings summary > span > svg\s*\{[^}]*width:\s*18px;[^}]*height:\s*18px;[^}]*font-size:\s*18px;/,
  )
})

test('同步中心的范围、历史和连接设置标题使用一致字号', () => {
  const styleSource = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')

  assert.match(
    styleSource,
    /\.sync-result-scope summary strong,\s*\.sync-history summary strong,\s*\.sync-advanced-settings summary strong\s*\{[^}]*font-size:\s*11px;[^}]*line-height:\s*1\.35;/,
  )
})

test('编辑器头部依赖自动保存状态且不再显示重复保存按钮', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')

  assert.match(appSource, /editor-save-status/)
  assert.match(appSource, /async function saveDraft\(\)/)
  assert.match(appSource, /v-if="saveState === 'error'"[\s\S]*class="editor-save-status is-error is-retry"[\s\S]*@click="saveDraft"/)
  assert.doesNotMatch(appSource, /class="editor-header-button is-save"/)
})

test('代码块和侧栏摘要提供清晰的可读性规则', () => {
  const styleSource = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')

  assert.match(styleSource, /\.milkdown-code-block\s*\{[^}]*overflow:\s*visible/)
  assert.match(styleSource, /\.milkdown-code-block \.cm-content\s*\{[^}]*color:\s*#334155/)
  assert.match(styleSource, /\.milkdown-code-block \.cm-gutters\s*\{[^}]*color:\s*#64748b/)
  assert.match(styleSource, /\.milkdown-code-block \.cm-selectionBackground\s*\{[^}]*background:\s*rgba\(47,128,237,\.32\)\s*!important/)
  assert.match(styleSource, /\.milkdown-code-block \.cm-activeLine,[\s\S]*background:\s*rgba\(47,128,237,\.07\)/)
  assert.match(styleSource, /\.milkdown-code-block \.cm-content ::selection\s*\{[^}]*background:\s*rgba\(47,128,237,\.32\)/)
  assert.match(styleSource, /\.milkdown-code-block \.cm-selectionBackground\s*\{[^}]*background:\s*rgba\(91,160,245,\.42\)\s*!important/)
  assert.match(styleSource, /\.sidebar-note-main small\s*\{[^}]*font-size:\s*10px/)
})

test('宽屏模式扩大正文画布并增强大纲侧栏', () => {
  const styleSource = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')

  assert.match(styleSource, /@media \(min-width:\s*1600px\)[\s\S]*--markdown-content-width:\s*1040px/)
  assert.match(styleSource, /@media \(min-width:\s*1600px\)[\s\S]*--markdown-outline-width:\s*300px/)
})

test('深色文件夹选择器通过主题变量使用低对比分隔线', () => {
  const styleSource = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')

  assert.match(styleSource, /--property-popover-divider:\s*#2b3e58/)
  assert.match(styleSource, /\.property-popover-divider\s*\{[^}]*background:\s*var\(--property-popover-divider\)/)
})

test('文件夹选择器在笔记属性、批量移动和高级搜索中复用', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const pickerSource = readFileSync(resolve(projectRoot, 'src/components/FolderPickerPopover.vue'), 'utf8')
  const quickOpenSource = readFileSync(resolve(projectRoot, 'src/components/QuickOpenDialog.vue'), 'utf8')

  assert.match(appSource, /const folderPickerSearchKeyword = ref\(''\)/)
  assert.equal((appSource.match(/<FolderPickerPopover/g)?.length || 0) + (quickOpenSource.match(/<FolderPickerPopover/g)?.length || 0), 3)
  assert.match(quickOpenSource, /title="筛选文件夹"[^]*root-label="全部文件夹"/)
  assert.match(pickerSource, /const filteredFolders = computed/)
  assert.match(pickerSource, /v-model="searchKeyword"[\s\S]*placeholder="搜索文件夹"/)
  assert.match(pickerSource, /v-for="folder in filteredFolders"/)
  assert.match(pickerSource, /folder-picker-empty[\s\S]*没有匹配的文件夹/)
})

test('高级搜索筛选控件使用紧凑辅助字号', () => {
  const styleSource = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')

  assert.match(styleSource, /--overlay-control-height:\s*32px/)
  assert.match(styleSource, /--overlay-option-height:\s*36px/)
  assert.match(styleSource, /--overlay-option-font-size:\s*11px/)
  assert.match(styleSource, /--overlay-menu-font-size:\s*13px/)
  assert.match(styleSource, /\.quick-open-filter-trigger\s*\{[^}]*height:\s*var\(--overlay-control-height\)[^}]*font-size:\s*var\(--overlay-menu-font-size\)/)
  assert.match(styleSource, /\.quick-open-filter-trigger > svg\s*\{[^}]*width:\s*15px[^}]*height:\s*15px/)
  assert.match(styleSource, /\.quick-open-time-popover > button\s*\{[^}]*height:\s*var\(--overlay-option-height\)[^}]*font-size:\s*var\(--overlay-option-font-size\)/)
  assert.match(styleSource, /\.quick-open-pinned-filter, \.quick-open-filter-clear\s*\{[^}]*height:\s*var\(--overlay-control-height\)[^}]*font-size:\s*var\(--overlay-menu-font-size\)/)
})

test('标签和文件夹搜索框高度一致且没有内外描边', () => {
  const styleSource = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')

  assert.match(styleSource, /\.folder-picker-search,\s*\.tag-picker-search\s*\{[^}]*height:\s*var\(--overlay-search-height\)[^}]*border:\s*0/)
  assert.match(styleSource, /\.folder-picker-search input,\s*\.tag-picker-search input\s*\{[^}]*height:\s*100%[^}]*border:\s*0[^}]*box-shadow:\s*none/)
  assert.match(styleSource, /:is\(\.folder-picker-search,\s*\.tag-picker-search\) input:focus\s*\{[^}]*border:\s*0[^}]*box-shadow:\s*none/)
})

test('同步范围、弹层边界和代码复制反馈清晰', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const editorSource = readFileSync(resolve(projectRoot, 'src/components/MarkdownVisualEditor.vue'), 'utf8')
  const styleSource = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')

  assert.match(appSource, /const syncActionLabel = computed/)
  assert.match(appSource, /同步全部笔记/)
  assert.match(appSource, /:aria-label="syncActionLabel"/)
  assert.match(editorSource, /onCopy:\s*\(\) => showFeedback\('代码已复制'\)/)
  assert.match(styleSource, /\.milkdown-code-block:has\(\.language-button\[data-expanded="true"\]\)/)
  assert.match(styleSource, /\.milkdown-code-block \.language-list\s*\{[^}]*height:\s*min\(410px,\s*42vh\)/)
  assert.match(styleSource, /--overlay-surface-max-height:\s*min\(420px,\s*calc\(100vh - 96px\)\)/)
  assert.match(styleSource, /\.property-popover\s*\{[^}]*max-height:\s*var\(--overlay-surface-max-height\)/)
})

test('资源右键菜单按渲染尺寸贴合视口并在小窗口内部滚动', () => {
  const appSource = readFileSync(resolve(projectRoot, 'src/App.vue'), 'utf8')
  const styleSource = readFileSync(resolve(projectRoot, 'src/style.css'), 'utf8')

  assert.match(appSource, /function positionContextMenuInViewport/)
  assert.match(appSource, /await nextTick\(\)/)
  assert.match(appSource, /getBoundingClientRect\(\)/)
  assert.match(appSource, /window\.innerHeight\s*-\s*menuRect\.height\s*-\s*CONTEXT_MENU_MARGIN/)
  assert.match(appSource, /ref="resourceContextMenuElement"/)
  assert.match(appSource, /ref="noteTabContextMenuElement"/)
  assert.match(styleSource, /\.resource-context-menu\s*\{[^}]*max-height:\s*calc\(100vh - 76px\)[^}]*overflow-y:\s*auto/)
})
