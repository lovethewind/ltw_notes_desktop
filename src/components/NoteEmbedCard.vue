<template>
  <div class="note-embed-card" :class="{ 'is-deleted': deleted, 'is-loading': loading, 'is-expanded': expanded }" role="button" tabindex="0" draggable="false" :aria-expanded="canExpand ? expanded : undefined" @click="onCardClick" @keydown.enter="onCardClick" @keydown.space.prevent="onCardClick" @contextmenu="onContextMenu">
    <template v-if="loading">
      <Icon class="note-embed-card__icon note-embed-card__icon--spin" icon="material-symbols:progress-activity-rounded" />
      <span class="note-embed-card__title note-embed-card__title--placeholder">正在加载笔记…</span>
    </template>

    <template v-else-if="deleted || missing">
      <Icon class="note-embed-card__icon note-embed-card__icon--missing" icon="material-symbols:error-outline-rounded" />
      <div class="note-embed-card__body">
        <span class="note-embed-card__title note-embed-card__title--missing">{{ fallbackTitle || '（笔记不可用）' }}</span>
        <span class="note-embed-card__hint">{{ deleted ? '此笔记已被删除或移入回收站' : '此笔记不存在' }}</span>
      </div>
    </template>

    <template v-else>
      <div class="note-embed-card__body">
        <span v-if="folderName" class="note-embed-card__meta">
          <Icon icon="material-symbols:folder-outline-rounded" />{{ folderName }}
        </span>
        <span class="note-embed-card__title">{{ title }}</span>
        <span v-if="excerpt && !expanded" class="note-embed-card__excerpt">{{ excerpt }}</span>
        <div class="note-embed-card__foot">
          <span class="note-embed-card__meta note-embed-card__meta--time">
            <Icon icon="material-symbols:schedule-rounded" />{{ formatDate(updatedAt) }}
          </span>
          <!--
            纯提示，不是按钮：展开入口只有卡片主体（onCardClick）。平时隐藏、hover / 聚焦才淡入，
            避免「只有这行小字能点」的误导；文案明确指向卡片本身。不拦点击，点在文字上由主体接管。
          -->
          <span v-if="canExpand" class="note-embed-card__expand-hint" aria-hidden="true">
            <Icon :icon="expanded ? 'material-symbols:expand-less-rounded' : 'material-symbols:expand-more-rounded'" />
            {{ expanded ? '点击卡片收起' : '点击卡片展开全文' }}
          </span>
        </div>
      </div>
      <button
        class="note-embed-card__open"
        type="button"
        title="打开笔记"
        aria-label="打开笔记"
        @click.stop="open"
        @keydown.stop
      >
        <Icon class="note-embed-card__arrow" icon="material-symbols:arrow-forward-rounded" />
      </button>
      <!--
        展开区必须显式 draggable="false" 且拦掉 dragstart：
        卡片节点被 PM 选中时 selectNode() 会给容器重新加回 draggable=true，
        届时在正文里拖选文字会变成「拖整张卡片」。拦在展开区，保证拖拽=选文字。
      -->
      <div
        v-if="expanded"
        class="note-embed-card__full"
        draggable="false"
        @click.stop="onFullClick"
        @keydown.stop
        @dragstart.prevent.stop
      >
        <div class="note-embed-card__full-inner" v-html="fullHtml"></div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { NoteFolder, OfflineNote } from '../types'
import { dispatchOpenNote } from '../utils/note-open-events'

const props = withDefaults(defineProps<{ noteId: string; title?: string | null }>(), {
  title: null
})

/**
 * 卡片向宿主（nodeView）冒泡的交互事件。
 * - context-menu：右键卡片，由宿主补上节点位置后转交编辑器弹出卡片专属菜单；
 *   available 表示目标笔记是否可正常打开（不存在/已删除为 false，菜单据此禁用打开类操作）。
 */
const emit = defineEmits<{ (e: 'context-menu', payload: { x: number; y: number; available: boolean }): void }>()

const loading = ref(true)
const deleted = ref(false)
const missing = ref(false)
const note = ref<OfflineNote | null>(null)
const folders = ref<NoteFolder[]>([])

const title = ref<string>('')
const folderName = ref<string>('')
const updatedAt = ref<string>('')
const excerpt = ref<string>('')

