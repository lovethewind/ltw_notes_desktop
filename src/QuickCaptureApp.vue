<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Icon } from '@iconify/vue'
import type { NoteFolder } from './types'

const title = ref('')
const content = ref('')
const folderId = ref<string | null>(null)
const folders = ref<NoteFolder[]>([])
const shortcut = ref('CommandOrControl+Shift+Space')
const draftShortcut = ref(shortcut.value)
const settingsVisible = ref(false)
const recordingShortcut = ref(false)
const busy = ref(false)
const message = ref('')
const messageIsError = ref(false)
const contentInput = ref<HTMLTextAreaElement | null>(null)
const folderSearchInput = ref<HTMLInputElement | null>(null)
const folderPickerVisible = ref(false)
const folderSearch = ref('')
const highlightedFolderIndex = ref(0)
let disposeFocus: (() => void) | null = null
let disposeOpenSettings: (() => void) | null = null
let disposeEscape: (() => void) | null = null

interface FolderPickerOption {
  id: string | null
  name: string
  depth: number
}

const canSave = computed(() => Boolean(title.value.trim() || content.value.trim()) && !busy.value)
const activeFolders = computed(() => folders.value.filter((folder) => !folder.isDeleted))
const folderOptions = computed<FolderPickerOption[]>(() => [
  { id: null, name: '未分类', depth: 0 },
  ...activeFolders.value.map((folder) => ({
    id: folder.id,
    name: folder.name,
    depth: folderDepth(folder)
  }))
])
const visibleFolderOptions = computed(() => {
  const keyword = folderSearch.value.trim().toLocaleLowerCase()
  return keyword
    ? folderOptions.value.filter((option) => option.name.toLocaleLowerCase().includes(keyword))
    : folderOptions.value
})
const selectedFolderLabel = computed(() => (
  folderOptions.value.find((option) => option.id === folderId.value)?.name || '未分类'
))

/**
 * 计算文件夹在树中的层级深度。
 *
 * :param folder: 目标文件夹。
 * :return: 从零开始的层级深度。
 */
function folderDepth(folder: NoteFolder): number {
  const byId = new Map(activeFolders.value.map((item) => [item.id, item]))
  let depth = 0
  let parentId = folder.parentId
  const visited = new Set<string>()
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId)
    const parent = byId.get(parentId)
    if (!parent) break
    depth += 1
    parentId = parent.parentId
  }
  return depth
}

/**
 * 打开文件夹选择器并聚焦搜索框。
 *
 * :return: 聚焦完成后的 Promise。
 */
async function openFolderPicker(): Promise<void> {
  folderPickerVisible.value = true
  folderSearch.value = ''
  highlightedFolderIndex.value = Math.max(
    0,
    folderOptions.value.findIndex((option) => option.id === folderId.value)
  )
  await nextTick()
  folderSearchInput.value?.focus()
}

/**
 * 选择文件夹并关闭弹层。
 *
 * :param option: 目标文件夹选项。
 * :return: 无返回值。
 */
function selectFolder(option: FolderPickerOption): void {
  folderId.value = option.id
  folderPickerVisible.value = false
  folderSearch.value = ''
  contentInput.value?.focus()
}

/**
 * 更新文件夹搜索词并重置键盘高亮位置。
 *
 * :param event: 搜索输入事件。
 * :return: 无返回值。
 */
function updateFolderSearch(event: Event): void {
  folderSearch.value = (event.target as HTMLInputElement).value
  highlightedFolderIndex.value = 0
}

/**
 * 处理文件夹选择器的方向键、回车和 Escape。
 *
 * :param event: 键盘事件。
 * :return: 无返回值。
 */
function handleFolderPickerKeydown(event: KeyboardEvent): void {
  const options = visibleFolderOptions.value
  if (!options.length) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    event.stopPropagation()
    const offset = event.key === 'ArrowDown' ? 1 : -1
    highlightedFolderIndex.value = (highlightedFolderIndex.value + offset + options.length) % options.length
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    event.stopPropagation()
    selectFolder(options[Math.min(highlightedFolderIndex.value, options.length - 1)])
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    folderPickerVisible.value = false
  }
}

