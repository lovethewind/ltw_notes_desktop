<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Icon } from '@iconify/vue'
import SearchExcerpt from './SearchExcerpt.vue'
import {
  formatNoteUpdatedTime as formatTime
} from '../utils/note-workspace'
import type { NoteFolder, OfflineNote } from '../types'

defineOptions({ name: 'FolderTreeItem' })

const props = defineProps<{
  folder: NoteFolder
  folders: NoteFolder[]
  notes: OfflineNote[]
  expandedFolderIds: Set<string>
  activeNoteId: string | null
  activeFolderId: string | null
  recycle?: boolean
  searchKeyword?: string
  dragEnabled?: boolean
  blockedFolderIds?: Set<string>
}>()

const emit = defineEmits<{
  toggle: [folderId: string]
  selectNote: [note: OfflineNote]
  folderContext: [event: MouseEvent, folder: NoteFolder]
  noteContext: [event: MouseEvent, note: OfflineNote]
  resourceDragStart: [event: DragEvent, resource: { kind: 'note' | 'folder', id: string }]
  resourceDrop: [payload: { event: DragEvent, folder: NoteFolder, position: 'before' | 'inside' | 'after' }]
}>()

const childFolders = computed(() => props.folders.filter((folder) => (
  folder.parentId === props.folder.id
  && folder.isDeleted === Boolean(props.recycle)
)))
const directNotes = computed(() => props.notes.filter((note) => note.folderId === props.folder.id))
const hasContent = computed(() => childFolders.value.length > 0 || directNotes.value.length > 0)
const isExpanded = computed(() => props.expandedFolderIds.has(props.folder.id))
const isDropBlocked = computed(() => props.blockedFolderIds?.has(props.folder.id) ?? false)
const dropPosition = ref<'before' | 'inside' | 'after' | null>(null)
let expandTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 清除悬停展开计时器。
 *
 * :return: 无返回值。
 */
function clearExpandTimer(): void {
  if (expandTimer) clearTimeout(expandTimer)
  expandTimer = null
}

/**
 * 开始拖动文件夹资源。
 *
 * :param event: 拖拽事件。
 * :return: 无返回值。
 */
function startFolderDrag(event: DragEvent): void {
  if (!props.dragEnabled || !event.dataTransfer) return
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('application/x-xinyue-resource', JSON.stringify({ kind: 'folder', id: props.folder.id }))
  emit('resourceDragStart', event, { kind: 'folder', id: props.folder.id })
}

/**
 * 开始拖动笔记资源。
 *
 * :param event: 拖拽事件。
 * :param note: 待移动笔记。
 * :return: 无返回值。
 */
function startNoteDrag(event: DragEvent, note: OfflineNote): void {
  if (!props.dragEnabled || !event.dataTransfer) return
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('application/x-xinyue-resource', JSON.stringify({ kind: 'note', id: note.id }))
  emit('resourceDragStart', event, { kind: 'note', id: note.id })
}

/**
 * 根据指针位置更新文件夹放置提示，并在悬停时展开。
 *
 * :param event: 拖拽事件。
 * :return: 无返回值。
 */
function handleFolderDragOver(event: DragEvent): void {
  if (!props.dragEnabled) return
  event.preventDefault()
  if (isDropBlocked.value) {
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
    clearFolderDropState()
    return
  }
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  const element = event.currentTarget as HTMLElement
  const ratio = (event.clientY - element.getBoundingClientRect().top) / element.offsetHeight
  dropPosition.value = ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside'
  if (dropPosition.value === 'inside' && hasContent.value && !isExpanded.value && !expandTimer) {
    expandTimer = setTimeout(() => emit('toggle', props.folder.id), 550)
  } else if (dropPosition.value !== 'inside') clearExpandTimer()
}

/**
 * 清理文件夹放置状态。
 *
 * :return: 无返回值。
 */
function clearFolderDropState(): void {
  dropPosition.value = null
  clearExpandTimer()
}

/**
 * 仅在指针真正离开当前文件夹资源时清理放置提示。
 *
 * :param event: 拖拽离开事件。
 * :return: 无返回值。
 */
function handleFolderDragLeave(event: DragEvent): void {
  const element = event.currentTarget as HTMLElement
  const nextTarget = event.relatedTarget
  if (nextTarget instanceof Node && element.contains(nextTarget)) return
  clearFolderDropState()
}

/**
 * 提交文件夹放置事件。
 *
 * :param event: 拖拽事件。
 * :return: 无返回值。
 */
function dropOnFolder(event: DragEvent): void {
  if (!props.dragEnabled || isDropBlocked.value || !dropPosition.value) {
    clearFolderDropState()
    return
  }
  event.preventDefault()
  emit('resourceDrop', { event, folder: props.folder, position: dropPosition.value })
  clearFolderDropState()
}

onMounted(() => {
  window.addEventListener('drop', clearFolderDropState)
  window.addEventListener('dragend', clearFolderDropState)
})

onBeforeUnmount(() => {
  window.removeEventListener('drop', clearFolderDropState)
  window.removeEventListener('dragend', clearFolderDropState)
  clearFolderDropState()
})

