const test = require("node:test")
const assert = require("node:assert/strict")
const { readFileSync } = require("node:fs")
const { resolve } = require("node:path")

const projectRoot = resolve(__dirname, "..")
const readSource = (filePath) => readFileSync(resolve(projectRoot, filePath), "utf8")

test("主页面按更新、附件和备份功能复用独立 composable", () => {
  const appSource = readSource("src/App.vue")

  assert.match(appSource, /useAppUpdate/)
  assert.match(appSource, /useAttachmentManager/)
  assert.match(appSource, /useDatabaseBackups/)
  assert.doesNotMatch(appSource, /async function repairAttachmentIntegrity/)
  assert.doesNotMatch(appSource, /async function restoreDatabaseBackup/)
  assert.doesNotMatch(appSource, /async function runUpdateCheck/)
})

test("快速打开将查询、筛选、历史和键盘交互封装为独立深模块", () => {
  const appSource = readSource("src/App.vue")
  const quickOpenSource = readSource("src/components/QuickOpenDialog.vue")

  assert.match(appSource, /import type \{ QuickOpenSelection \} from '.\/components\/QuickOpenDialog\.vue'/)
  assert.match(appSource, /const QuickOpenDialog = defineAsyncComponent/)
  assert.match(appSource, /<QuickOpenDialog[\s\S]*v-model:visible="quickOpenVisible"[\s\S]*@select="chooseQuickOpenResult"/)
  assert.doesNotMatch(appSource, /function scheduleQuickOpenSearch/)
  assert.doesNotMatch(appSource, /function handleQuickOpenKeydown/)
  assert.match(quickOpenSource, /window\.notesDesktop\.searchNotes/)
  assert.match(quickOpenSource, /notes-quick-open-history/)
  assert.match(quickOpenSource, /<FolderPickerPopover/)
})

test("历史记录将列表、详情、恢复和删除封装为独立深模块", () => {
  const appSource = readSource("src/App.vue")
  const historySource = readSource("src/components/NoteHistoryDialog.vue")

  assert.match(appSource, /const NoteHistoryDialog = defineAsyncComponent/)
  assert.match(appSource, /<NoteHistoryDialog[\s\S]*v-model:visible="historyVisible"[\s\S]*@restored="applyRestoredHistory"/)
  assert.doesNotMatch(appSource, /function loadSelectedHistory/)
  assert.doesNotMatch(appSource, /function deleteSelectedHistory/)
  assert.match(historySource, /window\.notesDesktop\.listNoteHistory/)
  assert.match(historySource, /window\.notesDesktop\.getNoteHistory/)
  assert.match(historySource, /window\.notesDesktop\.restoreNoteHistory/)
  assert.match(historySource, /window\.notesDesktop\.deleteNoteHistory/)
})

test("通用设置将读取、快捷键录入和持久化封装为独立深模块", () => {
  const appSource = readSource("src/App.vue")
  const settingsSource = readSource("src/components/GeneralSettingsDialog.vue")
  const shortcutSource = readSource("src/utils/keyboard-shortcuts.ts")

  assert.match(appSource, /import type \{ GeneralSettingsResult \} from '.\/components\/GeneralSettingsDialog\.vue'/)
  assert.match(appSource, /const GeneralSettingsDialog = defineAsyncComponent/)
  assert.match(appSource, /<GeneralSettingsDialog[\s\S]*v-model:visible="generalSettingsVisible"[\s\S]*@saved="applyGeneralSettings"/)
  assert.doesNotMatch(appSource, /function saveGeneralSettings/)
  assert.match(settingsSource, /window\.notesDesktop\.getQuickCaptureSettings/)
  assert.match(settingsSource, /window\.notesDesktop\.saveQuickCaptureSettings/)
  assert.match(shortcutSource, /export function getShortcutFromEvent/)
  assert.match(shortcutSource, /export function matchesShortcut/)
})

test("Electron IPC channel 与主进程依赖装配分离", () => {
  const mainSource = readSource("electron/main.cjs")
  const ipcSource = readSource("electron/ipc-handlers.cjs")

  assert.match(mainSource, /registerFeatureIpcHandlers\(ipcMain/)
  assert.match(ipcSource, /function registerWorkspaceHandlers/)
  assert.match(ipcSource, /function registerAttachmentHandlers/)
  assert.match(ipcSource, /function registerNoteHandlers/)
  assert.match(ipcSource, /function registerBackupHandlers/)
  assert.match(ipcSource, /function registerSyncHandlers/)
  assert.doesNotMatch(mainSource, /ipcMain\.handle\("note:update"/)
})

test("数据库 schema 迁移与全文搜索不再堆在总仓储", () => {
  const databaseSource = readSource("electron/database.cjs")
  const schemaSource = readSource("electron/database-schema.cjs")
  const searchSource = readSource("electron/database-search.cjs")

  assert.match(databaseSource, /initializeNotesDatabase\(database\)/)
  assert.match(databaseSource, /searchNotesDatabase\(database/)
  assert.match(schemaSource, /CREATE TABLE IF NOT EXISTS notes/)
  assert.match(schemaSource, /CREATE VIRTUAL TABLE IF NOT EXISTS note_search/)
  assert.match(searchSource, /function searchNotes/)
  assert.doesNotMatch(databaseSource, /CREATE TABLE IF NOT EXISTS notes/)
})

test("工作区列表通过本地摘要缓存读取笔记，不扫描完整正文", () => {
  const databaseSource = readSource("electron/database.cjs")
  const listWorkspaceSource = databaseSource.slice(
    databaseSource.indexOf("function listWorkspace()"),
    databaseSource.indexOf("function listFullWorkspace()")
  )

  assert.match(listWorkspaceSource, /JOIN note_previews/)
  assert.doesNotMatch(listWorkspaceSource, /SELECT \* FROM notes/)
  assert.doesNotMatch(listWorkspaceSource, /n\.content\b/)
})