/**
 * 处理快速记录窗口的 Escape 行为。
 *
 * :return: 无返回值。
 */
function handleEscape(): void {
  if (folderPickerVisible.value) {
    folderPickerVisible.value = false
    contentInput.value?.focus()
    return
  }
  void window.notesDesktop.hideQuickCapture()
}

/**
 * 点击选择器外部时关闭文件夹弹层。
 *
 * :return: 无返回值。
 */
function closeFolderPicker(): void {
  folderPickerVisible.value = false
}

function shortcutLabel(value: string): string {
  return value
    .replace('CommandOrControl', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl')
    .replaceAll('Shift', '⇧')
    .replaceAll('Alt', navigator.platform.includes('Mac') ? '⌥' : 'Alt')
    .replaceAll('+', ' ')
}

function shortcutFromKeyboardEvent(event: KeyboardEvent): string | null {
  const ignoredKeys = new Set(['Meta', 'Control', 'Shift', 'Alt'])
  if (ignoredKeys.has(event.key)) return null
  const modifiers: string[] = []
  if (event.metaKey || event.ctrlKey) modifiers.push('CommandOrControl')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')
  if (!modifiers.length) return null
  const aliases: Record<string, string> = {
    ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right'
  }
  const key = aliases[event.key] || (event.key.length === 1 ? event.key.toUpperCase() : event.key)
  return [...modifiers, key].join('+')
}

function recordShortcut(event: KeyboardEvent): void {
  event.preventDefault()
  event.stopPropagation()
  const value = shortcutFromKeyboardEvent(event)
  if (!value) return
  draftShortcut.value = value
  recordingShortcut.value = false
  message.value = ''
}

async function focusCapture(): Promise<void> {
  settingsVisible.value = false
  folderPickerVisible.value = false
  message.value = ''
  messageIsError.value = false
  await refreshData()
  await nextTick()
  contentInput.value?.focus()
}

async function openSettings(): Promise<void> {
  settingsVisible.value = true
  folderPickerVisible.value = false
  recordingShortcut.value = false
  draftShortcut.value = shortcut.value
  message.value = ''
}

async function saveSettings(): Promise<void> {
  busy.value = true
  message.value = ''
  try {
    const settings = await window.notesDesktop.saveQuickCaptureSettings({
      shortcut: draftShortcut.value,
      folderId: folderId.value
    })
    shortcut.value = settings.shortcut
    folderId.value = settings.folderId
    settingsVisible.value = false
    messageIsError.value = false
    message.value = '快捷键已保存'
    await nextTick()
    contentInput.value?.focus()
  } catch (error) {
    messageIsError.value = true
    message.value = error instanceof Error ? error.message : '快捷键保存失败'
  } finally {
    busy.value = false
  }
}

async function saveQuickNote(): Promise<void> {
  if (!canSave.value) return
  busy.value = true
  message.value = ''
  try {
    await window.notesDesktop.createQuickNote({
      title: title.value.trim(),
      content: content.value.trim(),
      folderId: folderId.value
    })
    title.value = ''
    content.value = ''
    messageIsError.value = false
    message.value = ''
    await window.notesDesktop.hideQuickCapture()
  } catch (error) {
    messageIsError.value = true
    message.value = error instanceof Error ? error.message : '保存失败'
  } finally {
    busy.value = false
  }
}

function handleWindowKeydown(event: KeyboardEvent): void {
  if (recordingShortcut.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    handleEscape()
    return
  }
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    void saveQuickNote()
  }
}

async function refreshData(): Promise<void> {
  const [workspace, settings] = await Promise.all([
    window.notesDesktop.listWorkspace(),
    window.notesDesktop.getQuickCaptureSettings()
  ])
  folders.value = workspace.folders
  shortcut.value = settings.shortcut
  draftShortcut.value = settings.shortcut
  folderId.value = workspace.folders.some((folder) => folder.id === settings.folderId && !folder.isDeleted)
    ? settings.folderId
    : null
}

