<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import FolderPickerPopover, { type FolderPickerOption } from './FolderPickerPopover.vue'
import { formatNoteExcerpt } from '../utils/note-workspace'
import type { NoteFolder, NoteTag, OfflineNote } from '../types'

type UpdatedWithin = 'all' | '7' | '30' | '365'
type FilterMenu = 'folder' | 'tag' | 'time' | null

export interface QuickOpenSelection {
  note: OfflineNote
  keyword: string
  contentMatched: boolean
}

interface QuickOpenResult {
  note: OfflineNote
  folderPath: string
  excerpt: string
  contentMatched: boolean
}

const props = defineProps<{
  folders: NoteFolder[]
  tags: NoteTag[]
  notes: OfflineNote[]
}>()

const emit = defineEmits<{
  select: [selection: QuickOpenSelection]
}>()

const visible = defineModel<boolean>('visible', { required: true })
const keyword = ref('')
const searchNotes = ref<OfflineNote[]>([])
const filtersVisible = ref(false)
const folderId = ref('')
const tagId = ref('')
const updatedWithin = ref<UpdatedWithin>('all')
const pinnedOnly = ref(false)
const filterMenu = ref<FilterMenu>(null)
const folderSearchKeyword = ref('')
const tagSearchKeyword = ref('')
const input = ref<HTMLInputElement | null>(null)
const resultsElement = ref<HTMLElement | null>(null)
const activeIndex = ref(0)
const history = ref(loadHistory())
let searchTimer: ReturnType<typeof setTimeout> | undefined
let searchRequestId = 0

const updatedOptions: Array<{ value: UpdatedWithin, label: string }> = [
  { value: 'all', label: '不限时间' },
  { value: '7', label: '最近 7 天' },
  { value: '30', label: '最近 30 天' },
  { value: '365', label: '最近一年' }
]

const hasFilters = computed(() => Boolean(
  folderId.value || tagId.value || updatedWithin.value !== 'all' || pinnedOnly.value
))
const folderLabel = computed(() => props.folders.find((folder) => folder.id === folderId.value)?.name || '全部文件夹')
const tagLabel = computed(() => props.tags.find((tag) => tag.id === tagId.value)?.name || '全部标签')
const updatedLabel = computed(() => updatedOptions.find((option) => option.value === updatedWithin.value)?.label || '不限时间')
const filteredTags = computed(() => {
  const normalizedKeyword = tagSearchKeyword.value.trim().toLocaleLowerCase()
  return props.tags.filter((tag) => !normalizedKeyword || tag.name.toLocaleLowerCase().includes(normalizedKeyword))
})
const folderOptions = computed<FolderPickerOption[]>(() => {
  const options: FolderPickerOption[] = []
  const visited = new Set<string>()

  function append(parentId: string | null, depth: number): void {
    for (const folder of props.folders.filter((item) => !item.isDeleted && item.parentId === parentId)) {
      if (visited.has(folder.id)) continue
      visited.add(folder.id)
      options.push({ id: folder.id, name: folder.name, depth })
      append(folder.id, depth + 1)
    }
  }

  append(null, 0)
  return options
})
const selectedFolderIds = computed(() => {
  if (!folderId.value) return []
  const selectedIds = new Set([folderId.value])
  let changed = true
  // 父文件夹筛选覆盖整棵子树，和侧边栏目录语义保持一致。
  while (changed) {
    changed = false
    for (const folder of props.folders) {
      if (!folder.isDeleted && folder.parentId && selectedIds.has(folder.parentId) && !selectedIds.has(folder.id)) {
        selectedIds.add(folder.id)
        changed = true
      }
    }
  }
  return Array.from(selectedIds)
})
const results = computed<QuickOpenResult[]>(() => {
  const normalizedKeyword = keyword.value.trim().toLocaleLowerCase()
  const folderById = new Map(props.folders.map((folder) => [folder.id, folder]))
  const sourceNotes = normalizedKeyword || hasFilters.value ? searchNotes.value : props.notes
  return sourceNotes
    .filter((note) => !note.isDeleted)
    .map((note) => {
      const folderPath = getFolderPath(note.folderId, folderById)
      const searchText = [note.title, note.content, note.tags.map((tag) => tag.name).join(' '), folderPath]
        .join(' ')
        .toLocaleLowerCase()
      const score = normalizedKeyword
        ? Number(note.title.toLocaleLowerCase().includes(normalizedKeyword)) * 4
          + Number(note.tags.some((tag) => tag.name.toLocaleLowerCase().includes(normalizedKeyword))) * 3
          + Number(folderPath.toLocaleLowerCase().includes(normalizedKeyword)) * 2
          + Number(note.content.toLocaleLowerCase().includes(normalizedKeyword))
        : 0
      return {
        note,
        folderPath,
        excerpt: formatNoteExcerpt(note.content),
        contentMatched: Boolean(normalizedKeyword && note.content.toLocaleLowerCase().includes(normalizedKeyword)),
        searchText,
        score
      }
    })
    .filter((result) => !normalizedKeyword || result.searchText.includes(normalizedKeyword))
    .sort((left, right) => right.score - left.score || Date.parse(right.note.updatedAt) - Date.parse(left.note.updatedAt))
    .slice(0, 12)
    .map(({ note, folderPath, excerpt, contentMatched }) => ({ note, folderPath, excerpt, contentMatched }))
})

