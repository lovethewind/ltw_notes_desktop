<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="note-link-picker-backdrop"
      @click.self="emit('close')"
    >
      <section
        class="note-link-picker"
        role="dialog"
        aria-modal="true"
        :aria-label="props.title"
      >
        <header class="note-link-picker__header">
          <Icon class="note-link-picker__search-icon" icon="tabler:search" />
          <input
            ref="searchInputRef"
            v-model="keyword"
            class="note-link-picker__search"
            type="text"
            placeholder="搜索笔记标题…"
            aria-label="搜索笔记"
            @keydown="handleKeydown"
          >
          <button
            type="button"
            class="note-link-picker__close"
            aria-label="关闭"
            @click="emit('close')"
          >
            <Icon icon="material-symbols:close-rounded" />
          </button>
        </header>
        <ul v-if="rows.length" class="note-link-picker__list" role="listbox">
          <li
            v-for="(row, index) in rows"
            :key="row.note.id"
            :class="['note-link-picker__item', { 'is-active': index === activeIndex }]"
            role="option"
            :aria-selected="index === activeIndex"
            @mouseenter="activeIndex = index"
            @click="choose(row.note)"
          >
            <Icon class="note-link-picker__icon" icon="tabler:file-text" />
            <span class="note-link-picker__main">
              <strong class="note-link-picker__title">{{ row.note.title || '（无标题）' }}</strong>
              <small class="note-link-picker__excerpt">{{ row.excerpt || '暂无正文内容' }}</small>
            </span>
            <span class="note-link-picker__meta">
              <em class="note-link-picker__path">{{ row.folderPath }}</em>
              <small v-if="row.note.tags.length" class="note-link-picker__tags">
                {{ row.note.tags.map((tag) => tag.name).join('、') }}
              </small>
            </span>
          </li>
        </ul>
        <p v-else class="note-link-picker__empty">
          {{ keyword.trim() ? '未找到匹配的笔记' : '输入关键词搜索笔记' }}
        </p>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { computed, nextTick, ref, watch } from 'vue'
import { formatNoteExcerpt } from '../utils/note-workspace'
import type { NoteFolder, OfflineNote } from '../types'

interface NoteLinkRow {
  note: OfflineNote
  excerpt: string
  folderPath: string
}

const props = withDefaults(defineProps<{
  visible: boolean
  title?: string
  /** 未输入关键词时展示的全部笔记（应来自当前工作区）。为空数组时回退为「输入关键词搜索」。 */
  allNotes?: OfflineNote[]
  /** 文件夹树，用于把 folderId 解析成展示用的完整路径。 */
  folders?: NoteFolder[]
}>(), {
  title: '插入笔记链接',
  allNotes: () => [],
  folders: () => []
})
const emit = defineEmits<{
  (event: 'close'): void
  (event: 'select', noteId: string, serverId: string | null, title: string): void
}>()

const keyword = ref('')
const results = ref<OfflineNote[]>([])
const activeIndex = ref(0)
const searchInputRef = ref<HTMLInputElement | null>(null)
let searchToken = 0

/** 生成笔记所在文件夹的完整路径（与快速打开一致的算法，遇到已删文件夹即止）。 */
function getFolderPath(noteFolderId: string | null, folderById: Map<string, NoteFolder>): string {
  if (!noteFolderId) return '未分类'
  const names: string[] = []
  const visited = new Set<string>()
  let currentId: string | null = noteFolderId
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId)
    const folder = folderById.get(currentId)
    if (!folder || folder.isDeleted) break
    names.unshift(folder.name)
    currentId = folder.parentId
  }
  return names.join(' / ') || '未分类'
}

/** 把候选笔记补上摘要与文件夹路径，供列表像快速打开那样展示。 */
const rows = computed<NoteLinkRow[]>(() => {
  const folderById = new Map(props.folders.map((folder) => [folder.id, folder]))
  return results.value.map((note) => ({
    note,
    excerpt: formatNoteExcerpt(note.content || ''),
    folderPath: getFolderPath(note.folderId, folderById)
  }))
})