onMounted(async () => {
  window.addEventListener('keydown', handleWindowKeydown)
  window.addEventListener('pointerdown', closeFolderPicker)
  disposeFocus = window.notesDesktop.onQuickCaptureFocus(() => void focusCapture())
  disposeOpenSettings = window.notesDesktop.onOpenQuickCaptureSettings(() => void openSettings())
  disposeEscape = window.notesDesktop.onQuickCaptureEscape(handleEscape)
  await focusCapture()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleWindowKeydown)
  window.removeEventListener('pointerdown', closeFolderPicker)
  disposeFocus?.()
  disposeOpenSettings?.()
  disposeEscape?.()
})
</script>

<template>
  <main class="quick-capture-shell">
    <header class="quick-capture-header">
      <span class="quick-capture-mark"><Icon icon="tabler:bolt" /></span>
      <div><strong>快速记录</strong><small>{{ shortcutLabel(shortcut) }}</small></div>
      <button type="button" :aria-label="settingsVisible ? '返回记录' : '快捷键设置'" @click="settingsVisible ? focusCapture() : openSettings()">
        <Icon :icon="settingsVisible ? 'tabler:arrow-left' : 'tabler:settings'" />
      </button>
    </header>

    <section v-if="settingsVisible" class="quick-capture-settings">
      <div>
        <h2>自定义快捷键</h2>
        <p>点击下方区域，再按下包含 Command、Ctrl 或 Option 的组合键。</p>
      </div>
      <button
        :class="['shortcut-recorder', { recording: recordingShortcut }]"
        type="button"
        @click="recordingShortcut = true"
        @keydown="recordShortcut"
      >
        <span>{{ recordingShortcut ? '请按下新的组合键…' : shortcutLabel(draftShortcut) }}</span>
        <small>{{ recordingShortcut ? '正在录入' : '点击修改' }}</small>
      </button>
      <div class="quick-capture-actions">
        <button type="button" @click="focusCapture">取消</button>
        <button class="primary" type="button" :disabled="busy" @click="saveSettings">保存快捷键</button>
      </div>
    </section>

    <form v-else class="quick-capture-form" @submit.prevent="saveQuickNote">
      <input v-model="title" class="quick-title" maxlength="100" placeholder="标题（可选，留空将从正文生成）" />
      <textarea ref="contentInput" v-model="content" class="quick-content" placeholder="现在想到什么？" />
      <footer>
        <div class="quick-folder-picker" @pointerdown.stop>
          <button
            class="quick-folder-trigger"
            type="button"
            :aria-expanded="folderPickerVisible"
            aria-haspopup="listbox"
            @click="folderPickerVisible ? closeFolderPicker() : openFolderPicker()"
          >
          <Icon icon="tabler:folder" />
            <span>{{ selectedFolderLabel }}</span>
            <Icon icon="tabler:chevron-down" />
          </button>
          <div v-if="folderPickerVisible" class="quick-folder-popover" @keydown="handleFolderPickerKeydown">
            <label class="quick-folder-search">
              <Icon icon="tabler:search" />
              <input
                ref="folderSearchInput"
                :value="folderSearch"
                placeholder="搜索文件夹"
                @input="updateFolderSearch"
              />
            </label>
            <div class="quick-folder-options" role="listbox" aria-label="选择文件夹">
              <button
                v-for="(option, index) in visibleFolderOptions"
                :key="option.id || 'unclassified'"
                :class="['quick-folder-option', { selected: option.id === folderId, highlighted: index === highlightedFolderIndex }]"
                type="button"
                role="option"
                :aria-selected="option.id === folderId"
                :style="{ '--folder-depth': option.depth }"
                @mouseenter="highlightedFolderIndex = index"
                @click="selectFolder(option)"
              >
                <Icon :icon="option.id ? 'tabler:folder' : 'tabler:folder-question'" />
                <span>{{ option.name }}</span>
                <Icon v-if="option.id === folderId" icon="tabler:check" />
              </button>
              <p v-if="!visibleFolderOptions.length">没有匹配的文件夹</p>
            </div>
          </div>
        </div>
        <span class="quick-save-hint">⌘ Enter 保存</span>
        <button class="primary" type="submit" :disabled="!canSave">{{ busy ? '保存中…' : '保存' }}</button>
      </footer>
    </form>

    <p v-if="message" :class="['quick-capture-message', { error: messageIsError }]">{{ message }}</p>
  </main>
</template>
