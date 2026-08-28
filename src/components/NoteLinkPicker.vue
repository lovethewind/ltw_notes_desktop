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
        aria-label="插入笔记链接"
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
        <ul v-if="results.length" class="note-link-picker__list" role="listbox">
          <li
            v-for="(note, index) in results"
            :key="note.id"
            :class="['note-link-picker__item', { 'is-active': index === activeIndex }]"
            role="option"
            :aria-selected="index === activeIndex"
            @mouseenter="activeIndex = index"
            @click="choose(note)"
          >
            <span class="note-link-picker__title">{{ note.title || '（无标题）' }}</span>
            <span v-if="note.tags.length" class="note-link-picker__tags">
              {{ note.tags.map((tag) => tag.name).join('、') }}
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
import { nextTick, ref, watch } from 'vue'
import type { OfflineNote } from '../types'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  (event: 'close'): void
  (event: 'select', noteId: string, title: string): void
}>()

const keyword = ref('')
const results = ref<OfflineNote[]>([])
const activeIndex = ref(0)
const searchInputRef = ref<HTMLInputElement | null>(null)
let searchToken = 0

async function runSearch(): Promise<void> {
  const token = ++searchToken
  const text = keyword.value.trim()
  if (!text) {
    results.value = []
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
    results.value = []
    activeIndex.value = 0
    await nextTick()
    searchInputRef.value?.focus()
  }
)

function choose(note: OfflineNote): void {
  emit('select', note.id, note.title || '（无标题）')
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
  overflow-y: auto;
}

.note-link-picker__item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 10px;
  border-radius: 9px;
  cursor: pointer;
}

.note-link-picker__item.is-active {
  background: var(--blue, #2f80ed);
  color: #fff;
}

.note-link-picker__title {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-link-picker__tags {
  font-size: 11px;
  opacity: 0.7;
  flex-shrink: 0;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}

.note-link-picker__empty {
  margin: 0;
  padding: 22px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--muted, #78869b);
}
</style>
