<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import ConflictDiffViewer from './ConflictDiffViewer.vue'
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

/**
 * 右侧是「看这一版长什么样」还是「看这一版改了什么」。
 *
 * 默认落在对比档：打开历史版本时最常想知道的就是「这一版相对上一版动了哪里」，
 * 与冲突中心把差异视图作为默认档的口径一致。想看完整渲染就切到预览。
 */
const viewMode = ref<'preview' | 'diff'>('diff')

/**
 * 取某条历史记录「更旧的那一条」。
 *
 * 快照存的是「改成这样之后」的正文，因此选中版本与它后面那一条正好构成**这一次改动**。
 * 最旧的一版没有更早的版本可对比，返回 null。
 *
 * @param historyId 历史版本标识。
 * @returns 更旧的一条历史记录，不存在时返回 null。
 */
function findOlderHistory(historyId: string): NoteHistory | null {
  const index = histories.value.findIndex((history) => history.id === historyId)
  return index >= 0 ? (histories.value[index + 1] ?? null) : null
}

/** 对比左侧的基准版本（时间上更旧的一条）。 */
const previousHistory = computed(() =>
  selectedHistoryId.value ? findOlderHistory(selectedHistoryId.value) : null
)

/** 选中版本的正文是否已经取回。 */
const selectedLoaded = computed(
  () => Boolean(selectedHistory.value && loadedHistoryIds.value.has(selectedHistory.value.id))
)

/** 预览档的加载态。 */
const previewLoading = computed(() => detailLoading.value || !selectedLoaded.value)

/**
 * 对比档的加载态：选中版与它的上一版**两边都要**有正文。
 *
 * 缺一边就渲染，会把「还没取回来」的空正文当成真实内容 —— 界面上表现为整篇被标成
 * 新增，看不出是真改动还是没加载。
 */
const compareLoading = computed(() => {
  if (!selectedLoaded.value) return true
  const base = previousHistory.value
  return Boolean(base && !loadedHistoryIds.value.has(base.id))
})

/**
 * 按需把一个历史版本的完整正文取回来并回填列表项。
 *
 * 列表接口只带 480 字摘要（`content` 是空串），正文必须单独取 —— 因此「选中版本」
 * 与「它的上一版」都要经过这里。
 *
 * @param historyId 历史版本标识。
 * @returns 无返回值。
 */
async function ensureHistoryLoaded(historyId: string | null): Promise<void> {
  const noteId = props.noteId
  if (!noteId || !historyId || loadedHistoryIds.value.has(historyId)) return
  const detail = await window.notesDesktop.getNoteHistory(noteId, historyId)
  if (!detail) return
  const index = histories.value.findIndex((history) => history.id === historyId)
  // 弹窗已关闭或该条已被删除时列表会被重置/裁剪，此时直接丢弃这次回填。
  if (index < 0) return
  histories.value[index] = detail
  loadedHistoryIds.value = new Set([...loadedHistoryIds.value, historyId])
}

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
  if (!historyId) return
  detailLoading.value = true
  try {
    await ensureHistoryLoaded(historyId)
    // 对比档要用到「上一版」，顺手一起取：都是本地查询，省一次来回切换的等待。
    await ensureHistoryLoaded(findOlderHistory(historyId)?.id ?? null)
  } finally {
    detailLoading.value = false
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
          <header class="history-preview-head">
            <h3>{{ selectedHistory.title || '无标题笔记' }}</h3>
            <div class="history-view-switch" role="group" aria-label="历史版本查看方式">
              <button
                type="button"
                :class="{ 'is-active': viewMode === 'preview' }"
                :aria-pressed="viewMode === 'preview'"
                @click="viewMode = 'preview'"
              >
                <Icon icon="tabler:eye" />预览
              </button>
              <button
                type="button"
                :class="{ 'is-active': viewMode === 'diff' }"
                :aria-pressed="viewMode === 'diff'"
                @click="viewMode = 'diff'"
              >
                <Icon icon="tabler:git-compare" />对比改动
              </button>
            </div>
          </header>
          <div v-if="viewMode === 'preview' && previewLoading" class="history-empty">正在读取版本内容…</div>
          <div v-else-if="viewMode === 'preview'" class="history-editor-preview">
            <MarkdownVisualEditor :key="selectedHistory.id" :value="selectedHistory.content" readonly :show-toolbar="false" :show-outline="false" />
          </div>
          <div v-else-if="compareLoading" class="history-empty">正在读取版本内容…</div>
          <div v-else class="history-diff">
            <p v-if="!previousHistory" class="history-diff-hint">这是最早的一个版本，没有更早的版本可以对比</p>
            <ConflictDiffViewer
              :left-content="previousHistory?.content ?? ''"
              :right-content="selectedHistory.content"
              :left-label="previousHistory ? '上一版' : '无更早版本'"
              right-label="此版本"
              left-icon="tabler:history"
              right-icon="tabler:file-text"
            />
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