/**
 * 无关键词时的默认候选：与 Cmd+O（快速打开）空搜索一致的「最近更新的笔记」排序，
 * 即忽略置顶与其余打分，仅按 updatedAt 降序，取前若干条。
 */
function recentNotes(): OfflineNote[] {
  return props.allNotes
    .filter((note) => !note.isDeleted)
    .slice()
    .sort(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        left.id.localeCompare(right.id)
    )
    .slice(0, 50)
}

async function runSearch(): Promise<void> {
  const token = ++searchToken
  const text = keyword.value.trim()
  if (!text) {
    results.value = recentNotes()
    activeIndex.value = 0
    return
  }
  try {
    const notes = await window.notesDesktop.searchNotes(text, { limit: 50 })
    if (token !== searchToken) return
    results.value = notes.filter((note) => !note.isDeleted).slice(0, 50)
    activeIndex.value = 0
  } catch {
    if (token === searchToken) results.value = []
  }
}

watch(keyword, () => {
  void runSearch()
})

watch(
  () => props.visible,
  async (open) => {
    if (!open) return
    keyword.value = ''
    activeIndex.value = 0
    // 未搜索时若提供全量笔记则直接展示「最近更新」候选，而不是等用户输入。
    results.value = recentNotes()
    await nextTick()
    searchInputRef.value?.focus()
  }
)

function choose(note: OfflineNote): void {
  emit('select', note.id, note.serverId ?? null, note.title || '（无标题）')
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (results.value.length) {
      activeIndex.value = (activeIndex.value + 1) % results.value.length
    }
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    if (results.value.length) {
      activeIndex.value = (activeIndex.value - 1 + results.value.length) % results.value.length
    }
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const note = results.value[activeIndex.value]
    if (note) choose(note)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  }
}
</script>

<style scoped>
.note-link-picker-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 14vh;
  background: rgba(15, 23, 42, 0.32);
}

.note-link-picker {
  width: min(560px, calc(100vw - 32px));
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  background: var(--surface-solid, #fff);
  border: 1px solid var(--line, #dce5f0);
  border-radius: 14px;
  box-shadow: 0 18px 48px rgba(20, 36, 58, 0.22);
  overflow: hidden;
}

.note-link-picker__header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line, #dce5f0);
}

.note-link-picker__search-icon {
  color: var(--muted, #78869b);
  font-size: 18px;
  flex-shrink: 0;
}

.note-link-picker__search {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font-size: 14px;
  color: var(--ink, #18243a);
}

.note-link-picker__close {
  display: inline-flex;
  border: none;
  background: transparent;
  color: var(--muted, #78869b);
  cursor: pointer;
  padding: 4px;
  border-radius: 8px;
  flex-shrink: 0;
}

.note-link-picker__close:hover {
  background: var(--panel, #f7faff);
}

.note-link-picker__list {
  list-style: none;
  margin: 0;
  padding: 6px;
  max-height: min(56vh, 460px);
  overflow-y: auto;
}

.note-link-picker__item {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 10px 11px;
  border-radius: 10px;
  cursor: pointer;
}

.note-link-picker__item.is-active {
  background: var(--blue, #2f80ed);
  color: #fff;
}

.note-link-picker__icon {
  width: 18px;
  height: 18px;
  color: var(--blue, #2f80ed);
}

.note-link-picker__main {
  min-width: 0;
}

.note-link-picker__title {
  display: block;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-link-picker__excerpt {
  display: block;
  margin-top: 3px;
  font-size: 12px;
  color: var(--muted, #78869b);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-link-picker__meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
  min-width: 0;
  max-width: 180px;
}

.note-link-picker__path {
  font-size: 11px;
  font-style: normal;
  color: var(--muted, #78869b);
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-link-picker__tags {
  font-size: 11px;
  opacity: 0.7;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}

/* 选中态为实心蓝底白字，次级信息改用白色半透明保证可读。 */
.note-link-picker__item.is-active .note-link-picker__icon,
.note-link-picker__item.is-active .note-link-picker__excerpt,
.note-link-picker__item.is-active .note-link-picker__path {
  color: rgba(255, 255, 255, 0.85);
}

.note-link-picker__empty {
  margin: 0;
  padding: 22px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--muted, #78869b);
}
</style>
