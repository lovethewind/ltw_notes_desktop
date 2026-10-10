const assert = require("node:assert/strict")
const { readFileSync } = require("node:fs")
const { resolve } = require("node:path")
const test = require("node:test")

const projectRoot = resolve(__dirname, "..")

test("切换笔记时复用 Markdown 编辑器实例", () => {
  const appSource = readFileSync(resolve(projectRoot, "src/App.vue"), "utf8")
  const editorBlock = appSource.match(
    /<div class="editor-body">[\s\S]*?<MarkdownVisualEditor[\s\S]*?\/>[\s\S]*?<\/div>/
  )?.[0]

  assert.ok(editorBlock, "应找到主编辑区的 MarkdownVisualEditor")
  assert.doesNotMatch(editorBlock, /:key="activeNote\.id"/)
  assert.match(editorBlock, /:document-id="activeNote\.id"/)
})

test("静默替换按归一化后的 Markdown 屏蔽延迟更新", () => {
  const editorSource = readFileSync(
    resolve(projectRoot, "src/components/MarkdownVisualEditor.vue"),
    "utf8"
  )

  assert.match(editorSource, /suppressedMarkdown = crepe\.getMarkdown\(\)/)
  assert.match(editorSource, /suppressedMarkdown === markdown/)
  assert.doesNotMatch(editorSource, /let suppressedUpdate = false/)
})

test("仅在切换到其他笔记时恢复对应的编辑区滚动位置", () => {
  const editorSource = readFileSync(
    resolve(projectRoot, "src/components/MarkdownVisualEditor.vue"),
    "utf8"
  )

  assert.match(editorSource, /const documentChanged = editorDocumentId !== documentId/)
  assert.match(editorSource, /if \(documentChanged\) resetEditorScroll\(\)/)
  assert.match(editorSource, /const nextScrollTop = Math\.max\(0, props\.scrollTop\)/)
  assert.match(editorSource, /scrollContainer\.scrollTop = nextScrollTop/)
})

test("切换笔记时清空上一文档的撤销历史", () => {
  const editorSource = readFileSync(
    resolve(projectRoot, "src/components/MarkdownVisualEditor.vue"),
    "utf8"
  )
  const resetHistorySource = editorSource.slice(
    editorSource.indexOf("function resetDocumentHistory"),
    editorSource.indexOf("function closeToolbarMenus")
  )

  assert.match(resetHistorySource, /function resetDocumentHistory\(crepe: Crepe\)/)
  assert.match(resetHistorySource, /const historyKey = historyProviderPlugin\.key\(\)/)
  assert.match(resetHistorySource, /const freshHistoryState = historyKey\.getState\(stateWithFreshHistory\)/)
  assert.match(resetHistorySource, /setMeta\(historyKey, \{ historyState: freshHistoryState \}\)/)
  assert.doesNotMatch(resetHistorySource, /EditorState\.create/)
  assert.doesNotMatch(resetHistorySource, /view\.updateState/)
  assert.match(editorSource, /if \(documentChanged\) resetDocumentHistory\(editor\)/)
})

