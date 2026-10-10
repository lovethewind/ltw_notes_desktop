<template>
  <Teleport to="body">
    <section
      ref="popoverRef"
      class="link-edit-popover"
      role="dialog"
      aria-label="编辑链接"
      :style="popoverStyle"
      @keydown="handleKeydown"
    >
      <div class="link-edit-popover__form">
        <label class="link-edit-popover__row">
          <span class="link-edit-popover__label">标题</span>
          <input
            ref="titleInputRef"
            v-model="title"
            class="link-edit-popover__input"
            type="text"
            placeholder="链接文字"
            aria-label="链接标题"
          >
        </label>
        <label class="link-edit-popover__row">
          <span class="link-edit-popover__label">地址</span>
          <input
            ref="hrefInputRef"
            v-model="href"
            class="link-edit-popover__input link-edit-popover__input--mono"
            type="text"
            placeholder="https://…"
            aria-label="链接地址"
          >
        </label>
      </div>
      <footer class="link-edit-popover__foot">
        <button
          v-if="props.canRemove"
          type="button"
          class="link-edit-popover__remove"
          @click="emit('remove')"
        >
          <Icon icon="tabler:link-off" />
          取消链接
        </button>
        <span v-else class="link-edit-popover__spacer" />
        <button
          type="button"
          class="link-edit-popover__save"
          @click="submit"
        >
          保存
        </button>
      </footer>
    </section>
  </Teleport>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  computeLinkEditPopoverPosition,
  type LinkEditAnchor
} from '../utils/link-edit-popover'

/**
 * 链接编辑浮层。
 *
 * 它替换的是 Crepe 自带的「一行输入框」编辑气泡 —— 那个只有地址、没有任何标签，
 * 看起来像一行没有边界的文字。这里改成「标题 / 地址」两行带标签的输入，
 * 底部左侧「取消链接」、右侧「保存」，与参考稿一致。
 *
 * 由父组件用 `v-if` 装卸：每次打开都是全新实例，所以 `props.title` / `props.href`
 * 直接当作初始值用 ref 接收即可，不需要 watch 同步。
 */
const props = defineProps<{
  /** 链接在视口中的包围盒（client 坐标），用于定位。 */
  anchor: LinkEditAnchor
  /** 当前链接文字。 */
  title: string
  /** 当前链接地址。 */
  href: string
  /** 是否已有链接可取消；新建链接时为 false（不渲染「取消链接」）。 */
  canRemove: boolean
}>()
const emit = defineEmits<{
  (event: 'save', payload: { title: string, href: string }): void
  (event: 'remove'): void
  (event: 'close'): void
}>()

const popoverRef = ref<HTMLElement | null>(null)
const titleInputRef = ref<HTMLInputElement | null>(null)
const hrefInputRef = ref<HTMLInputElement | null>(null)
const title = ref(props.title)
const href = ref(props.href)
/** 渲染后的实测高度：没量到之前先用估算值兜住，避免首帧闪一下再跳位。 */
const measuredHeight = ref(0)

const popoverStyle = computed(() => {
  const box = computeLinkEditPopoverPosition(
    props.anchor,
    { width: window.innerWidth, height: window.innerHeight },
    measuredHeight.value || 186
  )
  return {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`
  }
})

/** 量一次高度（内容固定，量一次就够）。 */
function measure(): void {
  measuredHeight.value = popoverRef.value?.offsetHeight ?? 0
}

function submit(): void {
  emit('save', { title: title.value, href: href.value })
}

/**
 * Esc 关闭、Enter 保存。
 *
 * ⚠️ Enter 必须避开输入法组词（`isComposing`）：中文输入时按 Enter 是「上屏候选词」，
 * 不拦一下会在选字的瞬间把弹窗关掉。
 */
function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('close')
    return
  }
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault()
    submit()
  }
}

/** 点浮层外部即关闭（与 Crepe 自带编辑气泡的口径一致）。 */
function handleOutsidePointerDown(event: PointerEvent): void {
  const target = event.target
  if (!(target instanceof Node)) return
  if (popoverRef.value?.contains(target)) return
  emit('close')
}

onMounted(async () => {
  await nextTick()
  measure()
  // 地址为空（新建链接：文字是选中的正文）时段落应该落在「地址」上，否则落在「标题」上。
  const focusTarget = href.value.trim() ? titleInputRef.value : hrefInputRef.value
  focusTarget?.focus()
  focusTarget?.select()
  document.addEventListener('pointerdown', handleOutsidePointerDown, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleOutsidePointerDown, true)
})
</script>

<style scoped>
/* 浮层挂在 body 上（Teleport），层级必须高过模式条与编辑器顶栏；
   与对话框同一量级，但不带遮罩 —— 它只是锚在链接上的一张表单。 */
.link-edit-popover {
  position: fixed;
  z-index: 240;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line, #dce5f0);
  border-radius: 14px;
  background: var(--surface-solid, #fff);
  box-shadow: 0 18px 48px rgba(20, 36, 58, .22);
  color: var(--ink, #18243a);
  font-size: 13px;
}

.link-edit-popover__form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
}

.link-edit-popover__row {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 标签固定宽度：两行的输入框左缘才能对齐（参考稿里就是这么齐的）。 */
.link-edit-popover__label {
  flex: none;
  width: 34px;
  color: var(--muted, #78869b);
  font-size: 13px;
  line-height: 1;
}

.link-edit-popover__input {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  outline: none;
  background: var(--panel, #f7faff);
  color: var(--ink, #18243a);
  font-size: 13px;
  font-family: inherit;
  transition: border-color .16s ease, background .16s ease;
}

.link-edit-popover__input--mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}

.link-edit-popover__input:focus {
  border-color: var(--blue, #2f80ed);
  background: var(--surface-solid, #fff);
}

.link-edit-popover__input::placeholder {
  color: var(--muted, #78869b);
}

.link-edit-popover__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-top: 1px solid var(--line, #dce5f0);
}

.link-edit-popover__remove {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  padding: 4px 6px;
  border-radius: 8px;
  background: transparent;
  color: var(--muted, #78869b);
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
  transition: color .16s ease, background .16s ease;
}

.link-edit-popover__remove:hover {
  background: var(--panel, #f7faff);
  color: var(--ink, #18243a);
}

.link-edit-popover__remove svg {
  width: 15px;
  height: 15px;
}

.link-edit-popover__save {
  height: 32px;
  padding: 0 20px;
  border: 0;
  border-radius: 8px;
  background: var(--blue, #2f80ed);
  color: #fff;
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
  font-weight: 500;
  transition: filter .16s ease;
}

.link-edit-popover__save:hover {
  filter: brightness(1.08);
}

/* 暗色下只有投影与输入框底色需要分支：配色变量已在全局暗色块里重新赋过值。 */
html[data-theme="dark"] .link-edit-popover {
  box-shadow: 0 18px 46px rgba(0, 0, 0, .5);
}
</style>
