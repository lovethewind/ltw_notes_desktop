<script setup lang="ts">
import { computed } from 'vue'
import { Icon } from '@iconify/vue'
import {
  formatNoteExcerpt as getNoteExcerpt,
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
}>()

const emit = defineEmits<{
  toggle: [folderId: string]
  selectNote: [note: OfflineNote]
  folderContext: [event: MouseEvent, folder: NoteFolder]
  noteContext: [event: MouseEvent, note: OfflineNote]
}>()

const childFolders = computed(() => props.folders.filter((folder) => (
  folder.parentId === props.folder.id
  && folder.isDeleted === Boolean(props.recycle)
)))
const directNotes = computed(() => props.notes.filter((note) => note.folderId === props.folder.id))
const hasContent = computed(() => childFolders.value.length > 0 || directNotes.value.length > 0)
const isExpanded = computed(() => props.expandedFolderIds.has(props.folder.id))

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
    <div :class="['nav-resource', 'tree-folder-resource', { 'is-empty': !hasContent }]" @contextmenu.prevent="openFolderContext">
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
        @toggle="emit('toggle', $event)"
        @select-note="emit('selectNote', $event)"
        @folder-context="forwardFolderContext"
        @note-context="forwardNoteContext"
      />

      <article
        v-for="note in directNotes"
        :key="note.id"
        :class="['sidebar-note-row', 'is-nested', { active: note.id === activeNoteId }]"
        @contextmenu.prevent="openNoteContext($event, note)"
      >
        <button class="sidebar-note-main" type="button" @click="emit('selectNote', note)">
          <Icon :icon="note.isPinned && !recycle
            ? 'material-symbols:keep-rounded'
            : 'material-symbols:description-outline-rounded'" />
          <span><strong>{{ note.title || '无标题笔记' }}</strong><small>{{ getNoteExcerpt(note.content) }}</small></span>
          <time>{{ formatTime(note.updatedAt) }}</time>
        </button>
      </article>
    </div>
  </div>
</template>