/** 被嵌笔记正文原文（getNote 返回的 content）；仅在展开时才解析渲染。 */
const rawContent = ref<string>('')
/** 正文去 markdown 记号后的纯文本，用于判断摘要之外是否还有内容可展开。 */
const plainText = ref<string>('')
const expanded = ref(false)
const fullHtml = ref<string>('')

/** 摘要固定截前 160 字，正文更长时才提供「展开全文」。 */
const canExpand = computed(() => plainText.value.length > 160)

const fallbackTitle = props.title && props.title.trim() ? props.title : ''

async function loadCard(): Promise<void> {
  loading.value = true
  deleted.value = false
  missing.value = false
  note.value = null
  expanded.value = false
  fullHtml.value = ''
  rawContent.value = ''
  plainText.value = ''
  try {
    if (!folders.value.length) {
      const workspace = await window.notesDesktop.listWorkspace().catch(() => null)
      folders.value = workspace?.folders || []
    }
    const target = await window.notesDesktop.getNote(props.noteId)
    if (!target) {
      missing.value = true
      return
    }
    if (target.isDeleted) {
      deleted.value = true
      return
    }
    note.value = target
    title.value = target.title || fallbackTitle || '（无标题）'
    folderName.value = folders.value.find((f) => f.id === target.folderId)?.name || ''
    updatedAt.value = target.updatedAt || ''
    rawContent.value = target.content || ''
    plainText.value = stripMarkdown(rawContent.value)
    excerpt.value = plainText.value.slice(0, 160)
  } catch {
    missing.value = true
  } finally {
    loading.value = false
  }
}

function stripMarkdown(raw: string): string {
  // 轻量去 markdown 记号，仅用于摘要展示；不解析 data-xynote-embed，避免递归。
  if (!raw) return ''
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // 图片 → alt 文本
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接 → 文本
    .replace(/<[^>]+>/g, ' ') // 残留 HTML 标签 → 空格（含 data-xynote-embed 容器）
    .replace(/[#>*_`~|-]{1,}/g, ' ') // markdown 记号
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 展开 / 收起全文。首次展开时才把 markdown 渲染成 HTML（懒加载），
 * 避免文档里每张卡片都在加载阶段都做一次解析。
 *
 * :return: 无返回值。
 */
function toggleExpanded(): void {
  if (!canExpand.value) return
  if (!expanded.value && !fullHtml.value) {
    fullHtml.value = renderNoteBody(rawContent.value)
  }
  expanded.value = !expanded.value
}

/**
 * 把被嵌笔记的 markdown 正文渲染为可安全插入的 HTML。
 * 先摘掉嵌套的嵌入卡片 HTML（展开视图不递归渲染，避免 A↔B 互相展开成环），
 * 再经 marked 解析、DOMPurify 清洗（与 useAppUpdate / AiAssistantPanel 同一套做法）。
 *
 * :param raw: 笔记正文 markdown 原文。
 * :return: 清洗后的 HTML 字符串。
 */
function renderNoteBody(raw: string): string {
  const withoutNested = raw.replace(
    /<div[^>]*data-xynote-embed=[^>]*>[\s\S]*?<\/div>/gi,
    // 用带专属 data 标记的单行段落，而非 markdown 引用块：
    // 引用块 = blockquote(margin 8px) + 内层 p(margin 8px) 叠加，高度会翻倍且样式无法单独收敛。
    // DOMPurify 默认放行 data-* 属性，因此该标记能稳定穿过 sanitize，供样式精准命中。
    '\n\n<p data-xynote-embed-placeholder>此处原有一张嵌入卡片，请到原笔记中查看</p>\n\n'
  )
  return DOMPurify.sanitize(marked.parse(withoutNested, { async: false }))
}

/**
 * 展开区内的点击：拦下链接交给主进程打开（站内笔记链接转应用内打开、外链走系统浏览器），
 * 避免渲染进程被 <a> 默认导航带走；其余点击只阻止冒泡，不让卡片跟着跳转。
 *
 * :param event: 展开区内的原生 click 事件。
 * :return: 无返回值。
 */
function onFullClick(event: MouseEvent): void {
  const anchor = event.target instanceof Element ? event.target.closest('a') : null
  if (!anchor) return
  event.preventDefault()
  const href = anchor.getAttribute('href') || ''
  if (!/^https?:\/\//i.test(href)) return
  void window.notesDesktop.openExternalLink(href).catch(() => {
    /* 链接打不开不影响阅读全文 */
  })
}

function formatDate(value: string): string {
  if (!value) return ''
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value)
  return match ? match[0].replace(/-/g, '.') : ''
}

/**
 * 卡片主体（含标题/摘要/底部）的默认点击：优先展开 / 收起全文，
 * 不直接跳转，避免在展开区选字、滚动或只是想看一眼时误触打开笔记。
 * 无可展开内容（短笔记 / 加载中 / 不可用）时退回打开笔记——此时卡片只有这一个动作。
 *
 * :return: 无返回值。
 */
function onCardClick(): void {
  if (canExpand.value) {
    toggleExpanded()
    return
  }
  open()
}

/**
 * 打开目标笔记。仅由卡片右侧箭头按钮触发（无展开内容的卡片也会由主体点击兜底调用）。
 *
 * :return: 无返回值。
 */
function open(): void {
  if (loading.value || missing.value || deleted.value) return
  // 在新标签页打开目标笔记，保留当前阅读上下文（由 App.vue 路由到 openNoteInNewTab）。
  dispatchOpenNote(props.noteId, true)
}

/**
 * 右键卡片：阻止浏览器原生菜单，把坐标冒泡给宿主 nodeView（由其补节点位置后转交编辑器）。
 *
 * 关键：必须 stopPropagation。ProseMirror nodeView 的 stopEvent 只让 PM 自身忽略事件，
 * 管不住挂在编辑器根节点上的原生 contextmenu 监听；不拦冒泡时正文右键菜单会随后弹出并覆盖卡片菜单。
 *
 * :param event: 原生 contextmenu 事件。
 * :return: 无返回值。
 */
function onContextMenu(event: MouseEvent): void {
  // 卡片区域内一律吞掉右键，避免冒泡到编辑器根节点
  event.preventDefault()
  event.stopPropagation()
  // 加载中尚未确定目标，不弹菜单
  if (loading.value) return
  // 缺失/已删除态照常弹菜单：仍可执行「删除卡片」等结构操作
  emit('context-menu', {
    x: event.clientX,
    y: event.clientY,
    available: !missing.value && !deleted.value
  })
}

watch(() => props.noteId, loadCard)
onMounted(loadCard)
</script>

<style scoped>
.note-embed-card {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel);
  cursor: pointer;
  text-align: left;
  user-select: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
}
.note-embed-card:hover {
  border-color: var(--blue);
  background: var(--surface);
  box-shadow: 0 4px 16px rgba(47, 128, 237, 0.1);
}
.note-embed-card:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}

.note-embed-card__body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}