/**
 * 统计文件夹及其全部后代中的笔记数量。
 *
 * :param folderId: 文件夹 ID。
 * :param visited: 已访问文件夹集合，用于防止异常循环关系。
 * :return: 文件夹树中的笔记总数。
 */
function countFolderNotes(folderId: string, visited: Set<string> = new Set()): number {
  if (visited.has(folderId)) return 0
  const nextVisited = new Set(visited).add(folderId)
  const ownCount = props.notes.filter((note) => note.folderId === folderId).length
  const childCount = props.folders
    .filter((folder) => (
      folder.parentId === folderId
      && folder.isDeleted === Boolean(props.recycle)
    ))
    .reduce((total, folder) => total + countFolderNotes(folder.id, nextVisited), 0)
  return ownCount + childCount
}

/**
 * 向上转发文件夹右键事件。
 *
 * :param event: 鼠标事件。
 * :param folder: 目标文件夹。
 * :return: 无返回值。
 */
function forwardFolderContext(event: MouseEvent, folder: NoteFolder): void {
  emit('folderContext', event, folder)
}

/**
 * 向上转发笔记右键事件。
 *
 * :param event: 鼠标事件。
 * :param note: 目标笔记。
 * :return: 无返回值。
 */
function forwardNoteContext(event: MouseEvent, note: OfflineNote): void {
  emit('noteContext', event, note)
}

/**
 * 根据回收站归属决定是否打开文件夹右键菜单。
 *
 * :param event: 鼠标事件。
 * :return: 无返回值。
 */
function openFolderContext(event: MouseEvent): void {
  if (props.recycle && props.folder.deletedRootId !== props.folder.id) return
  emit('folderContext', event, props.folder)
}

/**
 * 根据回收站归属决定是否打开笔记右键菜单。
 *
 * :param event: 鼠标事件。
 * :param note: 目标笔记。
 * :return: 无返回值。
 */
function openNoteContext(event: MouseEvent, note: OfflineNote): void {
  if (props.recycle && note.deletedByFolderId) return
  emit('noteContext', event, note)
}
</script>

<template>
  <div class="folder-tree-node nav-resource-group">
    <div
      :class="['nav-resource', 'tree-folder-resource', { 'is-empty': !hasContent, 'drop-blocked': isDropBlocked, [`drop-${dropPosition}`]: dropPosition }]"
      :draggable="dragEnabled"
      @dragstart="startFolderDrag"
      @dragover="handleFolderDragOver"
      @dragleave="handleFolderDragLeave"
      @drop="dropOnFolder"
      @contextmenu.prevent="openFolderContext"
    >
      <button
        :class="{ active: activeFolderId === folder.id }"
        type="button"
        :aria-expanded="hasContent ? isExpanded : undefined"
        @click="hasContent && emit('toggle', folder.id)"
      >
        <Icon v-if="hasContent" class="resource-chevron" :icon="isExpanded ? 'tabler:chevron-down' : 'tabler:chevron-right'" />
        <Icon :icon="hasContent && isExpanded
          ? 'material-symbols:folder-open-outline-rounded'
          : 'material-symbols:folder-outline-rounded'" />
        <span>{{ folder.name }}</span>
        <small>{{ countFolderNotes(folder.id) }}</small>
      </button>
    </div>

    <div v-if="hasContent && isExpanded" class="folder-children folder-tree-children">
      <FolderTreeItem
        v-for="child in childFolders"
        :key="child.id"
        :folder="child"
        :folders="folders"
        :notes="notes"
        :expanded-folder-ids="expandedFolderIds"
        :active-note-id="activeNoteId"
        :active-folder-id="activeFolderId"
        :recycle="recycle"
        :search-keyword="searchKeyword"
        :drag-enabled="dragEnabled"
        :blocked-folder-ids="blockedFolderIds"
        @toggle="emit('toggle', $event)"
        @select-note="emit('selectNote', $event)"
        @folder-context="forwardFolderContext"
        @note-context="forwardNoteContext"
        @resource-drag-start="(event, resource) => emit('resourceDragStart', event, resource)"
        @resource-drop="emit('resourceDrop', $event)"
      />

      <article
        v-for="note in directNotes"
        :key="note.id"
        :class="['sidebar-note-row', 'is-nested', { active: note.id === activeNoteId }]"
        :draggable="dragEnabled"
        @dragstart="startNoteDrag($event, note)"
        @contextmenu.prevent="openNoteContext($event, note)"
      >
        <button class="sidebar-note-main" type="button" @click="emit('selectNote', note)">
          <Icon :icon="note.isPinned && !recycle
            ? 'material-symbols:keep-rounded'
            : 'material-symbols:description-outline-rounded'" />
          <span><strong>{{ note.title || '无标题笔记' }}</strong><small><SearchExcerpt :content="note.content" :keyword="searchKeyword || ''" /></small></span>
          <time>{{ formatTime(note.updatedAt) }}</time>
        </button>
      </article>
    </div>
  </div>
</template>