/** 从本地设置读取最多八条最近搜索词。 */
function loadHistory(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem('notes-quick-open-history') || '[]')
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 8)
      : []
  } catch {
    return []
  }
}

/** 将搜索历史同时写入响应式状态和本地存储。 */
function saveHistory(nextHistory: string[]): void {
  history.value = nextHistory.slice(0, 8)
  window.localStorage.setItem('notes-quick-open-history', JSON.stringify(history.value))
}

/** 记录完成跳转的搜索词并忽略大小写去重。 */
function rememberKeyword(value: string): void {
  const normalizedKeyword = value.trim()
  if (!normalizedKeyword) return
  saveHistory([
    normalizedKeyword,
    ...history.value.filter((item) => item.toLocaleLowerCase() !== normalizedKeyword.toLocaleLowerCase())
  ])
}

/** 生成笔记所在文件夹的完整路径。 */
function getFolderPath(noteFolderId: string | null, folderById: Map<string, NoteFolder>): string {
  if (!noteFolderId) return '未分类'
  const names: string[] = []
  const visited = new Set<string>()
  let currentId: string | null = noteFolderId
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId)
    const folder = folderById.get(currentId)
    if (!folder || folder.isDeleted) break
    names.unshift(folder.name)
    currentId = folder.parentId
  }
  return names.join(' / ') || '未分类'
}

/** 将相对更新时间转换为 SQLite 可比较的 ISO 时间。 */
function getUpdatedAfter(): string | undefined {
  if (updatedWithin.value === 'all') return undefined
  return new Date(Date.now() - Number(updatedWithin.value) * 24 * 60 * 60 * 1000).toISOString()
}

/** 防抖查询本地 SQLite；请求编号避免旧查询覆盖新结果。 */
function scheduleSearch(rawKeyword: string): void {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = undefined
  const normalizedKeyword = rawKeyword.trim()
  const requestId = ++searchRequestId
  if (!normalizedKeyword && !hasFilters.value) {
    searchNotes.value = []
    return
  }
  searchTimer = setTimeout(() => {
    searchTimer = undefined
    void window.notesDesktop.searchNotes(normalizedKeyword, {
      includeMetadata: true,
      limit: 80,
      folderIds: selectedFolderIds.value,
      tagIds: tagId.value ? [tagId.value] : [],
      updatedAfter: getUpdatedAfter(),
      pinnedOnly: pinnedOnly.value
    }).then((notes) => {
      if (requestId === searchRequestId) searchNotes.value = notes
    }).catch(() => {
      if (requestId === searchRequestId) searchNotes.value = []
    })
  }, 80)
}

function toggleFilterMenu(menu: Exclude<FilterMenu, null>): void {
  const nextMenu = filterMenu.value === menu ? null : menu
  folderSearchKeyword.value = ''
  tagSearchKeyword.value = ''
  filterMenu.value = nextMenu
}

function chooseFolder(value: string | null): void {
  folderId.value = value || ''
  filterMenu.value = null
}

function chooseTag(value: string | null): void {
  tagId.value = value || ''
  filterMenu.value = null
}

function chooseUpdatedWithin(value: UpdatedWithin): void {
  updatedWithin.value = value
  filterMenu.value = null
}

function clearFilters(): void {
  folderId.value = ''
  tagId.value = ''
  updatedWithin.value = 'all'
  pinnedOnly.value = false
  filterMenu.value = null
}

function applyHistory(value: string): void {
  keyword.value = value
  activeIndex.value = 0
  void nextTick(() => input.value?.focus())
}