test("Crepe 重绘顶栏后重新应用自定义工具栏且不重复绑定事件", () => {
  const editorSource = readFileSync(
    resolve(projectRoot, "src/components/MarkdownVisualEditor.vue"),
    "utf8"
  )

  assert.match(editorSource, /function startToolbarSync\(root: HTMLElement\)/)
  assert.match(editorSource, /if \(inner && !inner\.querySelector\('\.top-bar-actions'\)\) localizeTopBar\(root\)/)
  assert.match(editorSource, /startToolbarSync\(editorRootRef\.value\)/)
  assert.match(editorSource, /if \(inner\.querySelector\('\.top-bar-actions'\)\)/)
  assert.match(editorSource, /if \(!toolbarEventsBound\) \{/)
})

test("撤销和重做按钮跟随编辑器历史深度切换禁用状态", () => {
  const editorSource = readFileSync(
    resolve(projectRoot, "src/components/MarkdownVisualEditor.vue"),
    "utf8"
  )

  assert.match(editorSource, /import \{ redoDepth, undoDepth \} from '@milkdown\/kit\/prose\/history'/)
  assert.match(editorSource, /function syncHistoryActionButtons\(root: HTMLElement\)/)
  assert.match(editorSource, /undoButton\.disabled = isReadonly \|\| undoDepth\(view\.state\) === 0/)
  assert.match(editorSource, /redoButton\.disabled = isReadonly \|\| redoDepth\(view\.state\) === 0/)
  assert.match(editorSource, /listener\.updated\(\(\) => \{\s+if \(editorRootRef\.value\) syncHistoryActionButtons/)
})

test("首个代码块开头支持插入前置段落", () => {
  const editorSource = readFileSync(
    resolve(projectRoot, "src/components/MarkdownVisualEditor.vue"),
    "utf8"
  )

  assert.match(editorSource, /EditorView\.findFromDOM\(codeMirrorElement\)/)
  assert.match(editorSource, /selection\.head !== 0/)
  assert.match(editorSource, /firstChild\?\.type\.name !== 'code_block'/)
  assert.match(editorSource, /state\.tr\.insert\(0, paragraph\)/)
})

test("编辑器粘贴图片会保存为桌面端离线资源", () => {
  const editorSource = readFileSync(
    resolve(projectRoot, "src/components/MarkdownVisualEditor.vue"),
    "utf8"
  )
  const preloadSource = readFileSync(resolve(projectRoot, "electron/preload.cjs"), "utf8")

  assert.match(editorSource, /window\.notesDesktop\.saveImageAsset/)
  assert.doesNotMatch(editorSource, /reader\.readAsDataURL\(file\)/)
  assert.match(editorSource, /async function insertPastedImage\(file: File\)/)
  assert.match(editorSource, /view\.state\.schema\.nodes\['image-block'\] \|\| view\.state\.schema\.nodes\.image/)
  assert.match(editorSource, /filter\(\(file\) => file\.type\.startsWith\('image\/'\)\)/)
  assert.match(preloadSource, /asset:save-image/)
})

test("桌面端图片会通过本地协议展示并在同步前上传", () => {
  const mainSource = readFileSync(resolve(projectRoot, "electron/main.cjs"), "utf8")

  assert.match(mainSource, /protocol\.handle\(LOCAL_ASSET_PROTOCOL/)
  assert.match(mainSource, /\/api\/oss\/getSignatureUrl/)
  assert.match(mainSource, /await uploadPendingImageAssets\(controller\.signal\)/)
  assert.match(mainSource, /await cacheRemoteImages\(controller\.signal\)/)
})

test("正文图片右键可以复制当前图片地址", () => {
  const editorSource = readFileSync(
    resolve(projectRoot, "src/components/MarkdownVisualEditor.vue"),
    "utf8"
  )

  assert.match(editorSource, /addEventListener\('contextmenu', handleImageContextMenu\)/)
  // 图片判定（含编辑态 .image-wrapper 兜底、排除图注按钮与缩放手柄）收敛在
  // src/utils/preview-image-tools.ts，图片菜单与正文菜单共用它，细节断言见 preview-image-tools.test.cjs。
  assert.match(editorSource, /return resolvePreviewImageElement\(target\)/)
  assert.match(editorSource, /navigator\.clipboard\.writeText\(imageContextMenu\.value\.address\)/)
  assert.match(editorSource, /复制图片地址/)
  assert.match(editorSource, /Math\.min\(event\.clientX, window\.innerWidth/)
  assert.match(editorSource, /removeEventListener\('contextmenu', handleImageContextMenu\)/)
})

test("桌面端支持保存、打开和同步通用附件", () => {
  const editorSource = readFileSync(
    resolve(projectRoot, "src/components/MarkdownVisualEditor.vue"),
    "utf8"
  )
  const mainSource = readFileSync(resolve(projectRoot, "electron/main.cjs"), "utf8")
  const preloadSource = readFileSync(resolve(projectRoot, "electron/preload.cjs"), "utf8")

  assert.match(editorSource, /window\.notesDesktop\.saveAttachment/)
  assert.doesNotMatch(editorSource, /type="file"\s+accept=/)
  assert.doesNotMatch(editorSource, /className = 'attachment-link'/)
  assert.doesNotMatch(editorSource, /document\.createElement\('audio'\)/)
  assert.match(editorSource, /https:\/\/xinyue-asset\.local\//)
  assert.match(editorSource, /new URL\(href\)\.hostname === 'xinyue-asset\.local'/)
  assert.match(
    editorSource,
    /hostname === 'xinyue-asset\.local'[\s\S]*?if \(event\.button !== 0 \|\| !shouldOpenLink\) return[\s\S]*?openAttachment/
  )
  assert.match(editorSource, /view\.state\.schema\.marks\.link/)
  assert.match(editorSource, /linkMark\.create\(\{ href: internalUrl, title: attachmentTitle \}\)/)
  assert.doesNotMatch(editorSource, /const markdown = `\[\$\{escapeAttachmentName/)
  assert.match(editorSource, /addEventListener\('paste', handleAttachmentPaste, true\)/)
  assert.match(editorSource, /addEventListener\('drop', handleAttachmentDrop\)/)
  assert.match(mainSource, /dirType: asset\.mimeType\.startsWith\("image\/"\) \? "image" : "attach"/)
  assert.match(preloadSource, /asset:save-attachment/)
  assert.match(preloadSource, /asset:open/)
  assert.match(mainSource, /MAX_ATTACHMENT_BYTES = 100 \* 1024 \* 1024/)
  assert.match(mainSource, /async function saveAttachment/)
  assert.match(mainSource, /async function openAttachment/)
  assert.match(mainSource, /await cacheRemoteAttachments\(controller\.signal\)/)
})

test("搜索或标签筛选时只展示命中文件夹路径并自动展开", () => {
  const appSource = readFileSync(resolve(projectRoot, "src/App.vue"), "utf8")

  assert.match(appSource, /const searchFolderIds = computed/)
  assert.match(appSource, /!searchKeyword\.value\.trim\(\) && activeFilter\.kind !== 'tag'/)
  assert.match(appSource, /const explorerFolders = computed/)
  assert.match(appSource, /const explorerExpandedFolderIds = computed/)
  assert.match(appSource, /:folders="explorerFolders"/)
  assert.match(appSource, /:expanded-folder-ids="explorerExpandedFolderIds"/)
  assert.match(appSource, /v-if="!searchFolderIds \|\| getUnclassifiedNotes\(\)\.length"/)
  assert.match(appSource, /v-if="searchFolderIds && !rootFolders\.length && !getUnclassifiedNotes\(\)\.length"/)
})

test("搜索同时匹配标题和正文并展示命中上下文", () => {
  const appSource = readFileSync(resolve(projectRoot, "src/App.vue"), "utf8")

  assert.match(appSource, /scheduleWorkspaceSearch/)
  assert.match(appSource, /searchNotes\(keyword, \{ limit: 1000 \}\)/)
  assert.match(appSource, /<SearchExcerpt :content="note\.content" :keyword="searchKeyword"/)
})

test("普通笔记摘要只处理有限正文并限制展示长度", () => {
  const utilitySource = readFileSync(resolve(projectRoot, "src/utils/note-workspace.ts"), "utf8")
  const excerptSource = readFileSync(resolve(projectRoot, "src/components/SearchExcerpt.vue"), "utf8")
  const treeSource = readFileSync(resolve(projectRoot, "src/components/FolderTreeItem.vue"), "utf8")

  assert.match(utilitySource, /export function formatNotePreview/)
  assert.match(utilitySource, /content\.slice\(0, scanLength\)/)
  assert.match(utilitySource, /\.slice\(0, maxLength\)/)
  assert.match(excerptSource, /formatNotePreview/)
  assert.match(treeSource, /folderNoteCounts\.get\(folder\.id\)/)
  assert.doesNotMatch(treeSource, /function countFolderNotes/)
})

test("工作区正文按需读取且搜索交给 SQLite", () => {
  const appSource = readFileSync(resolve(projectRoot, "src/App.vue"), "utf8")
  const mainSource = readFileSync(resolve(projectRoot, "electron/main.cjs"), "utf8")
  const ipcSource = readFileSync(resolve(projectRoot, "electron/ipc-handlers.cjs"), "utf8")
  const preloadSource = readFileSync(resolve(projectRoot, "electron/preload.cjs"), "utf8")

  assert.match(ipcSource, /note:detail[\s\S]*?domain\.getNote/)
  assert.match(ipcSource, /note:search[\s\S]*?domain\.searchNotes/)
  assert.match(mainSource, /getNote:[\s\S]*?getNoteForEditing/)
  assert.match(mainSource, /searchNotes:[\s\S]*?repository\.searchNotes/)
  assert.match(preloadSource, /getNote[\s\S]*?note:detail/)
  assert.match(preloadSource, /searchNotes[\s\S]*?note:search/)
  assert.match(appSource, /contentLoaded === false[\s\S]*?window\.notesDesktop\.getNote/)
  assert.match(appSource, /window\.notesDesktop\.searchNotes/)
  assert.doesNotMatch(appSource, /matchesNoteSearch\(note, keyword\)/)
})

test("工作区空会话不自动打开笔记且只展开恢复笔记路径", () => {
  const appSource = readFileSync(resolve(projectRoot, "src/App.vue"), "utf8")
  const utilitySource = readFileSync(resolve(projectRoot, "src/utils/note-workspace.ts"), "utf8")

  assert.match(utilitySource, /export function collectFolderPathIds/)
  assert.match(appSource, /new Set\(collectFolderPathIds\(workspace\.folders, target\.folderId\)\)/)
  assert.doesNotMatch(appSource, /new Set\(data\.folders\.map\(\(folder\) => folder\.id\)\)/)
  assert.doesNotMatch(appSource, /\?\? availableNotes\[0\]/)
})

test("历史列表本地立即返回并按需读取完整版本", () => {
  const historyDialogSource = readFileSync(resolve(projectRoot, "src/components/NoteHistoryDialog.vue"), "utf8")
  const mainSource = readFileSync(resolve(projectRoot, "electron/main.cjs"), "utf8")
  const ipcSource = readFileSync(resolve(projectRoot, "electron/ipc-handlers.cjs"), "utf8")
  const preloadSource = readFileSync(resolve(projectRoot, "electron/preload.cjs"), "utf8")

  const listHandler = ipcSource.match(/ipcMain\.handle\("note-history:list"[^\n]+/)?.[0]
  assert.ok(listHandler)
  assert.match(listHandler, /domain\.listHistory/)
  assert.match(mainSource, /listHistory: \(noteId\) => repository\.listNoteHistory/)
  assert.doesNotMatch(listHandler, /await performSync/)
  assert.doesNotMatch(listHandler, /requestImmediateSync\(\)/)
  assert.match(preloadSource, /note-history:detail/)
  assert.match(historyDialogSource, /loadSelectedHistory/)
  assert.match(historyDialogSource, /detailLoading/)
  assert.match(historyDialogSource, /loadedHistoryIds/)
  assert.doesNotMatch(historyDialogSource, /!selectedHistory\.content/)
})

test("冲突处理在展示和操作前加载两侧完整正文", () => {
  const appSource = readFileSync(resolve(projectRoot, "src/App.vue"), "utf8")

  assert.match(appSource, /loadSelectedConflictDetail/)
  assert.match(appSource, /Promise\.all\([\s\S]*window\.notesDesktop\.getNote\(summary\.conflict\.id\)[\s\S]*window\.notesDesktop\.getNote\(summary\.original\.id\)/)
  assert.match(appSource, /conflictDetailLoading \|\| !selectedConflictDetail/)
})

test("当前笔记支持快捷键查找并定位编辑器匹配项", () => {
  const appSource = readFileSync(resolve(projectRoot, "src/App.vue"), "utf8")
  const editorSource = readFileSync(
    resolve(projectRoot, "src/components/MarkdownVisualEditor.vue"),
    "utf8"
  )

  assert.match(appSource, /event\.key\.toLocaleLowerCase\(\) === 'f'/)
  assert.match(appSource, /markdownEditorRef\.value\?\.findText/)
  assert.match(editorSource, /function findText/)
  assert.match(editorSource, /defineExpose\(\{[^}]*findText[^}]*\}\)/)
})

test("笔记内查找定位结果时不会抢走查找框焦点", () => {
  const editorSource = readFileSync(
    resolve(projectRoot, "src/components/MarkdownVisualEditor.vue"),
    "utf8"
  )
  const findTextBlock = editorSource.match(
    /function findText\([\s\S]*?\n}\n\n\/\*\*[\s\S]*?function clearFindHighlight/
  )?.[0]

  assert.ok(findTextBlock, "应找到笔记内查找实现")
  assert.doesNotMatch(findTextBlock, /view\.focus\(\)/)
})

test("笔记内查找在不抢焦点时显式滚动编辑区", () => {
  const editorSource = readFileSync(
    resolve(projectRoot, "src/components/MarkdownVisualEditor.vue"),
    "utf8"
  )
  const findTextBlock = editorSource.match(
    /function findText\([\s\S]*?\n}\n\n\/\*\*[\s\S]*?function clearFindHighlight/
  )?.[0]

  assert.ok(findTextBlock, "应找到笔记内查找实现")
  assert.match(findTextBlock, /closest<HTMLElement>\('\.milkdown-editor-scroll'\)/)
  assert.match(findTextBlock, /scrollContainer\.scrollTo/)
})

test("笔记内查找使用独立装饰持续高亮当前匹配项", () => {
  const editorSource = readFileSync(
    resolve(projectRoot, "src/components/MarkdownVisualEditor.vue"),
    "utf8"
  )

  assert.match(editorSource, /Decoration\.inline/)
  assert.match(editorSource, /note-find-match/)
  assert.match(editorSource, /DecorationSet\.create/)
})

test("编辑器不再注册双向链接功能", () => {
  const appSource = readFileSync(resolve(projectRoot, "src/App.vue"), "utf8")
  const styleSource = readFileSync(resolve(projectRoot, "src/style.css"), "utf8")
  const editorSource = readFileSync(
    resolve(projectRoot, "src/components/MarkdownVisualEditor.vue"),
    "utf8"
  )

  assert.match(editorSource, /function createEditorDecorations/)
  assert.doesNotMatch(editorSource, /setProps\(\{ decorations: \(\) => DecorationSet\.empty/)
  // 编辑器不再注册第三方双向链接插件，但会通过 openNoteLink 处理 xinyue-note.local 链接以实现点击跳转。
  assert.doesNotMatch(editorSource, /wikiLink|WikiLink|note-id-link/)
  assert.doesNotMatch(appSource, /wikiLink|WikiLink|backlinks-panel|反向链接/)
  assert.doesNotMatch(styleSource, /wiki-link|note-id-link|backlinks-panel/)
})

test("编辑器外部链接不会替换笔记应用页面", () => {
  const mainSource = readFileSync(resolve(projectRoot, "electron/main.cjs"), "utf8")

  assert.match(mainSource, /webContents\.on\("will-navigate"/)
  assert.match(mainSource, /event\.preventDefault\(\)/)
  assert.match(mainSource, /shell\.openExternal\(targetUrl\.toString\(\)\)/)
  assert.match(mainSource, /targetUrl\.hostname !== "xinyue-note\.local"/)
})

test("编辑器外部链接仅在 Command 或 Ctrl 加左键时打开", () => {
  const editorSource = readFileSync(
    resolve(projectRoot, "src/components/MarkdownVisualEditor.vue"),
    "utf8"
  )
  const preloadSource = readFileSync(resolve(projectRoot, "electron/preload.cjs"), "utf8")
  const ipcSource = readFileSync(resolve(projectRoot, "electron/ipc-handlers.cjs"), "utf8")

  assert.match(editorSource, /event\.button !== 0/)
  assert.match(editorSource, /event\.metaKey \|\| event\.ctrlKey/)
  // ⚠️ 口径：正文里的链接仍是「⌘/Ctrl 加左键」；**链接气泡里的链接不要求修饰键** ——
  // 气泡本来就是「点一下这条链接」弹出来的，再要修饰键就等于没给入口（2026-10-10）。
  assert.match(
    editorSource,
    /const insideLinkTooltip = Boolean\(anchor\?\.closest\('\.milkdown-link-preview'\)\)/
  )
  assert.match(
    editorSource,
    /const shouldOpenLink = insideLinkTooltip\s*\n\s*\|\| previewMode\.value\s*\n\s*\|\| props\.readonly\s*\n\s*\|\| event\.metaKey\s*\n\s*\|\| event\.ctrlKey/
  )
  assert.match(editorSource, /if \(event\.button !== 0 \|\| !shouldOpenLink\) return/)
  assert.match(editorSource, /window\.notesDesktop\.openExternalLink/)
  assert.match(preloadSource, /external-link:open/)
  assert.match(ipcSource, /ipcMain\.handle\("external-link:open"/)
})

test("编辑器链接仅在按住 Command 或 Ctrl 时显示手型光标", () => {
  const editorSource = readFileSync(
    resolve(projectRoot, "src/components/MarkdownVisualEditor.vue"),
    "utf8"
  )
  const styleSource = readFileSync(resolve(projectRoot, "src/style.css"), "utf8")

  assert.match(editorSource, /classList\.toggle\('is-link-modifier-active'/)
  assert.match(editorSource, /event\.metaKey \|\| event\.ctrlKey/)
  assert.match(editorSource, /window\.addEventListener\('blur', clearLinkModifierState\)/)
  assert.match(styleSource, /\.is-link-modifier-active[^,{]*\.milkdown-editor-root a\[href\][^{]*\{[^}]*cursor:\s*pointer/)
  assert.match(styleSource, /\.milkdown-editor-shell\.is-preview[^,{]*a\[href\][^{]*\{[^}]*cursor:\s*pointer/)
  assert.doesNotMatch(styleSource, /(?:^|\n)\.milkdown-editor-root a\[href\]\s*\{\s*cursor:\s*pointer/)
})

test("笔记右键菜单可复制并响应应用深链接", () => {
  const appSource = readFileSync(resolve(projectRoot, "src/App.vue"), "utf8")
  const mainSource = readFileSync(resolve(projectRoot, "electron/main.cjs"), "utf8")
  const preloadSource = readFileSync(resolve(projectRoot, "electron/preload.cjs"), "utf8")
  const editorSource = readFileSync(
    resolve(projectRoot, "src/components/MarkdownVisualEditor.vue"),
    "utf8"
  )

  assert.match(appSource, /handleNoteContextCommand\('copy-link'\)/)
  assert.match(appSource, /new URL\(\s*`\/notes\/\$\{encodeURIComponent\(serverId\)\}`/)
  assert.match(appSource, /serverId = note\.serverId/)
  assert.match(appSource, /window\.notesDesktop\.runSync\(\)/)
  assert.match(appSource, /syncSettings\.webUrl/)
  assert.match(appSource, /new ClipboardItem/)
  assert.match(appSource, /'text\/html'/)
  assert.match(appSource, /'text\/plain'/)
  assert.match(appSource, /\[\$\{noteTitle\}\]\(\$\{noteLink\}\)/)
  assert.match(appSource, /window\.notesDesktop\.onOpenNoteLink/)
  assert.match(appSource, /item\.id === noteId \|\| item\.serverId === noteId/)
  assert.match(mainSource, /callbackUrl\.hostname === "note"/)
  assert.match(mainSource, /targetUrl\.pathname\.match\(\/\^\\\/notes\\\/\(\[\^\/\]\+\)/)
  assert.match(mainSource, /targetUrl\.origin === new URL\(syncSettings\.webUrl\)\.origin/)
  assert.match(mainSource, /const loginUrl = new URL\("\/notes", `\$\{webUrl\}\/`\)/)
  assert.match(mainSource, /webContents\.send\("note-link:open", noteId\)/)
  assert.match(preloadSource, /onOpenNoteLink/)
  assert.match(preloadSource, /ipcRenderer\.on\("note-link:open"/)
  assert.match(preloadSource, /note-link:open-local/)
  // 编辑器内部链接点击改为「新标签页打开」：经 note-open-events 总线派发，而非 IPC 原地切换。
  assert.match(editorSource, /dispatchOpenNote\(noteId, true\)/)
  assert.match(editorSource, /import \{[^}]*\bdispatchOpenNote\b[^}]*\} from '\.\.\/utils\/note-open-events'/)
})

test("退出账号只清除认证并保留当前用户档案", () => {
  const mainSource = readFileSync(resolve(projectRoot, "electron/main.cjs"), "utf8")
  const clearSettingsBlock = mainSource.match(
    /async function clearSyncSettings\(\)[\s\S]*?return getSyncSettingsView\(\)\n}/
  )?.[0]

  assert.ok(clearSettingsBlock, "应找到清除同步账号逻辑")
  assert.match(clearSettingsBlock, /token: ""/)
  assert.match(clearSettingsBlock, /accountId: syncSettings\.accountId/)
  assert.match(clearSettingsBlock, /accountLabel: syncSettings\.accountLabel/)
  assert.doesNotMatch(clearSettingsBlock, /accountId: ""/)
})

test("嵌入卡片右键菜单链路接线完整", () => {
  const eventsSource = readFileSync(resolve(projectRoot, "src/utils/note-open-events.ts"), "utf8")
  const cardSource = readFileSync(resolve(projectRoot, "src/components/NoteEmbedCard.vue"), "utf8")
  const embedSource = readFileSync(resolve(projectRoot, "src/editor/xynote-embed.ts"), "utf8")
  const editorSource = readFileSync(
    resolve(projectRoot, "src/components/MarkdownVisualEditor.vue"),
    "utf8"
  )

  // 1) 事件总线：命名常量 + 派发函数 + pos 载荷
  assert.match(eventsSource, /export const EMBED_CARD_MENU_EVENT = 'xynote:embed-card-menu'/)
  assert.match(eventsSource, /export function dispatchEmbedCardMenu\(detail: EmbedCardMenuEventDetail\)/)
  assert.match(eventsSource, /pos: number/)

  // 2) 卡片：右键绑定到 onContextMenu；必须阻止冒泡，否则正文右键菜单会覆盖卡片菜单
  assert.match(cardSource, /@contextmenu="onContextMenu"/)
  assert.match(cardSource, /event\.preventDefault\(\)/)
  assert.match(cardSource, /event\.stopPropagation\(\)/)
  // 加载中不弹菜单；缺失/已删除态照常弹（可执行删除卡片），用 available 标记可否打开
  assert.match(cardSource, /if \(loading\.value\) return/)
  assert.match(cardSource, /available: !missing\.value && !deleted\.value/)

  // 3) nodeView：用 getPos 补节点位置后派发
  assert.match(embedSource, /import \{ dispatchEmbedCardMenu \} from '\.\.\/utils\/note-open-events'/)
  assert.match(embedSource, /pos: getPos\(\) \?\? -1/)
  assert.match(embedSource, /available: payload\.available/)
  assert.match(embedSource, /onContextMenu/)

  // 4) 编辑器：监听/卸载对称 + 分组构造 + 四个命令
  assert.match(editorSource, /window\.addEventListener\(EMBED_CARD_MENU_EVENT, handleEmbedCardMenu\)/)
  assert.match(editorSource, /window\.removeEventListener\(EMBED_CARD_MENU_EVENT, handleEmbedCardMenu\)/)
  assert.match(editorSource, /function buildEmbedCardMenuGroups\(\)/)
  assert.match(editorSource, /menuItem\('embedOpen', '打开笔记', \{[^}]*disabled: !canOpen \}\)/)
  assert.match(editorSource, /menuItem\('embedCopyRef', '复制嵌入引用'/)
  // 正文右键菜单兜底跳过卡片节点，避免卡片与正文菜单串台
  assert.match(editorSource, /target\?\.closest\('\.xynote-embed-nodeview'\)/)
  assert.match(editorSource, /menuItem\('embedUnwrap', '转换为链接'/)
  assert.match(editorSource, /menuItem\('embedDelete', '删除卡片'/)
  assert.match(editorSource, /async function runEmbedCardCommand\(action: string\)/)
  // 转换为链接：查 serverId 生成真实线上地址（与插入链接一致）
  assert.match(editorSource, /buildNoteHref\(target\.noteId, note\?\.serverId \?\? null\)/)
  // 删除卡片：定位到卡片节点后整块删除
  assert.match(editorSource, /node\.type\.name !== 'xynoteEmbed'/)
  assert.match(editorSource, /tr\.delete\(target\.pos, target\.pos \+ node\.nodeSize\)/)
})

test("嵌入卡片展开全文接线完整", () => {
  const cardSource = readFileSync(resolve(projectRoot, "src/components/NoteEmbedCard.vue"), "utf8")
  const embedSource = readFileSync(resolve(projectRoot, "src/editor/xynote-embed.ts"), "utf8")

  // 1) 展开态是组件内部视图状态，不动文档；摘要仍在时截前 160 字
  assert.match(cardSource, /const expanded = ref\(false\)/)
  assert.match(cardSource, /const canExpand = computed\(\(\) => plainText\.value\.length > 160\)/)
  assert.match(cardSource, /plainText\.value = stripMarkdown\(rawContent\.value\)/)
  assert.match(cardSource, /excerpt\.value = plainText\.value\.slice\(0, 160\)/)
  assert.match(cardSource, /rawContent\.value = target\.content \|\| ''/)

  // 2) 懒渲染：首次展开才解析 markdown，避免每张卡片加载即解析
  assert.match(cardSource, /if \(!expanded\.value && !fullHtml\.value\)/)
  assert.match(cardSource, /fullHtml\.value = renderNoteBody\(rawContent\.value\)/)
  assert.match(
    cardSource,
    /sanitizePreviewHtml\(marked\.parse\(withoutNested, \{ async: false \}\)\)/
  )
  // 清洗统一走共用入口（协议白名单只留一份，本地图片的 `xinyue-asset:` 才不会被剥掉）。
  assert.match(cardSource, /import \{ sanitizePreviewHtml \} from '\.\.\/utils\/preview-sanitize'/)
  assert.match(cardSource, /import \{ marked \} from 'marked'/)

  // 3) 递归防护：展开视图里摘掉嵌套嵌入卡片 HTML，换成不可递归的**单行占位**（防 A↔B 成环）。
  //    用带 data 标记的 <p> 而非 markdown 引用块——引用块的 blockquote(margin) 套 p(margin)
  //    会叠出双倍高度，且样式无法单独收敛
  assert.match(cardSource, /data-xynote-embed=/)
  assert.match(cardSource, /data-xynote-embed-placeholder/)
  assert.match(cardSource, /请到原笔记中查看/)
  assert.doesNotMatch(cardSource, /> 此处原有一张嵌入卡片/)

  // 4) 展开提示：已从按钮降级为不可点的纯提示文字（唯一展开入口是卡片主体），
  //    aria-expanded 移到卡片根——它才是展开的触发者；旧按钮类名/绑定必须清除
  assert.match(cardSource, /note-embed-card__expand-hint/)
  assert.match(cardSource, /:aria-expanded="canExpand \? expanded : undefined"/)
  assert.match(cardSource, /v-if="excerpt && !expanded"/)
  assert.doesNotMatch(cardSource, /note-embed-card__toggle/)
  assert.doesNotMatch(cardSource, /@click\.stop="toggleExpanded"/)

  // 4b) 提示平时隐藏、hover 头部才淡入，且文案指向卡片本身
  //     （静态摆一行小字会误导成「只有这行字能点」）
  assert.match(cardSource, /点击卡片展开全文/)
  assert.match(cardSource, /点击卡片收起/)
  assert.match(cardSource, /\.note-embed-card__expand-hint \{[\s\S]{0,400}?opacity: 0;/)
  assert.match(cardSource, /\.note-embed-card__body:hover \.note-embed-card__expand-hint/)

  // 5) 交互分工：点卡片主体=展开/收起（默认动作，避免误触跳转），
  //    只有点右侧箭头按钮才打开笔记；无可展开内容的卡片才由主体点击兜底跳转
  assert.match(cardSource, /@click="onCardClick"/)
  assert.match(cardSource, /@keydown\.enter="onCardClick"/)
  assert.match(cardSource, /function onCardClick\(\): void \{/)
  assert.match(cardSource, /if \(canExpand\.value\) \{\s*toggleExpanded\(\)/)
  assert.match(cardSource, /@click\.stop="open"/)
  assert.match(cardSource, /aria-label="打开笔记"/)

  // 6) 展开区：点击不外泄触发卡片跳转；链接交给主进程打开（站内转应用内、外链走浏览器）
  assert.match(cardSource, /@click\.stop="onFullClick"/)
  assert.match(cardSource, /v-html="fullHtml"/)
  assert.match(cardSource, /event\.target instanceof Element \? event\.target\.closest\('a'\) : null/)
  assert.match(cardSource, /window\.notesDesktop\.openExternalLink\(href\)/)

  // 7) 样式：整行折行 + 自身可滚可选中（scoped 下 v-html 需 :deep）
  assert.match(cardSource, /flex-wrap: wrap/)
  assert.match(cardSource, /max-height: min\(52vh, 420px\)/)
  assert.match(cardSource, /user-select: text/)
  assert.match(cardSource, /:deep\(p\)/)
  // 占位必须是单行紧凑样式（padding 3px + line-height 16px），不能退回引用块的叠加高度
  assert.match(cardSource, /:deep\(\[data-xynote-embed-placeholder\]\) \{[\s\S]{0,200}?line-height: 16px;/)

  // 8) 拖选文字：节点 schema 必须 draggable:false（否则 PM 给卡片 DOM 加原生 draggable，
  //    拖动会变成拖整张卡片、正文无法选中复制）；展开区再兜一层
  assert.match(embedSource, /draggable: false/)
  assert.doesNotMatch(embedSource, /draggable: true/)
  assert.match(cardSource, /draggable="false"/)
  assert.match(cardSource, /@dragstart\.prevent\.stop/)
})

test("侧栏「关系」页签接线完整且提及链路已移除", () => {
  const editorSource = readFileSync(resolve(projectRoot, "src/components/MarkdownVisualEditor.vue"), "utf8")
  const listSource = readFileSync(resolve(projectRoot, "src/components/BacklinksPanel.vue"), "utf8")
  const styleSource = readFileSync(resolve(projectRoot, "src/style.css"), "utf8")
  const ipcSource = readFileSync(resolve(projectRoot, "electron/ipc-handlers.cjs"), "utf8")
  const preloadSource = readFileSync(resolve(projectRoot, "electron/preload.cjs"), "utf8")
  const dbSource = readFileSync(resolve(projectRoot, "electron/database.cjs"), "utf8")

  // 1) 顶层页签收敛为 2 个：大纲 / 关系（原来的「链接」「图谱」不再各自占一个页签）
  const tabsBlock = editorSource.match(/const OUTLINE_TABS = \[[\s\S]*?\] as const/)?.[0]
  assert.ok(tabsBlock, "应找到 OUTLINE_TABS 定义")
  assert.match(tabsBlock, /label: '大纲'/)
  assert.match(tabsBlock, /label: '关系'/)
  assert.doesNotMatch(tabsBlock, /label: '链接'/)
  assert.doesNotMatch(tabsBlock, /label: '图谱'/)

  // 2) 关系页签内的二级切换：列表 / 图谱互斥挂载，视图区独占剩余高度
  const viewsBlock = editorSource.match(/const RELATIONSHIP_VIEWS = \[[\s\S]*?\] as const/)?.[0]
  assert.ok(viewsBlock, "应找到 RELATIONSHIP_VIEWS 定义")
  assert.match(viewsBlock, /label: '列表'/)
  assert.match(viewsBlock, /label: '图谱'/)
  assert.match(editorSource, /const relationshipView = ref<RelationshipViewId>\('list'\)/)
  assert.match(editorSource, /relationshipView = view\.id/)
  assert.match(editorSource, /<BacklinksPanel v-if="relationshipView === 'list'"/)
  assert.match(editorSource, /<NoteGraphPanel v-else/)
  assert.match(styleSource, /\.relationship-panel__view \{ flex: 1; min-height: 0;/)

  // 3) 列表视图：入边 + 出边两组，出边走新 IPC，提及相关代码必须清干净
  assert.match(listSource, /window\.notesDesktop\.getNoteOutlinks\(id\)/)
  assert.match(listSource, /label: '引用了本篇'/)
  assert.match(listSource, /label: '本篇引用'/)
  assert.doesNotMatch(listSource, /getNoteMentions|MentionNote|highlightSegments|backlinks-item--mention/)

  // 4) 出边链路三层打通：database → ipc → preload（domain 绑定见 main.cjs）
  assert.match(dbSource, /function getNoteOutlinks\(noteId\)/)
  assert.match(dbSource, /WHERE l\.source_note_id = \? AND n\.is_deleted = 0/)
  assert.match(ipcSource, /ipcMain\.handle\("note:outlinks"/)
  assert.match(preloadSource, /getNoteOutlinks: \(noteId\) => ipcRenderer\.invoke\("note:outlinks", noteId\)/)
  assert.match(
    readFileSync(resolve(projectRoot, "electron/main.cjs"), "utf8"),
    /getOutlinks: \(noteId\) => repository\.getNoteOutlinks\(noteId\)/
  )

  // 5) 提及链路整体退役：后端与桥接层都不应留下残留
  assert.doesNotMatch(dbSource, /getNoteMentions|MENTION_STOP_WORDS|buildMentionExcerpt/)
  assert.doesNotMatch(ipcSource, /note:mentions/)
  assert.doesNotMatch(preloadSource, /getNoteMentions/)

  // 6) 面板跳转一律「新标签页」：关系列表 / 侧栏图谱 / 全库图谱都走 dispatchOpenNote(id, true)。
  //    不得回退到原地切换的 IPC openNoteLink——那条链路保留给深链协议与站内链接点击
  //    （main.cjs 的 openExternalLink / xynote://note 回调），改动它会波及从应用外部进入的场景。
  for (const name of ["BacklinksPanel", "NoteGraphPanel", "GlobalGraphPanel"]) {
    const source = readFileSync(resolve(projectRoot, `src/components/${name}.vue`), "utf8")
    assert.match(source, /import \{ dispatchOpenNote \} from '\.\.\/utils\/note-open-events'/, `${name} 应引入 dispatchOpenNote`)
    assert.doesNotMatch(source, /notesDesktop\.openNoteLink/, `${name} 不应再用原地切换的 openNoteLink`)
    assert.match(source, /dispatchOpenNote\(noteId, true\)/, `${name} 应以新标签页打开`)
  }
  // 全库图谱是弹层：新标签页打开后仍要收掉，避免留下与上下文不符的浮层
  const globalGraphSource = readFileSync(resolve(projectRoot, "src/components/GlobalGraphPanel.vue"), "utf8")
  assert.match(globalGraphSource, /emit\('close'\)/)
})
