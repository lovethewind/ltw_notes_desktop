<template>
  <div class="note-embed-card" :class="{ 'is-deleted': deleted, 'is-loading': loading }" role="button" tabindex="0" @click="open" @keydown.enter="open" @keydown.space.prevent="open">
    <template v-if="loading">
      <Icon class="note-embed-card__icon note-embed-card__icon--spin" icon="material-symbols:progress-activity-rounded" />
      <span class="note-embed-card__title note-embed-card__title--placeholder">正在加载笔记…</span>
    </template>

    <template v-else-if="deleted || missing">
      <Icon class="note-embed-card__icon note-embed-card__icon--missing" icon="material-symbols:error-outline-rounded" />
      <div class="note-embed-card__body">
        <span class="note-embed-card__title note-embed-card__title--missing">{{ fallbackTitle || '（笔记不可用）' }}</span>
        <span class="note-embed-card__hint">{{ deleted ? '此笔记已被删除或移入回收站' : '此笔记不存在' }}</span>
      </div>
    </template>

    <template v-else>
      <div class="note-embed-card__body">
        <span v-if="folderName" class="note-embed-card__meta">
          <Icon icon="material-symbols:folder-outline-rounded" />{{ folderName }}
        </span>
        <span class="note-embed-card__title">{{ title }}</span>
        <span v-if="excerpt" class="note-embed-card__excerpt">{{ excerpt }}</span>
        <span class="note-embed-card__meta note-embed-card__meta--time">
          <Icon icon="material-symbols:schedule-rounded" />{{ formatDate(updatedAt) }}
        </span>
      </div>
      <Icon class="note-embed-card__arrow" icon="material-symbols:arrow-forward-rounded" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import type { NoteFolder, OfflineNote } from '../types'
import { dispatchOpenNote } from '../utils/note-open-events'

const props = withDefaults(defineProps<{ noteId: string; title?: string | null }>(), {
  title: null
})

const loading = ref(true)
const deleted = ref(false)
const missing = ref(false)
const note = ref<OfflineNote | null>(null)
const folders = ref<NoteFolder[]>([])

const title = ref<string>('')
const folderName = ref<string>('')
const updatedAt = ref<string>('')
const excerpt = ref<string>('')

const fallbackTitle = props.title && props.title.trim() ? props.title : ''

async function loadCard(): Promise<void> {
  loading.value = true
  deleted.value = false
  missing.value = false
  note.value = null
  try {
    if (!folders.value.length) {
      const workspace = await window.notesDesktop.listWorkspace().catch(() => null)
      folders.value = workspace?.folders || []
    }
    const target = await window.notesDesktop.getNote(props.noteId)
    if (!target) {
      missing.value = true
      return
    }
    if (target.isDeleted) {
      deleted.value = true
      return
    }
    note.value = target
    title.value = target.title || fallbackTitle || '（无标题）'
    folderName.value = folders.value.find((f) => f.id === target.folderId)?.name || ''
    updatedAt.value = target.updatedAt || ''
    excerpt.value = stripMarkdown(target.content).slice(0, 160)
  } catch {
    missing.value = true
  } finally {
    loading.value = false
  }
}

function stripMarkdown(raw: string): string {
  // 轻量去 markdown 记号，仅用于摘要展示；不解析 data-xynote-embed，避免递归。
  if (!raw) return ''
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // 图片 → alt 文本
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接 → 文本
    .replace(/<[^>]+>/g, ' ') // 残留 HTML 标签 → 空格（含 data-xynote-embed 容器）
    .replace(/[#>*_`~|-]{1,}/g, ' ') // markdown 记号
    .replace(/\s+/g, ' ')
    .trim()
}

function formatDate(value: string): string {
  if (!value) return ''
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value)
  return match ? match[0].replace(/-/g, '.') : ''
}

function open(): void {
  if (loading.value || missing.value || deleted.value) return
  // 点击卡片 → 在新标签页打开目标笔记，保留当前阅读上下文（由 App.vue 路由到 openNoteInNewTab）。
  dispatchOpenNote(props.noteId, true)
}

watch(() => props.noteId, loadCard)
onMounted(loadCard)
</script>

<style scoped>
.note-embed-card {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel);
  cursor: pointer;
  text-align: left;
  user-select: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
}
.note-embed-card:hover {
  border-color: var(--blue);
  background: var(--surface);
  box-shadow: 0 4px 16px rgba(47, 128, 237, 0.1);
}
.note-embed-card:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}

.note-embed-card__body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}

.note-embed-card__title {
  overflow: hidden;
  color: var(--ink);
  font-size: 14px;
  font-weight: 680;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.note-embed-card__title--missing {
  color: var(--muted);
  font-weight: 600;
}

.note-embed-card__excerpt {
  overflow: hidden;
  color: var(--muted);
  font-size: 12px;
  line-height: 18px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.note-embed-card__meta {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--muted);
  font-size: 11px;
}
.note-embed-card__meta svg {
  width: 12px;
  height: 12px;
}
.note-embed-card__meta--time {
  color: var(--muted);
}

.note-embed-card__hint {
  color: var(--muted);
  font-size: 12px;
  line-height: 18px;
}

.note-embed-card__icon {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  color: var(--blue);
}
.note-embed-card__icon--missing {
  color: var(--muted);
}
.note-embed-card__icon--spin {
  animation: note-embed-card-spin 1s linear infinite;
}

.note-embed-card__arrow {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  color: var(--muted);
  transition: color 0.15s ease, transform 0.15s ease;
}
.note-embed-card:hover .note-embed-card__arrow {
  color: var(--blue);
  transform: translateX(2px);
}

@keyframes note-embed-card-spin {
  to { transform: rotate(360deg); }
}
</style>
