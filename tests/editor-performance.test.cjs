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
  assert.match(editorSource, /target\?\.closest<HTMLImageElement>\('img'\)/)
  assert.match(editorSource, /closest<HTMLElement>\('\.image-wrapper'\).*querySelector<HTMLImageElement>\('img'\)/s)
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
  assert.doesNotMatch(editorSource, /wikiLink|WikiLink|note-id-link|xinyue-note\.local/)
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
  assert.match(editorSource, /const shouldOpenLink = previewMode\.value \|\| props\.readonly \|\| event\.metaKey \|\| event\.ctrlKey/)
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
  assert.match(editorSource, /window\.notesDesktop\.openNoteLink\(noteId\)/)
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