.note-embed-card__title {
  overflow: hidden;
  color: var(--ink);
  font-size: 14px;
  font-weight: 680;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.note-embed-card__title--missing {
  color: var(--muted);
  font-weight: 600;
}

.note-embed-card__excerpt {
  overflow: hidden;
  color: var(--muted);
  font-size: 12px;
  line-height: 18px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.note-embed-card__meta {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--muted);
  font-size: 11px;
}
.note-embed-card__meta svg {
  width: 12px;
  height: 12px;
}
.note-embed-card__meta--time {
  color: var(--muted);
}

.note-embed-card__hint {
  color: var(--muted);
  font-size: 12px;
  line-height: 18px;
}

.note-embed-card__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 2px;
}

/*
 * 展开提示：不可点的纯提示文字，平时隐藏（opacity 保留占位，避免 hover 时布局抖动），
 * 悬停卡片头部 / 键盘聚焦时淡入，文案明确指向「卡片本身」而不是这行字。
 * 只绑 __body 而非整卡：展开区拦了冒泡、点它不会收起，在那里提示「点击卡片收起」会误导。
 */
.note-embed-card__expand-hint {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px 2px 2px 0;
  color: var(--muted);
  font-size: 11px;
  line-height: 16px;
  user-select: none;
  opacity: 0;
  transition: opacity 0.15s ease, color 0.15s ease;
}
.note-embed-card__body:hover .note-embed-card__expand-hint,
.note-embed-card:focus-visible .note-embed-card__expand-hint {
  opacity: 1;
  color: var(--blue);
}
.note-embed-card__expand-hint svg {
  width: 14px;
  height: 14px;
}

