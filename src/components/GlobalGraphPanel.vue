<template>
  <div ref="rootRef" class="global-graph">
    <header class="global-graph__header">
      <div class="global-graph__title">
        <Icon icon="material-symbols:hub-rounded" />
        <strong>全局知识图谱</strong>
        <small>全库双链关系 · 共 {{ graph.nodes.length }} 个节点 / {{ graph.links.length }} 条关系</small>
      </div>
      <label class="global-graph__search">
        <Icon icon="tabler:search" />
        <input v-model="keyword" type="search" placeholder="筛选节点标题" />
      </label>
      <button class="global-graph__close" type="button" aria-label="关闭全局图谱" @click="emit('close')">
        <Icon icon="tabler:x" />
      </button>
    </header>

    <div v-if="loading" class="global-graph__state">正在构建全库图谱…</div>
    <div v-else-if="!graph.nodes.length" class="global-graph__state">
      <Icon class="global-graph__state-icon" icon="material-symbols:hub-rounded" />
      <p>还没有笔记通过双链关联</p>
      <span>在笔记里插入链接后，这里会展示全库关系网络</span>
    </div>
    <div
      v-else
      ref="stageRef"
      class="global-graph__stage"
      @mousedown="startPan"
      @wheel.prevent="handleWheel"
    >
      <svg ref="svgRef" class="global-graph__canvas" :viewBox="`0 0 ${canvasWidth} ${canvasHeight}`" role="img" aria-label="全局知识图谱">
        <g :transform="`translate(${panX}, ${panY}) scale(${scale})`">
          <line
            v-for="(edge, index) in linkLines"
            :key="`${edge.sourceX}-${edge.sourceY}-${edge.targetX}-${edge.targetY}-${index}`"
            :x1="edge.sourceX"
            :y1="edge.sourceY"
            :x2="edge.targetX"
            :y2="edge.targetY"
            class="global-graph__edge"
          />
          <g
            v-for="node in positionedNodes"
            :key="node.id"
            class="global-graph__node"
            :class="{ 'is-hidden': hiddenNodeIds.has(node.id) }"
            :transform="`translate(${node.x}, ${node.y})`"
            role="button"
            :aria-label="`打开 ${node.title}`"
            tabindex="0"
            @click.stop="openNote(node.id)"
            @keydown.enter="openNote(node.id)"
          >
            <circle :r="nodeRadius(node)" :style="{ fill: folderColor(node) }" class="global-graph__node-dot" />
            <text class="global-graph__node-label" :dy="nodeRadius(node) + 13">{{ truncateTitle(node.title) }}</text>
          </g>
        </g>
      </svg>
      <div class="global-graph__hint">滚轮缩放 · 拖拽平移 · 点击节点打开</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum
} from 'd3-force'
import { Icon } from '@iconify/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { GlobalGraph } from '../types'

const props = defineProps<{ maxNodes?: number }>()
const emit = defineEmits<{ close: [] }>()

type GraphNodeDatum = SimulationNodeDatum & { id: string, title: string, folderId: string | null, isRoot: boolean }
type GraphLinkDatum = SimulationLinkDatum<GraphNodeDatum> & { source: string, target: string }

/** 文件夹着色色板，按 folderId 稳定映射，未分类使用主题蓝。 */
const COLOR_PALETTE = ['#2f80ed', '#7c9bff', '#38b2a3', '#e38b3f', '#c06bd8', '#3fae6a', '#e0607a']

const rootRef = ref<HTMLDivElement | null>(null)
const stageRef = ref<HTMLDivElement | null>(null)
const svgRef = ref<SVGSVGElement | null>(null)
const graph = ref<GlobalGraph>({ nodes: [], links: [] })
const positionedNodes = ref<GraphNodeDatum[]>([])
const linkLines = ref<Array<{ sourceX: number, sourceY: number, targetX: number, targetY: number }>>([])
const loading = ref(true)
const keyword = ref('')
const panX = ref(0)
const panY = ref(0)
const scale = ref(1)
const canvasWidth = ref(0)
const canvasHeight = ref(0)

let simulation: ReturnType<typeof forceSimulation<GraphNodeDatum>> | undefined
let resizeObserver: ResizeObserver | undefined
let panning = false
let panStartX = 0
let panStartY = 0
let panOriginX = 0
let panOriginY = 0