function chooseResult(result: QuickOpenResult): void {
  const currentKeyword = keyword.value.trim()
  visible.value = false
  rememberKeyword(currentKeyword)
  emit('select', { note: result.note, keyword: currentKeyword, contentMatched: result.contentMatched })
}

function scrollActiveResultIntoView(): void {
  void nextTick(() => {
    resultsElement.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  })
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    activeIndex.value = Math.min(activeIndex.value + 1, Math.max(results.value.length - 1, 0))
    scrollActiveResultIntoView()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    activeIndex.value = Math.max(activeIndex.value - 1, 0)
    scrollActiveResultIntoView()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const result = results.value[activeIndex.value]
    if (result) chooseResult(result)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    if (filterMenu.value) filterMenu.value = null
    else visible.value = false
  }
}

watch(visible, (isVisible) => {
  if (!isVisible) return
  keyword.value = ''
  filterMenu.value = null
  activeIndex.value = 0
  void nextTick(() => input.value?.focus())
})
watch(keyword, (value) => {
  activeIndex.value = 0
  scheduleSearch(value)
})
watch([folderId, tagId, updatedWithin, pinnedOnly], () => {
  activeIndex.value = 0
  scheduleSearch(keyword.value)
})
watch(() => props.notes.map((note) => `${note.id}:${note.updatedAt}`).join('|'), () => {
  if (keyword.value.trim() || hasFilters.value) scheduleSearch(keyword.value)
})

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})
</script>

