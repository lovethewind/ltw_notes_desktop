<script setup lang="ts">
import type { NoteNavigationCounts, NoteNavigationKind } from '../utils/note-workspace'

defineOptions({ name: 'NoteNavigation' })

defineProps<{
  active: NoteNavigationKind | null
  counts: NoteNavigationCounts
}>()

const emit = defineEmits<{
  select: [kind: NoteNavigationKind]
}>()

const items: Array<{ kind: NoteNavigationKind; label: string }> = [
  { kind: 'all', label: '全部' },
  { kind: 'pinned', label: '置顶' },
  { kind: 'trash', label: '回收站' }
]
</script>

<template>
  <nav class="note-shared-navigation" aria-label="笔记筛选">
    <button
      v-for="item in items"
      :key="item.kind"
      :class="{ active: active === item.kind }"
      type="button"
      :aria-pressed="active === item.kind"
      @click="emit('select', item.kind)"
    >
      <span>{{ item.label }}</span>
      <small>{{ counts[item.kind] }}</small>
    </button>
  </nav>
</template>

<style scoped>
.note-shared-navigation {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 3px;
  min-width: 0;
}

.note-shared-navigation button {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 0;
  height: 34px;
  padding: 0 7px;
  overflow: hidden;
  border: 0;
  border-radius: 8px;
  color: var(--note-navigation-muted, #66778d);
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  transition: color 0.16s ease, background 0.16s ease, box-shadow 0.18s ease,
    transform 0.18s ease;
}

.note-shared-navigation button:hover {
  color: var(--note-navigation-text, #2b3a51);
  background: var(--note-navigation-hover, rgb(47 128 237 / 7%));
  box-shadow: 0 5px 14px rgb(47 128 237 / 8%);
  transform: translateX(2px);
}

.note-shared-navigation button.active {
  color: var(--note-navigation-primary, #2f80ed);
  background: var(--note-navigation-active, rgb(47 128 237 / 11%));
  font-weight: 750;
}

.note-shared-navigation span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-shared-navigation small {
  flex: 0 0 auto;
  color: currentColor;
  font-size: 11px;
  font-weight: 550;
  opacity: 0.8;
}

@media (prefers-reduced-motion: reduce) {
  .note-shared-navigation button {
    transition: none;
  }
}
</style>