const hiddenNodeIds = computed(() => {
  const kw = keyword.value.trim().toLocaleLowerCase()
  if (!kw) return new Set<string>()
  return new Set(graph.value.nodes
    .filter((node) => !node.title.toLocaleLowerCase().includes(kw))
    .map((node) => node.id))
})

/** 节点半径随连接度轻微放大，未分类统一取默认值。 */
function nodeRadius(node: GraphNodeDatum): number {
  return Math.max(6, Math.min(18, 7 + (node.title.length % 6)))
}

/** 根据 folderId 稳定分配到色板，未分类显示蓝色。 */
function folderColor(node: GraphNodeDatum): string {
  if (!node.folderId) return '#2f80ed'
  let hash = 0
  for (const char of node.folderId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return COLOR_PALETTE[hash % COLOR_PALETTE.length]
}

/** 超过一定长度的标题做截断，避免文字溢出。 */
function truncateTitle(title: string): string {
  return title.length > 14 ? `${title.slice(0, 14)}…` : title
}

/** 初始位置：按分组随机铺开，避免全部挤在原点。 */
function seedPositions(nodes: GraphNodeDatum[], width: number, height: number): void {
  nodes.forEach((node, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(1, nodes.length)
    const radius = 30 + (index % 12) * 24
    node.x = width / 2 + radius * Math.cos(angle)
    node.y = height / 2 + radius * Math.sin(angle)
  })
}

/** 读取全库图谱数据并驱动力导向布局。 */
async function loadGraph(): Promise<void> {
  loading.value = true
  try {
    graph.value = await window.notesDesktop.getGlobalGraph(props.maxNodes)
  } finally {
    loading.value = false
  }
  await nextTick()
  runSimulation()
}

function openNote(noteId: string): void {
  void window.notesDesktop.openNoteLink(noteId).catch(() => {})
  emit('close')
}

function runSimulation(): void {
  const svg = svgRef.value
  if (!svg) return
  const width = stageRef.value?.clientWidth || svg.clientWidth || 640
  const height = stageRef.value?.clientHeight || 480
  if (width !== canvasWidth.value) canvasWidth.value = width
  if (height !== canvasHeight.value) canvasHeight.value = height
  const nodes: GraphNodeDatum[] = graph.value.nodes.map((node) => ({
    id: node.id,
    title: node.title,
    folderId: node.folderId,
    depth: node.depth,
    isRoot: false
  }))
  const links: GraphLinkDatum[] = graph.value.links.map((link) => ({
    source: link.source,
    target: link.target
  }))
  seedPositions(nodes, width, height)

  simulation?.stop()
  simulation = forceSimulation<GraphNodeDatum>(nodes)
    .force('link', forceLink<GraphNodeDatum, GraphLinkDatum>(links)
      .id((node) => node.id)
      .distance(64)
      .strength(0.55))
    .force('charge', forceManyBody<GraphNodeDatum>().strength(-120))
    .force('collide', forceCollide<GraphNodeDatum>().radius(20))
    .force('x', forceX<GraphNodeDatum>(width / 2).strength(0.08))
    .force('y', forceY<GraphNodeDatum>(height / 2).strength(0.08))
    .on('tick', () => {
      positionedNodes.value = nodes.map((node) => ({ ...node }))
      linkLines.value = links.map((link) => {
        const source = link.source as GraphNodeDatum
        const target = link.target as GraphNodeDatum
        return { sourceX: source.x ?? 0, sourceY: source.y ?? 0, targetX: target.x ?? 0, targetY: target.y ?? 0 }
      })
    })
}

/** 拖拽平移画布。 */
function startPan(event: MouseEvent): void {
  if ((event.target as Element)?.closest('.global-graph__node')) return
  panning = true
  panStartX = event.clientX
  panStartY = event.clientY
  panOriginX = panX.value
  panOriginY = panY.value
  window.addEventListener('mousemove', movePan)
  window.addEventListener('mouseup', endPan)
}

function movePan(event: MouseEvent): void {
  if (!panning) return
  panX.value = panOriginX + (event.clientX - panStartX)
  panY.value = panOriginY + (event.clientY - panStartY)
}

function endPan(): void {
  panning = false
  window.removeEventListener('mousemove', movePan)
  window.removeEventListener('mouseup', endPan)
}

/** 滚轮缩放，聚焦鼠标位置。 */
function handleWheel(event: WheelEvent): void {
  const rect = stageRef.value?.getBoundingClientRect()
  if (!rect) return
  const factor = event.deltaY < 0 ? 1.1 : 0.9
  const nextScale = Math.max(0.3, Math.min(2.5, scale.value * factor))
  const mouseX = event.clientX - rect.left
  const mouseY = event.clientY - rect.top
  // 缩放同时补偿平移，让鼠标下的点保持不动。
  panX.value = mouseX - ((mouseX - panX.value) / scale.value) * nextScale
  panY.value = mouseY - ((mouseY - panY.value) / scale.value) * nextScale
  scale.value = nextScale
}

onMounted(() => {
  void loadGraph()
  const root = rootRef.value
  if (!root) return
  resizeObserver = new ResizeObserver((entries) => {
    const entry = entries[0]
    if (entry?.contentRect.width && svgRef.value) runSimulation()
  })
  resizeObserver.observe(root)
})

watch(
  () => props.maxNodes,
  () => { void loadGraph() }
)

onBeforeUnmount(() => {
  simulation?.stop()
  simulation = undefined
  resizeObserver?.disconnect()
  resizeObserver = undefined
  window.removeEventListener('mousemove', movePan)
  window.removeEventListener('mouseup', endPan)
})
</script>

<style scoped>
.global-graph {
  display: flex;
  flex-direction: column;
  width: min(1100px, calc(100vw - 40px));
  height: min(720px, calc(100vh - 56px));
  border-radius: 16px;
  overflow: hidden;
  background: var(--global-graph-bg, #f5f8fd);
  box-shadow: 0 24px 70px rgba(19, 34, 56, 0.35);
}

.global-graph__header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--global-graph-border, #dfe7f1);
  background: var(--global-graph-header, #fff);
}

.global-graph__title {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.global-graph__title > svg {
  width: 19px;
  height: 19px;
  color: var(--blue, #2f80ed);
}

.global-graph__title strong {
  color: var(--ink, #26374d);
  font-size: 14px;
}

.global-graph__title small {
  color: var(--muted, #78869b);
  font-size: 11px;
  white-space: nowrap;
}

.global-graph__search {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
  width: 220px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--global-graph-border, #cfdae7);
  border-radius: 8px;
  background: var(--global-graph-header, #fff);
}

.global-graph__search svg {
  width: 15px;
  height: 15px;
  color: var(--muted, #78869b);
}

.global-graph__search input {
  min-width: 0;
  flex: 1;
  border: 0;
  background: transparent;
  color: var(--ink, #304159);
  font-size: 12px;
  outline: none;
}

.global-graph__close {
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted, #66778d);
  cursor: pointer;
}

.global-graph__close:hover {
  background: rgba(47, 128, 237, 0.08);
  color: var(--blue, #2f80ed);
}

.global-graph__stage {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  cursor: grab;
}

.global-graph__stage:active {
  cursor: grabbing;
}

.global-graph__canvas {
  width: 100%;
  height: 100%;
}

.global-graph__node {
  cursor: pointer;
  outline: none;
}

.global-graph__node-dot {
  stroke: #fff;
  stroke-width: 1.5px;
}

.global-graph__node-label {
  fill: var(--text, #37475f);
  font-size: 10px;
  text-anchor: middle;
  pointer-events: none;
}

.global-graph__edge {
  stroke: rgba(100, 125, 160, 0.28);
  stroke-width: 1px;
}

.global-graph__node.is-hidden {
  opacity: 0.18;
}

.global-graph__state {
  display: grid;
  place-items: center;
  align-content: center;
  gap: 5px;
  flex: 1;
  color: var(--muted, #78869b);
  text-align: center;
  font-size: 12px;
}

.global-graph__state-icon {
  width: 30px;
  height: 30px;
  color: var(--blue, #2f80ed);
  opacity: 0.8;
}

.global-graph__state p {
  margin: 0;
  color: var(--ink, #26374d);
  font-weight: 650;
}

.global-graph__hint {
  position: absolute;
  right: 12px;
  bottom: 10px;
  padding: 4px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.8);
  color: var(--muted, #78869b);
  font-size: 10px;
  pointer-events: none;
}
</style>
