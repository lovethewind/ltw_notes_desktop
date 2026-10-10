<template>
  <Teleport to="body">
    <div
      class="preview-image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      @wheel.prevent="handleWheel"
    >
      <div
        ref="stageRef"
        class="preview-image-viewer__stage"
        :class="{ 'is-dragging': dragging }"
        @pointerdown="handlePointerDown"
        @pointermove="handlePointerMove"
        @pointerup="handlePointerUp"
        @pointercancel="handlePointerUp"
        @click="handleStageClick"
        @dblclick="toggleActualSize"
      >
        <img
          ref="imageRef"
          class="preview-image-viewer__image"
          :src="current.src"
          :alt="current.alt"
          :style="imageStyle"
          draggable="false"
          @load="fitToWindow"
        >
      </div>
      <header class="preview-image-viewer__header">
        <span v-if="images.length > 1" class="preview-image-viewer__counter">
          {{ index + 1 }} / {{ images.length }}
        </span>
        <button
          type="button"
          class="preview-image-viewer__close"
          title="关闭（Esc）"
          aria-label="关闭图片预览"
          @click="emit('close')"
        >
          <Icon icon="material-symbols:close-rounded" />
        </button>
      </header>
      <template v-if="images.length > 1">
        <button
          type="button"
          class="preview-image-viewer__nav is-previous"
          title="上一张（←）"
          aria-label="上一张"
          @click="step(-1)"
        >
          <Icon icon="tabler:chevron-left" />
        </button>
        <button
          type="button"
          class="preview-image-viewer__nav is-next"
          title="下一张（→）"
          aria-label="下一张"
          @click="step(1)"
        >
          <Icon icon="tabler:chevron-right" />
        </button>
      </template>
      <footer class="preview-image-viewer__tools">
        <button type="button" class="preview-image-viewer__tool" title="缩小" aria-label="缩小" @click="zoomBy(1 / PREVIEW_IMAGE_ZOOM_STEP)">−</button>
        <span class="preview-image-viewer__percent" aria-live="off">{{ percentLabel }}</span>
        <button type="button" class="preview-image-viewer__tool" title="放大" aria-label="放大" @click="zoomBy(PREVIEW_IMAGE_ZOOM_STEP)">＋</button>
        <span class="preview-image-viewer__divider" aria-hidden="true"></span>
        <button type="button" class="preview-image-viewer__tool is-text" @click="fitToWindow">适应窗口</button>
        <button type="button" class="preview-image-viewer__tool is-text" @click="actualSize">1:1</button>
      </footer>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import {
  PREVIEW_IMAGE_ZOOM_STEP,
  clampPreviewImageScale,
  computePreviewImageFitScale,
  type PreviewImageItem,
  zoomPreviewImageAtPoint
} from '../utils/preview-image-tools'

/**
 * 预览图片的全屏查看器。
 *
 * 「看不清」是这一层存在的唯一理由，所以默认进「适应窗口」而不是 100%：
 * 大图先整张看得见，需要细节再滚轮放大。缩放一律以光标为锚点（见 `zoomPreviewImageAtPoint`），
 * 否则放大后想看的那个角落会跑出屏幕。
 *
 * 覆盖层刻意在明暗两套主题下都是深色：看图时周围越暗越准，这是灯箱的通行做法。
 */
const props = defineProps<{
  /** 同一篇预览里的全部图片，按正文顺序。 */
  images: PreviewImageItem[]
  /** 当前图片下标。 */
  index: number
}>()

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'update:index', index: number): void
}>()

const stageRef = ref<HTMLElement | null>(null)
const imageRef = ref<HTMLImageElement | null>(null)

/** 当前缩放与位移（位移相对容器中心，与 transform-origin: center 对齐）。 */
const scale = ref(1)
const offsetX = ref(0)
const offsetY = ref(0)
const dragging = ref(false)

/** 拖动起点；为空表示当前没有在拖。 */
let dragOrigin: { x: number, y: number, offsetX: number, offsetY: number } | null = null
/** 本次按下有没有真的拖动过 —— 拖动后松手不该被当成「点空白关闭」。 */
let dragMoved = false

const DRAG_THRESHOLD = 4

const current = computed<PreviewImageItem>(() => props.images[props.index] ?? { src: '', alt: '' })
const percentLabel = computed(() => `${Math.round(scale.value * 100)}%`)
const imageStyle = computed(() => ({
  transform: `translate(${offsetX.value}px, ${offsetY.value}px) scale(${scale.value})`
}))

/** 回到「适应窗口」：小图不放大，大图缩到整张可见。 */
function fitToWindow(): void {
  const stage = stageRef.value
  const image = imageRef.value
  const box = stage?.getBoundingClientRect()
  scale.value = computePreviewImageFitScale(
    image?.naturalWidth ?? 0,
    image?.naturalHeight ?? 0,
    box?.width ?? 0,
    box?.height ?? 0
  )
  offsetX.value = 0
  offsetY.value = 0
}

/** 回到原始像素（1:1），便于核对细节。 */
function actualSize(): void {
  scale.value = 1
  offsetX.value = 0
  offsetY.value = 0
}

/** 双击在「1:1」与「适应窗口」之间切换。 */
function toggleActualSize(): void {
  if (Math.abs(scale.value - 1) < 0.01) fitToWindow()
  else actualSize()
}

