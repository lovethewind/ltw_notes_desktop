<script setup lang="ts">
import { ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import { formatShortcut, getShortcutFromEvent } from '../utils/keyboard-shortcuts'
import type { NoteSortOrder } from '../types'

export interface GeneralSettingsResult {
  quickOpenShortcut: string
  showTreeLines: boolean
  noteSortOrder: NoteSortOrder
}

const props = defineProps<{
  quickOpenShortcut: string
  showTreeLines: boolean
  noteSortOrder: NoteSortOrder
}>()

const emit = defineEmits<{
  saved: [settings: GeneralSettingsResult]
}>()

const visible = defineModel<boolean>('visible', { required: true })
const saving = ref(false)
const message = ref('')
const generalShortcutRecording = ref(false)
const quickOpenShortcutRecording = ref(false)
const generalShortcut = ref('CommandOrControl+Shift+Space')
const quickCaptureFolderId = ref<string | null>(null)
const draftQuickOpenShortcut = ref(props.quickOpenShortcut)
const draftShowTreeLines = ref(props.showTreeLines)
const draftNoteSortOrder = ref<NoteSortOrder>(props.noteSortOrder)

/** 笔记列表排序选项，供主列表与文件夹树统一使用。 */
const sortOptions: Array<{ value: NoteSortOrder, label: string }> = [
  { value: 'updated', label: '最近更新' },
  { value: 'created', label: '创建时间' },
  { value: 'title', label: '标题' }
]

/** 每次打开都读取桌面主进程中的快速记录设置，避免展示过期值。 */
async function loadSettings(): Promise<void> {
  message.value = ''
  generalShortcutRecording.value = false
  quickOpenShortcutRecording.value = false
  draftQuickOpenShortcut.value = props.quickOpenShortcut
  draftShowTreeLines.value = props.showTreeLines
  draftNoteSortOrder.value = props.noteSortOrder
  try {
    const settings = await window.notesDesktop.getQuickCaptureSettings()
    generalShortcut.value = settings.shortcut
    quickCaptureFolderId.value = settings.folderId
  } catch (error) {
    message.value = error instanceof Error ? error.message : '通用设置加载失败'
  }
}

function recordShortcut(event: KeyboardEvent, target: 'capture' | 'open'): void {
  event.preventDefault()
  event.stopPropagation()
  const shortcut = getShortcutFromEvent(event)
  if (!shortcut) return
  if (target === 'capture') {
    generalShortcut.value = shortcut
    generalShortcutRecording.value = false
  } else {
    draftQuickOpenShortcut.value = shortcut
    quickOpenShortcutRecording.value = false
  }
  message.value = ''
}

/** 保存后把仅由渲染进程使用的显示设置一次性交回主页面应用。 */
async function saveSettings(): Promise<void> {
  if (saving.value) return
  saving.value = true
  message.value = ''
  try {
    await window.notesDesktop.saveQuickCaptureSettings({
      shortcut: generalShortcut.value,
      folderId: quickCaptureFolderId.value
    })
    window.localStorage.setItem('notes-show-tree-lines', String(draftShowTreeLines.value))
    window.localStorage.setItem('notes-quick-open-shortcut', draftQuickOpenShortcut.value)
    window.localStorage.setItem('notes-note-sort-order', draftNoteSortOrder.value)
    emit('saved', {
      quickOpenShortcut: draftQuickOpenShortcut.value,
      showTreeLines: draftShowTreeLines.value,
      noteSortOrder: draftNoteSortOrder.value
    })
    visible.value = false
  } catch (error) {
    message.value = error instanceof Error ? error.message : '通用设置保存失败'
  } finally {
    saving.value = false
  }
}

watch(visible, (isVisible) => {
  if (isVisible) void loadSettings()
})
</script>

<template>
  <div v-if="visible" class="dialog-backdrop" @click.self="visible = false">
    <form class="folder-dialog general-settings-dialog" aria-label="通用设置" @submit.prevent="saveSettings">
      <button class="dialog-close-button" type="button" aria-label="关闭通用设置" :disabled="saving" @click="visible = false"><Icon icon="tabler:x" /></button>
      <div class="dialog-icon"><Icon icon="tabler:settings" /></div>
      <h2>通用设置</h2><p>配置快速记录和笔记列表的显示方式。</p>
      <div class="general-settings-list">
        <section class="general-setting-item">
          <div><strong>快速记录快捷键</strong><small>在其他应用中也可以呼出快速记录窗口</small></div>
          <button :class="['general-shortcut-recorder', { recording: generalShortcutRecording }]" type="button" @click="generalShortcutRecording = true" @keydown="recordShortcut($event, 'capture')">{{ generalShortcutRecording ? '请按快捷键…' : formatShortcut(generalShortcut) }}</button>
        </section>
        <section class="general-setting-item">
          <div><strong>快速打开快捷键</strong><small>仅在心悦笔记处于前台时搜索整个笔记库</small></div>
          <button :class="['general-shortcut-recorder', { recording: quickOpenShortcutRecording }]" type="button" @click="quickOpenShortcutRecording = true" @keydown="recordShortcut($event, 'open')">{{ quickOpenShortcutRecording ? '请按快捷键…' : formatShortcut(draftQuickOpenShortcut) }}</button>
        </section>
        <section class="general-setting-item">
          <div><strong>文件夹树连接线</strong><small>显示侧边栏文件夹层级之间的辅助线</small></div>
          <button :class="['general-setting-switch', { active: draftShowTreeLines }]" type="button" role="switch" :aria-checked="draftShowTreeLines" @click="draftShowTreeLines = !draftShowTreeLines"><span></span></button>
        </section>
        <section class="general-setting-item">
          <div><strong>笔记列表排序</strong><small>决定主列表与文件夹树中的笔记顺序</small></div>
          <select v-model="draftNoteSortOrder" class="general-setting-select" aria-label="笔记列表排序">
            <option v-for="option in sortOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </section>
      </div>
      <p v-if="message" class="general-settings-message">{{ message }}</p>
      <div class="general-settings-actions">
        <button type="button" :disabled="saving" @click="visible = false">取消</button>
        <button class="primary" type="submit" :disabled="saving">{{ saving ? '保存中…' : '保存设置' }}</button>
      </div>
    </form>
  </div>
</template>
