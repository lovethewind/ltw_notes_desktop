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
          <span class="link-suggest__body">
            <span class="link-suggest__head">
              <span class="link-suggest__title">{{ note.title || '（无标题）' }}</span>
              <span v-if="note.tags.length" class="link-suggest__tags">
                {{ note.tags.map((tag) => tag.name).join('、') }}
              </span>
            </span>
            <span v-if="note.content" class="link-suggest__excerpt">
              <SearchExcerpt :content="note.content" :keyword="keyword" />
            </span>
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
import SearchExcerpt from './SearchExcerpt.vue'

const props = withDefaults(defineProps<{
  visible: boolean
  coords: { left: number, top: number, bottom: number }
  items: OfflineNote[]
  activeIndex: number
  /**
   * 当前 `[[` 之后已输入的关键词。
   *
   * 只用于高亮摘要里的命中片段（空串表示「最近更新」列表，此时 `SearchExcerpt`
   * 走普通摘要分支）。
   */
  keyword?: string
}>(), { keyword: '' })

const emit = defineEmits<{
  (event: 'hover', index: number): void
  (event: 'select', noteId: string, serverId: string | null, title: string): void
}>()

const GAP = 6
const MARGIN = 8
/**
 * 浮层高度上限。
 *
 * 条目是「标题 + 正文摘要」两行（约 46px），400px 大约能看到 8 条，
 * 其余靠滚动 —— 候选上限是 20 / 50 条（见 `MarkdownVisualEditor` 的
 * `LINK_SUGGEST_RECENT_LIMIT` / `LINK_SUGGEST_SEARCH_LIMIT`），必然要滚。
 */
const MAX_HEIGHT = 400
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

/**
 * 让键盘选中的条目滚进浮层的可视范围。
 *
 * 只改浮层自己的 `scrollTop`，**不用 `scrollIntoView`** —— 浮层是
 * `position: fixed` 的 Teleport 节点，`scrollIntoView` 会连带滚动文档，
 * 把用户正在编辑的正文位置带跑。新条目从下方进入时最少滚到刚好露出。
 *
 * :return: 无返回值。
 */
function scrollActiveIntoView(): void {
  const root = rootRef.value
  if (!root) return
  const active = root.querySelectorAll<HTMLElement>('.link-suggest__item')[props.activeIndex]
  if (!active) return
  const rootRect = root.getBoundingClientRect()
  const rect = active.getBoundingClientRect()
  if (rect.top < rootRect.top) {
    root.scrollTop -= rootRect.top - rect.top
  } else if (rect.bottom > rootRect.bottom) {
    root.scrollTop += rect.bottom - rootRect.bottom
  }
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

// 候选换了（重新搜索）就从顶部重新看起，再让选中项就位。
watch(
  () => props.items,
  () => {
    if (!props.visible) return
    void nextTick(() => {
      if (rootRef.value) rootRef.value.scrollTop = 0
      scrollActiveIntoView()
    })
  },
)

watch(
  () => props.activeIndex,
  () => {
    if (props.visible) void nextTick(scrollActiveIntoView)
  },
)

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = undefined
})

function choose(note: OfflineNote): void {
  emit('select', note.id, note.serverId ?? null, note.title || '（无标题）')
}
</script>

<style scoped>
.link-suggest {
  position: fixed;
  z-index: 1200;
  min-width: 240px;
  max-width: 340px;
  max-height: 400px;
  /*
    🔴 `overflow-x` 必须显式写成 hidden。只声明 `overflow-y: auto` 时，CSS 会把
    「另一个方向」的 `visible` 计算成 `auto` —— 于是标题/标签的 `white-space: nowrap`
    一旦撑宽内容，浮层底部就冒出一条横向滚动条（用户报过）。
    真正治本的是下面 `.link-suggest__body` 的 `min-width: 0`：flex 项的默认
    `min-width: auto` 不允许收缩到内容宽度以下，nowrap 文本因此能顶开父级。
  */
  overflow-x: hidden;
  overflow-y: auto;
  padding: 6px;
  border: 1px solid var(--line, #dce5f0);
  border-radius: 10px;
  background: var(--surface-solid, #fff);
  box-shadow: 0 12px 36px rgba(20, 36, 58, 0.18);
}

.link-suggest__list {
  display: grid;
  /*
    🔴 `minmax(0, 1fr)` 不能省。grid 的自动轨道取**内容**宽度，而 grid item 的
    默认 `min-width: auto` 不允许收缩 —— 条目里 `white-space: nowrap` 的标题 /
    摘要就会把轨道顶出容器（实测改前溢 4px、加摘要后溢 36px），
    配合上面 `.link-suggest` 的 `overflow-x` 就是那条横向滚动条。
  */
  grid-template-columns: minmax(0, 1fr);
  gap: 2px;
}

.link-suggest__item {
  display: flex;
  box-sizing: border-box;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  /* grid item 的自动最小尺寸同样要放开，否则上面的 minmax(0, 1fr) 也拦不住内部 nowrap 文本。 */
  min-width: 0;
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
  margin-top: 1px;
  color: var(--blue);
  flex-shrink: 0;
}

.link-suggest__item.is-active .link-suggest__item-icon {
  color: #fff;
}

/* 标题行 + 摘要行的纵向容器；`min-width: 0` 是横向滚动条的治本项。 */
.link-suggest__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.link-suggest__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.link-suggest__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.link-suggest__tags {
  flex: 0 1 auto;
  max-width: 40%;
  overflow: hidden;
  font-size: 10px;
  opacity: 0.72;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted, #78869b);
}

/*
  正文摘要：候选数据里的 `content` 本来就是摘要（空关键词 = 最近更新摘要，
  有关键词 = 命中上下文，都由 `listWorkspace` / `searchNotes` 预处理），
  这里只负责裁剪与配色。
*/
.link-suggest__excerpt {
  overflow: hidden;
  font-size: 11px;
  line-height: 15px;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted, #78869b);
}

.link-suggest__item.is-active .link-suggest__tags,
.link-suggest__item.is-active .link-suggest__excerpt {
  color: rgba(255, 255, 255, 0.82);
}

/* 命中高亮来自 `SearchExcerpt`（全局是黄底），这里换成与浮层同一套蓝。 */
.link-suggest__excerpt :deep(mark) {
  border-radius: 3px;
  padding: 0 1px;
  background: rgb(47 128 237 / 18%);
  color: inherit;
}

.link-suggest__item.is-active .link-suggest__excerpt :deep(mark) {
  background: rgb(255 255 255 / 30%);
  color: #fff;
}

.link-suggest__empty {
  padding: 14px 12px;
  color: var(--muted, #78869b);
  font-size: 12px;
  text-align: center;
}
</style>