/** 以容器中心为锚缩放（按钮用）。 */
function zoomBy(factor: number): void {
  scale.value = clampPreviewImageScale(scale.value * factor)
}

function handleWheel(event: WheelEvent): void {
  const stage = stageRef.value
  if (!stage) return
  const box = stage.getBoundingClientRect()
  const nextScale = clampPreviewImageScale(scale.value * Math.exp(-event.deltaY * 0.0015))
  if (nextScale === scale.value) return
  const next = zoomPreviewImageAtPoint({
    scale: scale.value,
    offsetX: offsetX.value,
    offsetY: offsetY.value,
    nextScale,
    pointX: event.clientX - box.left - box.width / 2,
    pointY: event.clientY - box.top - box.height / 2
  })
  scale.value = next.scale
  offsetX.value = next.offsetX
  offsetY.value = next.offsetY
}

function handlePointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  dragging.value = true
  dragMoved = false
  dragOrigin = { x: event.clientX, y: event.clientY, offsetX: offsetX.value, offsetY: offsetY.value }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function handlePointerMove(event: PointerEvent): void {
  if (!dragOrigin) return
  const deltaX = event.clientX - dragOrigin.x
  const deltaY = event.clientY - dragOrigin.y
  if (!dragMoved && Math.abs(deltaX) + Math.abs(deltaY) > DRAG_THRESHOLD) dragMoved = true
  offsetX.value = dragOrigin.offsetX + deltaX
  offsetY.value = dragOrigin.offsetY + deltaY
}

function handlePointerUp(event: PointerEvent): void {
  if (!dragOrigin) return
  dragOrigin = null
  dragging.value = false
  const target = event.currentTarget as HTMLElement
  if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId)
}

/** 点图外的空白处关闭；拖动过就不算点击。 */
function handleStageClick(event: MouseEvent): void {
  if (dragMoved) return
  if (event.target !== stageRef.value) return
  emit('close')
}

function step(delta: number): void {
  const total = props.images.length
  if (total < 2) return
  emit('update:index', (props.index + delta + total) % total)
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    emit('close')
    return
  }
  if (event.key === 'ArrowLeft') step(-1)
  if (event.key === 'ArrowRight') step(1)
}

// 换图先把上一张的缩放清掉：新图尺寸未知，等它的 load 事件回来再算「适应窗口」。
watch(() => props.index, () => {
  scale.value = 1
  offsetX.value = 0
  offsetY.value = 0
})

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
  // 图片来自缓存时 load 事件可能早于挂载，补一次兜底。
  nextTick(() => {
    if (imageRef.value?.complete) fitToWindow()
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<!-- 整条传送到 body，样式必须落在全局作用域；选择器统一以 .preview-image-viewer 开头。 -->
<style>
.preview-image-viewer {
  position: fixed;
  inset: 0;
  z-index: 2200;
  display: flex;
  align-items: stretch;
  justify-content: center;
  background: rgba(7, 13, 24, .93);
}
.preview-image-viewer__stage {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
}
.preview-image-viewer__stage.is-dragging { cursor: grabbing; }
.preview-image-viewer__image {
  /* 明确关掉 max-width：不放开的话大图会被压回容器宽度，缩放就没有意义了。 */
  max-width: none;
  max-height: none;
  border-radius: 4px;
  transform-origin: center center;
  user-select: none;
  -webkit-user-drag: none;
}
.preview-image-viewer__header {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  /* 左上角的计数要让开窗口交通灯（浮在内容之上的原生控件），否则会被压在按钮底下。 */
  padding: 12px 16px 12px var(--titlebar-safe-left);
  pointer-events: none;
}
.preview-image-viewer__counter {
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(20, 32, 50, .78);
  color: #dbe7f7;
  font-size: 12px;
}
.preview-image-viewer__close,
.preview-image-viewer__nav,
.preview-image-viewer__tool {
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: rgba(20, 32, 50, .78);
  color: #e3edfa;
  cursor: pointer;
  pointer-events: auto;
}
.preview-image-viewer__close {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  font-size: 20px;
}
.preview-image-viewer__nav {
  position: absolute;
  top: 50%;
  width: 40px;
  height: 64px;
  margin-top: -32px;
  border-radius: 10px;
  font-size: 24px;
}
.preview-image-viewer__nav.is-previous { left: 16px; }
.preview-image-viewer__nav.is-next { right: 16px; }
.preview-image-viewer__close:hover,
.preview-image-viewer__nav:hover,
.preview-image-viewer__tool:hover { background: rgba(64, 106, 168, .86); }
.preview-image-viewer__tools {
  position: absolute;
  left: 50%;
  bottom: 20px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 8px;
  border-radius: 10px;
  background: rgba(20, 32, 50, .82);
  transform: translateX(-50%);
}
.preview-image-viewer__tool {
  min-width: 30px;
  height: 30px;
  padding: 0 8px;
  border-radius: 7px;
  font-size: 17px;
}
.preview-image-viewer__tool.is-text { font-size: 12.5px; }
.preview-image-viewer__percent {
  min-width: 50px;
  color: #e3edfa;
  font-size: 12.5px;
  text-align: center;
}
.preview-image-viewer__divider {
  width: 1px;
  height: 18px;
  margin: 0 4px;
  background: rgba(190, 214, 245, .3);
}
</style>
