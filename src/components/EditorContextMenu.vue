<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="editor-context-menu-host"
      @pointerdown="emit('close')"
    >
      <div
        ref="menuRef"
        class="resource-context-menu editor-context-menu"
        role="menu"
        :style="menuStyle"
        @pointerdown.stop
        @click.stop
        @contextmenu.prevent
      >
        <template v-for="(group, gi) in groups" :key="gi">
          <div v-if="gi > 0 && group.items.some((it) => !it.disabled)" class="context-menu-divider"></div>
          <template v-for="item in group.items" :key="item.action">
            <button
              v-if="!item.disabled"
              type="button"
              role="menuitem"
              :class="{ danger: item.danger }"
              :disabled="item.disabled"
              @click="emit('command', item.action)"
            >
              <Icon v-if="item.icon" class="editor-context-menu__icon" :icon="item.icon" />
              <span>{{ item.label }}</span>
            </button>
          </template>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { Icon } from '@iconify/vue'

export interface EditorContextMenuItem {
  action: string
  label: string
  icon?: string
  danger?: boolean
  disabled?: boolean
}
export interface EditorContextMenuGroup {
  items: EditorContextMenuItem[]
}

const props = withDefaults(
  defineProps<{
    visible: boolean
    x: number
    y: number
    groups: EditorContextMenuGroup[]
  }>(),
  { x: 0, y: 0 }
)
const emit = defineEmits<{
  (event: 'close'): void
  (event: 'command', action: string): void
}>()

const menuRef = ref<HTMLDivElement | null>(null)

const menuSize = ref({ width: 220, height: 0 })

/** 右侧/底部空间不足时向左/向上翻转，避免菜单溢出视口。 */
const menuStyle = computed(() => {
  const { width, height } = menuSize.value
  const viewW = window.innerWidth
  const viewH = window.innerHeight
  const left = props.x + width > viewW - 8 ? Math.max(8, props.x - width) : props.x
  const top = props.y + height > viewH - 8 ? Math.max(8, props.y - height) : props.y
  return { left: `${left}px`, top: `${top}px`, minWidth: `${width}px` }
})

/** 每次打开后测量实际宽高用于翻转计算；等下一帧避免布局抖动。 */
watch(
  () => props.visible,
  async (open) => {
    if (!open) return
    await nextTick()
    await nextTick()
    const el = menuRef.value
    if (el) {
      menuSize.value = { width: el.offsetWidth, height: el.offsetHeight }
    }
  }
)
</script>

<style>
/* 全屏透明点击层：点击菜单以外任意处即关闭。z-index 低于菜单自身。 */
.editor-context-menu-host {
  position: fixed;
  inset: 0;
  z-index: 90;
}
/* 菜单浮层本体复用 .resource-context-menu 视觉；这里覆盖其字体最小宽度与描边样式。 */
.editor-context-menu {
  position: fixed;
  z-index: 91;
  width: auto;
}
.editor-context-menu .editor-context-menu__icon {
  flex: 0 0 auto;
}
/* 给菜单加一个紧凑的行高与白底，使其在编辑浮层上更清晰 */
</style>