<template>
  <div v-if="visible" class="dialog-backdrop quick-open-backdrop" @click.self="visible = false">
    <section class="quick-open-dialog" role="dialog" aria-modal="true" aria-label="快速打开笔记" @click="filterMenu = null">
      <button class="dialog-close-button" type="button" aria-label="关闭快速打开窗口" @click="visible = false"><Icon icon="tabler:x" /></button>
      <div class="quick-open-search">
        <Icon icon="tabler:search" />
        <input ref="input" v-model="keyword" placeholder="搜索标题、正文、标签或文件夹" autocomplete="off" @keydown="handleKeydown" />
        <button :class="['quick-open-filter-toggle', { active: hasFilters }]" type="button" :aria-expanded="filtersVisible" aria-label="显示高级搜索筛选" @click="filtersVisible = !filtersVisible">
          <Icon icon="tabler:adjustments-horizontal" /><span>{{ hasFilters ? '筛选中' : '筛选' }}</span>
        </button>
        <kbd>Esc</kbd>
      </div>

      <div v-if="filtersVisible" class="quick-open-filters" @click.stop>
        <div class="quick-open-filter-field">
          <span>文件夹</span>
          <div :class="['quick-open-filter-control', { active: folderId }]">
            <button class="quick-open-filter-trigger" type="button" :aria-expanded="filterMenu === 'folder'" @click="toggleFilterMenu('folder')"><Icon icon="tabler:folder" /><span>{{ folderLabel }}</span><Icon v-if="!folderId" icon="tabler:chevron-down" /></button>
            <button v-if="folderId" class="quick-open-filter-item-clear" type="button" aria-label="清除文件夹筛选" @click.stop="folderId = ''; filterMenu = null"><Icon icon="tabler:x" /></button>
          </div>
          <FolderPickerPopover v-if="filterMenu === 'folder'" v-model:search-keyword="folderSearchKeyword" class="quick-open-filter-popover" title="筛选文件夹" aria-label="选择文件夹" root-label="全部文件夹" root-icon="tabler:folders" :count-label="`${folderOptions.length} 个`" :folders="folderOptions" :selected-folder-id="folderId || null" @select="chooseFolder" />
        </div>

        <div class="quick-open-filter-field">
          <span>标签</span>
          <div :class="['quick-open-filter-control', { active: tagId }]">
            <button class="quick-open-filter-trigger" type="button" :aria-expanded="filterMenu === 'tag'" @click="toggleFilterMenu('tag')"><Icon icon="tabler:tag" /><span>{{ tagLabel }}</span><Icon v-if="!tagId" icon="tabler:chevron-down" /></button>
            <button v-if="tagId" class="quick-open-filter-item-clear" type="button" aria-label="清除标签筛选" @click.stop="tagId = ''; filterMenu = null"><Icon icon="tabler:x" /></button>
          </div>
          <div v-if="filterMenu === 'tag'" class="property-popover quick-open-filter-popover" role="listbox" aria-label="筛选标签">
            <div class="property-popover-title"><span>筛选标签</span><small>{{ tags.length }} 个</small></div>
            <label class="tag-picker-search"><Icon icon="tabler:search" /><input v-model="tagSearchKeyword" autofocus type="search" placeholder="搜索标签" /></label>
            <button v-if="!tagSearchKeyword.trim()" :class="['folder-picker-option', { selected: !tagId }]" type="button" role="option" :aria-selected="!tagId" @click="chooseTag(null)"><Icon icon="tabler:tags" /><span>全部标签</span><Icon v-if="!tagId" icon="material-symbols:check-rounded" /></button>
            <div class="property-popover-divider"></div>
            <div class="folder-picker-scroll">
              <button v-for="tag in filteredTags" :key="tag.id" :class="['folder-picker-option', { selected: tagId === tag.id }]" type="button" role="option" :aria-selected="tagId === tag.id" @click="chooseTag(tag.id)"><Icon icon="tabler:tag" /><span>{{ tag.name }}</span><Icon v-if="tagId === tag.id" icon="material-symbols:check-rounded" /></button>
              <p v-if="!filteredTags.length" class="folder-picker-empty">没有匹配的标签</p>
            </div>
          </div>
        </div>

        <div class="quick-open-filter-field">
          <span>更新时间</span>
          <div :class="['quick-open-filter-control', { active: updatedWithin !== 'all' }]">
            <button class="quick-open-filter-trigger" type="button" :aria-expanded="filterMenu === 'time'" @click="toggleFilterMenu('time')"><Icon icon="tabler:clock" /><span>{{ updatedLabel }}</span><Icon v-if="updatedWithin === 'all'" icon="tabler:chevron-down" /></button>
            <button v-if="updatedWithin !== 'all'" class="quick-open-filter-item-clear" type="button" aria-label="清除更新时间筛选" @click.stop="updatedWithin = 'all'; filterMenu = null"><Icon icon="tabler:x" /></button>
          </div>
          <div v-if="filterMenu === 'time'" class="property-popover quick-open-filter-popover quick-open-time-popover" role="menu" aria-label="筛选更新时间">
            <button v-for="option in updatedOptions" :key="option.value" type="button" role="menuitem" @click="chooseUpdatedWithin(option.value)"><span>{{ option.label }}</span><Icon v-if="updatedWithin === option.value" icon="material-symbols:check-rounded" /></button>
          </div>
        </div>

        <button :class="['quick-open-pinned-filter', { active: pinnedOnly }]" type="button" :aria-pressed="pinnedOnly" aria-label="仅显示置顶笔记" @click="pinnedOnly = !pinnedOnly"><Icon icon="tabler:pinned" />置顶</button>
        <button class="quick-open-filter-clear" type="button" :disabled="!hasFilters" @click="clearFilters">清除</button>
      </div>

      <div v-if="!keyword && !hasFilters && history.length" class="quick-open-history">
        <span>最近搜索</span>
        <div v-for="item in history" :key="item" class="quick-open-history-item">
          <button type="button" :aria-label="`使用最近搜索 ${item}`" @click="applyHistory(item)">{{ item }}</button>
          <button type="button" :aria-label="`删除最近搜索 ${item}`" @click.stop="saveHistory(history.filter((value) => value !== item))"><Icon icon="tabler:x" /></button>
        </div>
        <button class="quick-open-history-clear" type="button" aria-label="清空最近搜索" @click="saveHistory([])">清空</button>
      </div>

      <div ref="resultsElement" class="quick-open-results" role="listbox" aria-label="笔记搜索结果">
        <button v-for="(result, index) in results" :key="result.note.id" :class="{ active: index === activeIndex }" type="button" role="option" :aria-selected="index === activeIndex" @mouseenter="activeIndex = index" @click="chooseResult(result)">
          <Icon icon="tabler:file-text" />
          <span><strong>{{ result.note.title || '无标题笔记' }}</strong><small>{{ result.excerpt || '暂无正文内容' }}</small></span>
          <em>{{ result.folderPath }}</em>
        </button>
        <div v-if="!results.length" class="quick-open-empty"><Icon icon="tabler:file-search" />没有找到匹配的笔记</div>
      </div>

      <footer>
        <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>Enter</kbd> 打开</span>
        <small v-if="!keyword && !hasFilters">最近更新的笔记</small><small v-else-if="hasFilters">已应用高级筛选</small>
      </footer>
    </section>
  </div>
</template>
