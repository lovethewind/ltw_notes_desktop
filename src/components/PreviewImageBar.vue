<template>
  <Teleport to="body">
    <div
      ref="barRef"
      class="preview-image-bar"
      role="toolbar"
      aria-label="图片操作"
      :style="barStyle"
      @mouseenter="emit('keep')"
      @mouseleave="emit('dismiss')"
    >
      <button
        type="button"
        class="preview-image-bar__button"
        title="全屏查看"
        aria-label="全屏查看"
        @click="emit('open')"
      >
        <Icon icon="tabler:maximize" />
      </button>
      <button
        type="button"
        class="preview-image-bar__button"
        title="复制图片"
        aria-label="复制图片"
        @click="emit('copy')"
      >
        <Icon icon="material-symbols:content-copy-outline-rounded" />
      </button>
      <button
        type="button"
        class="preview-image-bar__button"
        title="另存为…"
        aria-label="另存为"
        @click="emit('save')"
      >
        <Icon icon="tabler:download" />
      </button>
      <button
        type="button"
        class="preview-image-bar__button"
        :disabled="!canOpenExternal"
        :title="canOpenExternal ? '在浏览器打开' : '仅网络图片可在浏览器打开'"
        aria-label="在浏览器打开"
        @click="emit('external')"
      >
        <Icon icon="tabler:external-link" />
      </button>
      <Transition name="preview-image-notice">
        <span v-if="notice" class="preview-image-bar__notice" role="status">{{ notice }}</span>
      </Transition>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Icon } from '@iconify/vue'

/**
 * 预览图片的悬停工具条。
 *
 * 只在鼠标悬停到某张图片上时出现，跟着图片右上角走。整条 `position: fixed` 传送到 body：
 * 挂在预览容器里会被 `overflow: auto` 裁掉，还会随滚动错位。
 *
 * 定位用「图片右边缘 + 工具条实测宽度」反推 left，而不是给工具条写死宽度 ——
 * 「在浏览器打开」在非网络图片上是禁用态（不是隐藏），按钮数量恒定，但实测更稳。
 */
const props = defineProps<{
  /** 目标图片的视口坐标（左/右边缘与上边缘）。 */
  anchor: { top: number, left: number, right: number }
  /** 贴着图片哪一侧：编辑态用 `left` 避让 Crepe 右上角的图注按钮。 */
  align?: 'left' | 'right'
  /** 当前图片是否是网络图片（决定「在浏览器打开」可用）。 */
  canOpenExternal: boolean
  /** 操作结果提示，空串表示不显示。 */
  notice: string
}>()

const emit = defineEmits<{
  (event: 'keep'): void
  (event: 'dismiss'): void
  (event: 'open'): void
  (event: 'copy'): void
  (event: 'save'): void
  (event: 'external'): void
}>()

/** 首个渲染帧还没量到宽度，用一个接近实际值的估计，避免先闪一下再纠正。 */
const ESTIMATED_BAR_WIDTH = 138

const barRef = ref<HTMLElement | null>(null)
const barWidth = ref(0)

const barStyle = computed(() => {
  const width = barWidth.value || ESTIMATED_BAR_WIDTH
  // 图片比工具条还窄时（很常见的小图标），工具条会伸到图片外面 —— 只保证它不出视口。
  const maxLeft = window.innerWidth - width - 8
  const left = props.align === 'left'
    ? Math.min(Math.max(8, props.anchor.left + 8), maxLeft)
    : Math.max(8, Math.min(props.anchor.right - width - 8, maxLeft))
  return {
    top: `${Math.max(8, props.anchor.top + 8)}px`,
    left: `${left}px`
  }
})

onMounted(() => {
  barWidth.value = barRef.value?.offsetWidth ?? 0
})
</script>

<!--
  刻意不加 scoped：整条传送到 body，随窗口缩放的 fixed 定位要落在全局作用域；
  所有选择器都以 .preview-image-bar 开头，不会外溢。
-->
<style>
.preview-image-bar {
  position: fixed;
  z-index: 2100;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border: 1px solid #d5e2f2;
  border-radius: 9px;
  background: #fff;
  box-shadow: 0 8px 22px rgba(18, 45, 80, .16);
}
.preview-image-bar__button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #46658c;
  font-size: 16px;
  cursor: pointer;
}
.preview-image-bar__button:hover:not(:disabled) { background: #eaf2fb; color: #2268c7; }
.preview-image-bar__button:disabled { color: #a9bdd4; cursor: not-allowed; }
.preview-image-bar__notice {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  padding: 4px 9px;
  border-radius: 6px;
  background: rgba(24, 45, 74, .92);
  color: #f2f7ff;
  font-size: 12px;
  white-space: nowrap;
}
.preview-image-notice-enter-active,
.preview-image-notice-leave-active { transition: opacity .18s ease; }
.preview-image-notice-enter-from,
.preview-image-notice-leave-to { opacity: 0; }

html[data-theme="dark"] .preview-image-bar {
  border-color: #2b3f5c;
  background: #16243a;
  box-shadow: 0 8px 22px rgba(0, 0, 0, .42);
}
html[data-theme="dark"] .preview-image-bar__button { color: #93aac6; }
html[data-theme="dark"] .preview-image-bar__button:hover:not(:disabled) { background: #22354f; color: #a9cdf7; }
html[data-theme="dark"] .preview-image-bar__button:disabled { color: #4a5f7d; }
</style>
