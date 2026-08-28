<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="rootRef"
      class="link-suggest"
      role="listbox"
      :style="style"
      @mousedown.prevent
    >
      <div v-if="items.length" class="link-suggest__list">
        <button
          v-for="(note, index) in items"
          :key="note.id"
          type="button"
          :class="['link-suggest__item', { 'is-active': index === activeIndex }]"
          role="option"
          :aria-selected="index === activeIndex"
          @mouseenter="emit('hover', index)"
          @click="choose(note)"
        >
          <Icon class="link-suggest__item-icon" icon="material-symbols:description-rounded" />
          <span class="link-suggest__title">{{ note.title || '（无标题）' }}</span>
          <span v-if="note.tags.length" class="link-suggest__tags">
            {{ note.tags.map((tag) => tag.name).join('、') }}
          </span>
        </button>
      </div>
      <div v-else class="link-suggest__empty">没有匹配的笔记</div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { computed, nextTick, onBeforeUnmount, ref, watch, type CSSProperties } from 'vue'
import type { OfflineNote } from '../types'

const props = defineProps<{
  visible: boolean
  coords: { left: number, top: number, bottom: number }
  items: OfflineNote[]
  activeIndex: number
}>()

const emit = defineEmits<{
  (event: 'hover', index: number): void
  (event: 'select', noteId: string, title: string): void
}>()

const GAP = 6
const MARGIN = 8
const MAX_HEIGHT = 300
const MIN_HEIGHT = 60

const rootRef = ref<HTMLElement | null>(null)
const position = ref({ left: 0, top: 0 })
const maxHeight = ref(MAX_HEIGHT)
const ready = ref(false)
let observer: ResizeObserver | undefined

const style = computed<CSSProperties>(() => ({
  left: `${position.value.left}px`,
  top: `${position.value.top}px`,
  maxHeight: `${maxHeight.value}px`,
  visibility: ready.value ? 'visible' : 'hidden',
}))

/**
 * 按当前渲染尺寸与视口边缘重新定位，避免贴近视口底部或右缘时被裁切。
 *
 * :return: 无返回值。
 */
function layout(): void {
  const el = rootRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  maxHeight.value = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, viewportHeight - MARGIN * 2))

  const width = Math.min(rect.width, viewportWidth - MARGIN * 2)
  const left = Math.max(MARGIN, Math.min(props.coords.left, viewportWidth - width - MARGIN))

  const belowTop = props.coords.bottom + GAP
  const spaceBelow = viewportHeight - MARGIN - belowTop
  const measuredHeight = Math.min(rect.height, maxHeight.value)
  const top = spaceBelow >= measuredHeight
    ? belowTop
    : Math.max(MARGIN, props.coords.top - GAP - measuredHeight)

  position.value = { left, top: Math.min(top, viewportHeight - MARGIN - measuredHeight) }
  ready.value = true
}

/** 浮层出现后测量尺寸并监听高度变化，随时重算位置。 */
function observe(): void {
  const el = rootRef.value
  if (!el) return
  ready.value = false
  observer?.disconnect()
  observer = new ResizeObserver(() => layout())
  observer.observe(el)
  layout()
}

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      nextTick(observe)
    } else {
      observer?.disconnect()
      observer = undefined
      ready.value = false
    }
  },
  { immediate: true },
)

watch(
  () => [props.coords, props.items],
  () => {
    if (props.visible) layout()
  },
  { deep: true },
)

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = undefined
})

function choose(note: OfflineNote): void {
  emit('select', note.id, note.title || '（无标题）')
}
</script>

<style scoped>
.link-suggest {
  position: fixed;
  z-index: 1200;
  min-width: 220px;
  max-width: 320px;
  max-height: 300px;
  overflow-y: auto;
  padding: 6px;
  border: 1px solid var(--line, #dce5f0);
  border-radius: 10px;
  background: var(--surface-solid, #fff);
  box-shadow: 0 12px 36px rgba(20, 36, 58, 0.18);
}

.link-suggest__list {
  display: grid;
  gap: 2px;
}

.link-suggest__item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 7px 9px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.link-suggest__item.is-active {
  background: var(--blue, #2f80ed);
  color: #fff;
}

.link-suggest__item-icon {
  width: 14px;
  height: 14px;
  color: var(--blue);
  flex-shrink: 0;
  align-self: center;
}

.link-suggest__item.is-active .link-suggest__item-icon {
  color: #fff;
}

.link-suggest__title {
  flex: 1;
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.link-suggest__tags {
  max-width: 40%;
  overflow: hidden;
  font-size: 10px;
  opacity: 0.72;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted, #78869b);
}

.link-suggest__item.is-active .link-suggest__tags {
  color: rgba(255, 255, 255, 0.8);
}

.link-suggest__empty {
  padding: 14px 12px;
  color: var(--muted, #78869b);
  font-size: 12px;
  text-align: center;
}
</style>
