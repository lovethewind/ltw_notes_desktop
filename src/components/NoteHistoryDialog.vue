<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import { formatNoteUpdatedTime } from '../utils/note-workspace'
import type { NoteHistory, OfflineNote } from '../types'

// 历史列表先展示轻量结构，只有选中版本需要预览时才加载编辑器。
const MarkdownVisualEditor = defineAsyncComponent(() => import('./MarkdownVisualEditor.vue'))

const props = defineProps<{
  noteId: string | null
  confirm: (title: string, message: string, confirmLabel: string) => Promise<boolean>
}>()

const emit = defineEmits<{
  restored: [note: OfflineNote]
}>()

const visible = defineModel<boolean>('visible', { required: true })
const histories = ref<NoteHistory[]>([])
const selectedHistoryId = ref<string | null>(null)
const loadedHistoryIds = ref<Set<string>>(new Set())
const listLoading = ref(false)
const detailLoading = ref(false)
const operationBusy = ref(false)
const selectedHistory = computed(() => histories.value.find((history) => history.id === selectedHistoryId.value) ?? null)

/** 打开时读取轻量历史列表，并仅按需加载首个版本正文。 */
async function loadHistories(): Promise<void> {
  if (!props.noteId) return
  listLoading.value = true
  try {
    histories.value = await window.notesDesktop.listNoteHistory(props.noteId)
    selectedHistoryId.value = histories.value[0]?.id ?? null
  } finally {
    listLoading.value = false
  }
  await loadSelectedHistory(selectedHistoryId.value)
}

/** 按需获取一个历史版本的完整正文，防止列表一次加载大量内容。 */
async function loadSelectedHistory(historyId: string | null): Promise<void> {
  const noteId = props.noteId
  if (!noteId || !historyId) return
  if (loadedHistoryIds.value.has(historyId)) return
  detailLoading.value = true
  try {
    const detail = await window.notesDesktop.getNoteHistory(noteId, historyId)
    if (!detail || selectedHistoryId.value !== historyId) return
    const index = histories.value.findIndex((history) => history.id === historyId)
    if (index >= 0) {
      histories.value[index] = detail
      loadedHistoryIds.value = new Set([...loadedHistoryIds.value, historyId])
    }
  } finally {
    if (selectedHistoryId.value === historyId) detailLoading.value = false
  }
}

async function selectHistory(historyId: string): Promise<void> {
  selectedHistoryId.value = historyId
  await loadSelectedHistory(historyId)
}

async function restoreSelectedHistory(): Promise<void> {
  const noteId = props.noteId
  if (!noteId || !selectedHistoryId.value || operationBusy.value) return
  const confirmed = await props.confirm(
    '恢复历史版本？',
    '当前内容会先保存为一条历史记录，然后替换为所选版本。',
    '恢复版本'
  )
  if (!confirmed) return
  operationBusy.value = true
  try {
    const restored = await window.notesDesktop.restoreNoteHistory(noteId, selectedHistoryId.value)
    if (!restored) return
    visible.value = false
    emit('restored', restored)
  } finally {
    operationBusy.value = false
  }
}

async function deleteSelectedHistory(): Promise<void> {
  const noteId = props.noteId
  if (!noteId || !selectedHistoryId.value || operationBusy.value) return
  const confirmed = await props.confirm(
    '删除历史版本？',
    '这条历史记录会从已同步设备中删除，删除后无法恢复。',
    '删除版本'
  )
  if (!confirmed) return
  operationBusy.value = true
  try {
    await window.notesDesktop.deleteNoteHistory(noteId, selectedHistoryId.value)
    histories.value = histories.value.filter((history) => history.id !== selectedHistoryId.value)
    loadedHistoryIds.value = new Set(
      [...loadedHistoryIds.value].filter((historyId) => historyId !== selectedHistoryId.value)
    )
    selectedHistoryId.value = histories.value[0]?.id ?? null
    await loadSelectedHistory(selectedHistoryId.value)
  } finally {
    operationBusy.value = false
  }
}

watch(visible, (isVisible) => {
  if (isVisible) void loadHistories()
  else {
    histories.value = []
    selectedHistoryId.value = null
    loadedHistoryIds.value = new Set()
    detailLoading.value = false
  }
})
</script>

<template>
  <div v-if="visible" class="dialog-backdrop" @click.self="visible = false">
    <section class="history-dialog" role="dialog" aria-modal="true" aria-label="笔记历史记录">
      <header>
        <div><Icon icon="tabler:history" /><div><h2>历史记录</h2><p>最多保留 50 个同步版本</p></div></div>
        <button type="button" aria-label="关闭历史记录" :disabled="operationBusy" @click="visible = false"><Icon icon="tabler:x" /></button>
      </header>
      <div v-if="listLoading" class="history-empty">正在读取历史记录…</div>
      <div v-else-if="!histories.length" class="history-empty">修改正文后会自动生成历史版本</div>
      <div v-else class="history-layout">
        <aside class="history-list">
          <button v-for="history in histories" :key="history.id" :class="{ active: history.id === selectedHistoryId }" type="button" @click="selectHistory(history.id)">
            <strong>{{ history.title || '无标题笔记' }}</strong><small>{{ history.contentPreview }}</small><time>{{ formatNoteUpdatedTime(history.createdAt) }}</time>
          </button>
        </aside>
        <article v-if="selectedHistory" class="history-preview">
          <h3>{{ selectedHistory.title || '无标题笔记' }}</h3>
          <div v-if="detailLoading || !loadedHistoryIds.has(selectedHistory.id)" class="history-empty">正在读取版本内容…</div>
          <div v-else class="history-editor-preview">
            <MarkdownVisualEditor :key="selectedHistory.id" :value="selectedHistory.content" readonly :show-toolbar="false" :show-outline="false" />
          </div>
        </article>
      </div>
      <footer>
        <button class="danger" type="button" :disabled="!selectedHistory || operationBusy" @click="deleteSelectedHistory">删除版本</button>
        <button class="primary" type="button" :disabled="!selectedHistory || operationBusy" @click="restoreSelectedHistory">恢复此版本</button>
      </footer>
    </section>
  </div>
</template>
