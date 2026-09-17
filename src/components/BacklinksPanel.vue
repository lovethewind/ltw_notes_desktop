<template>
  <div v-if="hasItems" class="backlinks-list">
    <template v-for="group in groups" :key="group.key">
      <h3 class="backlinks-group__title">
        <Icon :icon="group.icon" />
        {{ group.label }}<span class="backlinks-badge">{{ group.notes.length }}</span>
      </h3>
      <button
        v-for="note in group.notes"
        :key="`${group.key}-${note.id}`"
        type="button"
        class="backlinks-item"
        @click="openNote(note.id)"
      >
        <span class="backlinks-item__title">{{ note.title || '（无标题）' }}</span>
        <span class="backlinks-item__meta">
          <span v-if="folderName(note.folderId)" class="backlinks-item__meta-text">
            <Icon icon="material-symbols:folder-outline-rounded" />{{ folderName(note.folderId) }}
          </span>
          <span class="backlinks-item__meta-text">
            <Icon icon="material-symbols:schedule-rounded" />{{ formatDate(note.updatedAt) }}
          </span>
        </span>
        <Icon class="backlinks-item__arrow" icon="material-symbols:arrow-forward-rounded" />
      </button>
    </template>
  </div>
  <div v-else class="backlinks-empty">
    <Icon class="backlinks-empty__icon" icon="material-symbols:link-off-rounded" />
    <p>还没有关联笔记</p>
    <span>在其它笔记里链接到本篇，或在本篇里插入指向别处的链接</span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import type { BacklinkNote, NoteFolder } from '../types'
import { dispatchOpenNote } from '../utils/note-open-events'

const props = defineProps<{ noteId?: string }>()
/** 入边：正文里显式链接到本篇的笔记。 */
const links = ref<BacklinkNote[]>([])
/** 出边：本篇正文里显式链接出去的笔记。 */
const outlinks = ref<BacklinkNote[]>([])
const folders = ref<NoteFolder[]>([])

/**
 * 关系分组清单。方向靠标题与图标区分，空分组不渲染（避免出现「0 条」的空壳分组）。
 */
const groups = computed(() => [
  { key: 'in', label: '引用了本篇', icon: 'material-symbols:call-received-rounded', notes: links.value },
  { key: 'out', label: '本篇引用', icon: 'material-symbols:call-made-rounded', notes: outlinks.value }
].filter((group) => group.notes.length > 0))

const hasItems = computed(() => links.value.length > 0 || outlinks.value.length > 0)

async function loadContext(): Promise<void> {
  try {
    const workspace = await window.notesDesktop.listWorkspace()
    folders.value = workspace.folders || []
  } catch {
    folders.value = []
  }
}

watch(
  () => props.noteId,
  async (id) => {
    links.value = []
    outlinks.value = []
    if (!id) return
    await loadContext()
    const [inResult, outResult] = await Promise.allSettled([
      window.notesDesktop.getNoteBacklinks(id),
      window.notesDesktop.getNoteOutlinks(id)
    ])
    if (inResult.status === 'fulfilled') links.value = inResult.value
    if (outResult.status === 'fulfilled') outlinks.value = outResult.value
  },
  { immediate: true }
)

function folderName(folderId: string | null): string {
  if (!folderId) return ''
  return folders.value.find((item) => item.id === folderId)?.name || ''
}

function formatDate(value: string): string {
  if (!value) return ''
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value)
  return match ? match[0].replace(/-/g, '.') : ''
}

/**
 * 打开列表项对应的笔记。
 *
 * 固定走「新标签页打开」：关系列表是旁路查阅场景——点进去看被关联的那篇，看完还要
 * 回到当前这篇继续读，原地切换会把阅读上下文顶掉（与嵌入卡片、正文内部链接一致）。
 * 不用 IPC `openNoteLink`：那条链路是原地切换，且仍被深链 / 站内链接复用，语义不动。
 *
 * :param noteId: 目标笔记 ID。
 * :return: 无返回值。
 */
function openNote(noteId: string): void {
  dispatchOpenNote(noteId, true)
}
</script>

<style scoped>
.backlinks-list {
  display: grid;
  gap: 8px;
  padding: 6px 10px 20px;
}

.backlinks-group__title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 4px 2px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
}

.backlinks-group__title svg {
  width: 14px;
  height: 14px;
  color: var(--blue);
}

.backlinks-badge {
  min-width: 18px;
  padding: 1px 6px;
  border-radius: 99px;
  background: #eaf3ff;
  color: var(--blue);
  font-size: 10px;
  font-weight: 700;
  text-align: center;
}

.backlinks-item {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px 12px;
  width: 100%;
  padding: 9px 12px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
}

.backlinks-item:hover {
  background: #edf5ff;
  border-color: #dceafa;
}

.backlinks-item:active {
  transform: translateY(1px);
}

.backlinks-item__title {
  grid-column: 1;
  overflow: hidden;
  color: var(--ink);
  font-size: 13px;
  font-weight: 640;
  line-height: 19px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.backlinks-item__meta {
  grid-column: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 12px;
}

.backlinks-item__meta-text {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: #96a1b0;
  font-size: 11px;
}

.backlinks-item__meta-text svg {
  width: 12px;
  height: 12px;
}

/* 箭头跨满标题 + 元信息两行，垂直居中（-1 跟随实际行数，避免留出空行）。 */
.backlinks-item__arrow {
  grid-column: 2;
  grid-row: 1 / -1;
  align-self: center;
  width: 16px;
  height: 16px;
  color: #b7c2d0;
  transition: transform 0.15s ease, color 0.15s ease;
}

.backlinks-item:hover .backlinks-item__arrow {
  color: var(--blue);
  transform: translateX(2px);
}

.backlinks-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 24px 16px 20px;
  text-align: center;
}

.backlinks-empty__icon {
  width: 26px;
  height: 26px;
  color: #c2cbd7;
}

.backlinks-empty p {
  margin: 0;
  color: #98a5b5;
  font-size: 13px;
  font-weight: 600;
}

.backlinks-empty span {
  color: #b3bdc9;
  font-size: 11px;
}
</style>