/* 展开区：flex-basis 100% 让它整行折到卡片下方，自身可滚、可选中 */
.note-embed-card__full {
  flex-basis: 100%;
  width: 100%;
  min-width: 0;
  padding-top: 10px;
  border-top: 1px solid var(--line);
  cursor: auto;
  user-select: text;
}
.note-embed-card__full-inner {
  max-height: min(52vh, 420px);
  overflow: auto;
  overscroll-behavior: contain;
  color: var(--ink);
  font-size: 13px;
  line-height: 1.7;
  word-break: break-word;
}

/* v-html 内容不受 scoped 约束，需 :deep 才能命中 */
.note-embed-card__full-inner :deep(> *:first-child) { margin-top: 0; }
.note-embed-card__full-inner :deep(> *:last-child) { margin-bottom: 0; }
.note-embed-card__full-inner :deep(h1),
.note-embed-card__full-inner :deep(h2),
.note-embed-card__full-inner :deep(h3),
.note-embed-card__full-inner :deep(h4),
.note-embed-card__full-inner :deep(h5),
.note-embed-card__full-inner :deep(h6) {
  margin: 12px 0 6px;
  font-size: 14px;
  font-weight: 680;
  line-height: 1.4;
}
.note-embed-card__full-inner :deep(p) { margin: 0 0 8px; }
.note-embed-card__full-inner :deep(ul),
.note-embed-card__full-inner :deep(ol) { margin: 0 0 8px; padding-left: 20px; }
.note-embed-card__full-inner :deep(li) { margin: 2px 0; }
.note-embed-card__full-inner :deep(a) { color: var(--blue); text-decoration: none; }
.note-embed-card__full-inner :deep(a:hover) { text-decoration: underline; }
.note-embed-card__full-inner :deep(code) {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--surface);
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
}
.note-embed-card__full-inner :deep(pre) {
  margin: 0 0 8px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--surface);
  overflow-x: auto;
}
.note-embed-card__full-inner :deep(pre code) { padding: 0; background: none; }
.note-embed-card__full-inner :deep(blockquote) {
  margin: 0 0 8px;
  padding: 2px 0 2px 10px;
  border-left: 3px solid var(--line);
  color: var(--muted);
}
/* 嵌套嵌入卡片的占位：单行紧凑灰条，不复用引用块样式（否则 margin+padding 叠加显高） */
.note-embed-card__full-inner :deep([data-xynote-embed-placeholder]) {
  margin: 0 0 6px;
  padding: 3px 10px;
  border-radius: 6px;
  background: var(--surface);
  color: var(--muted);
  font-size: 12px;
  line-height: 16px;
}
.note-embed-card__full-inner :deep(img) { max-width: 100%; border-radius: 8px; }
.note-embed-card__full-inner :deep(hr) { margin: 12px 0; border: none; border-top: 1px solid var(--line); }
.note-embed-card__full-inner :deep(table) {
  width: 100%;
  margin: 0 0 8px;
  border-collapse: collapse;
  font-size: 12px;
}
.note-embed-card__full-inner :deep(th),
.note-embed-card__full-inner :deep(td) {
  padding: 4px 6px;
  border: 1px solid var(--line);
  text-align: left;
}

.note-embed-card__icon {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  color: var(--blue);
}
.note-embed-card__icon--missing {
  color: var(--muted);
}
.note-embed-card__icon--spin {
  animation: note-embed-card-spin 1s linear infinite;
}

/* 打开笔记入口：只有点这个箭头/按钮才跳转，「点卡片=展开」从而避免误触 */
.note-embed-card__open {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  /* 负 margin 抵消 padding，视觉位置与原来一致、热区更大 */
  padding: 4px;
  margin: -4px -4px -4px 0;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--muted);
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
}
.note-embed-card__open:hover {
  color: var(--blue);
  background: var(--surface);
}
.note-embed-card__open:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}

.note-embed-card__arrow {
  width: 18px;
  height: 18px;
  transition: transform 0.15s ease;
}
.note-embed-card:hover .note-embed-card__arrow {
  color: var(--blue);
}
.note-embed-card__open:hover .note-embed-card__arrow {
  color: var(--blue);
  transform: translateX(2px);
}

@keyframes note-embed-card-spin {
  to { transform: rotate(360deg); }
}
</style>
