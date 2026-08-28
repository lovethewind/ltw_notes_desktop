<template>
  <div v-if="hasItems" class="backlinks-list">
    <template v-if="links.length">
      <h3 class="backlinks-group__title">
        <Icon icon="material-symbols:link-rounded" />
        链接引用<span class="backlinks-badge">{{ links.length }}</span>
      </h3>
      <button
        v-for="note in links"
        :key="`link-${note.id}`"
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

    <template v-if="mentions.length">
      <h3 class="backlinks-group__title">
        <Icon icon="material-symbols:chat-rounded" />
        提及<span class="backlinks-badge">{{ mentions.length }}</span>
      </h3>
      <button
        v-for="note in mentions"
        :key="`mention-${note.id}`"
        type="button"
        class="backlinks-item backlinks-item--mention"
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
        <p class="backlinks-item__excerpt">
          <template v-for="(segment, index) in highlightSegments(note.excerpt, note.title)" :key="index">
            <mark v-if="segment.hit">{{ segment.text }}</mark>
            <template v-else>{{ segment.text }}</template>
          </template>
        </p>
        <Icon class="backlinks-item__arrow" icon="material-symbols:arrow-forward-rounded" />
      </button>
    </template>
  </div>
  <div v-else class="backlinks-empty">
    <Icon class="backlinks-empty__icon" icon="material-symbols:link-off-rounded" />
    <p>还没有笔记引用或提及此笔记</p>
    <span>在其它笔记里插入链接，或提到它的标题即可关联到这里</span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import type { BacklinkNote, MentionNote, NoteFolder } from '../types'

const props = defineProps<{ noteId?: string }>()
const links = ref<BacklinkNote[]>([])
const mentions = ref<MentionNote[]>([])
const folders = ref<NoteFolder[]>([])

const hasItems = computed(() => links.value.length > 0 || mentions.value.length > 0)

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
    mentions.value = []
    if (!id) return
    await loadContext()
    const [linkResult, mentionResult] = await Promise.allSettled([
      window.notesDesktop.getNoteBacklinks(id),
      window.notesDesktop.getNoteMentions(id)
    ])
    if (linkResult.status === 'fulfilled') links.value = linkResult.value
    if (mentionResult.status === 'fulfilled') mentions.value = mentionResult.value
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

function highlightSegments(text: string, keyword: string): Array<{ text: string, hit: boolean }> {
  if (!text || !keyword) return []
  const segments: Array<{ text: string, hit: boolean }> = []
  let rest = text
  let index = rest.indexOf(keyword)
  while (index !== -1) {
    if (index > 0) segments.push({ text: rest.slice(0, index), hit: false })
    segments.push({ text: rest.slice(index, index + keyword.length), hit: true })
    rest = rest.slice(index + keyword.length)
    index = rest.indexOf(keyword)
  }
  if (rest) segments.push({ text: rest, hit: false })
  return segments
}

function openNote(noteId: string): void {
  void window.notesDesktop.openNoteLink(noteId).catch(() => {})
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

.backlinks-item__excerpt {
  grid-column: 1 / -1;
  margin: 2px 0 0;
  color: #8a97a8;
  font-size: 11px;
  line-height: 17px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.backlinks-item__excerpt mark {
  background: #ffe9a8;
  color: inherit;
  border-radius: 3px;
  padding: 0 1px;
}

.backlinks-item__arrow {
  grid-column: 2;
  grid-row: 1 / span 3;
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
