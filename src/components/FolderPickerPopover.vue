<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { Icon } from '@iconify/vue'

export interface FolderPickerOption {
  id: string
  name: string
  depth: number
}

const props = withDefaults(defineProps<{
  title?: string
  countLabel: string
  folders: FolderPickerOption[]
  searchKeyword: string
  selectedFolderId?: string | null
  disabled?: boolean
  rootLabel?: string
  rootIcon?: string
  ariaLabel?: string
}>(), {
  title: '移动到文件夹',
  selectedFolderId: undefined,
  disabled: false,
  rootLabel: '未分类',
  rootIcon: 'tabler:folder-question',
  ariaLabel: '选择文件夹'
})

const emit = defineEmits<{
  'update:searchKeyword': [value: string]
  select: [folderId: string | null]
}>()

const searchInput = ref<HTMLInputElement | null>(null)
const searchKeyword = computed({
  get: () => props.searchKeyword,
  set: (value: string) => emit('update:searchKeyword', value)
})
const filteredFolders = computed(() => {
  const keyword = props.searchKeyword.trim().toLocaleLowerCase()
  return props.folders.filter((folder) => !keyword || folder.name.toLocaleLowerCase().includes(keyword))
})

onMounted(() => {
  void nextTick(() => searchInput.value?.focus())
})
</script>

<template>
  <div class="property-popover" role="listbox" :aria-label="ariaLabel">
    <div class="property-popover-title"><span>{{ title }}</span><small>{{ countLabel }}</small></div>
    <label class="folder-picker-search">
      <Icon icon="material-symbols:search-rounded" />
      <input
        ref="searchInput"
        v-model="searchKeyword"
        type="search"
        placeholder="搜索文件夹"
        aria-label="搜索文件夹"
      />
    </label>
    <button
      v-if="!searchKeyword.trim()"
      :class="['folder-picker-option', { selected: selectedFolderId === null }]"
      type="button"
      role="option"
      :disabled="disabled"
      :aria-selected="selectedFolderId === null"
      @click="emit('select', null)"
    >
      <Icon :icon="rootIcon" /><span>{{ rootLabel }}</span><Icon v-if="selectedFolderId === null" icon="material-symbols:check-rounded" />
    </button>
    <div class="property-popover-divider"></div>
    <div class="folder-picker-scroll">
      <button
        v-for="folder in filteredFolders"
        :key="folder.id"
        :class="['folder-picker-option', { selected: selectedFolderId === folder.id }]"
        :style="{ '--folder-depth': folder.depth }"
        type="button"
        role="option"
        :disabled="disabled"
        :aria-selected="selectedFolderId === folder.id"
        @click="emit('select', folder.id)"
      >
        <Icon icon="material-symbols:folder-outline-rounded" /><span>{{ folder.name }}</span><Icon v-if="selectedFolderId === folder.id" icon="material-symbols:check-rounded" />
      </button>
      <p v-if="!filteredFolders.length" class="folder-picker-empty">没有匹配的文件夹</p>
    </div>
  </div>
</template>
