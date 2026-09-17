<template>
  <div ref="rootRef" class="note-graph">
    <div class="note-graph__toolbar">
      <span class="note-graph__label">关系图谱</span>
      <div class="note-graph__depths" role="group" aria-label="图谱深度">
        <button
          v-for="d in DEPTHS"
          :key="d"
          type="button"
          :class="['note-graph__depth', { 'is-active': depth === d }]"
          @click="setDepth(d)"
        >
          {{ d }} 跳
        </button>
      </div>
    </div>

    <div v-if="loading" class="note-graph__state">正在加载图谱…</div>
    <div v-else-if="!hasNodes" class="note-graph__state">
      <Icon class="note-graph__state-icon" icon="material-symbols:hub-rounded" />
      <p>还没有笔记引用此笔记</p>
      <span>在其它笔记里插入链接，就能在这里看到关系</span>
    </div>
    <svg
      v-else
      ref="svgRef"
      class="note-graph__canvas"
      :viewBox="`0 0 ${canvasWidth} ${canvasHeight}`"
      role="img"
      aria-label="笔记关系图谱"
      @click="handleBackgroundClick"
    >
      <g class="note-graph__edges">
        <line
          v-for="(edge, index) in linkLines"
          :key="`${edge.sourceX}-${edge.sourceY}-${edge.targetX}-${edge.targetY}-${index}`"
          :x1="edge.sourceX"
          :y1="edge.sourceY"
          :x2="edge.targetX"
          :y2="edge.targetY"
          class="note-graph__edge"
        />
      </g>
      <g class="note-graph__nodes">
        <g
          v-for="node in positionedNodes"
          :key="node.id"
          class="note-graph__node"
          :class="{ 'is-root': node.isRoot, [`is-depth-${node.depth}`]: !node.isRoot }"
          :transform="`translate(${node.x}, ${node.y})`"
          role="button"
          :aria-label="`打开 ${node.title}`"
          tabindex="0"
          @click.stop="openNote(node.id)"
          @keydown.enter="openNote(node.id)"
        >
          <circle :r="node.isRoot ? 13 : 8" class="note-graph__node-dot" />
          <text class="note-graph__node-label" dy="22">{{ truncateTitle(node.title) }}</text>
        </g>
      </g>
    </svg>
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
import type { NoteGraph } from '../types'
import { dispatchOpenNote } from '../utils/note-open-events'

const props = defineProps<{ noteId?: string }>()

type GraphNodeDatum = SimulationNodeDatum & { id: string, title: string, depth: number, isRoot: boolean }
type GraphLinkDatum = SimulationLinkDatum<GraphNodeDatum> & { source: string, target: string }

const DEPTHS = [1, 2, 3] as const

const rootRef = ref<HTMLDivElement | null>(null)
const svgRef = ref<SVGSVGElement | null>(null)
const loading = ref(false)
const depth = ref(2)
const graph = ref<NoteGraph>({ nodes: [], links: [], rootId: '' })
const positionedNodes = ref<GraphNodeDatum[]>([])
const linkLines = ref<Array<{ sourceX: number, sourceY: number, targetX: number, targetY: number }>>([])
let simulation: ReturnType<typeof forceSimulation<GraphNodeDatum>> | undefined
let resizeObserver: ResizeObserver | undefined
/** 上次观测到的容器高度，用于判断高度是否真的变化（宽度侧直接与 canvasWidth 比对）。 */
let lastRootHeight = 0
const canvasWidth = ref(0)
const canvasHeight = ref(280)

const hasNodes = computed(() => graph.value.nodes.length > 1)

/** 根据标题长度估算节点碰撞半径，避免标签在相邻节点间互相压住。 */
function collisionRadius(node: GraphNodeDatum): number {
  if (node.isRoot) return 22
  return Math.max(18, 12 + node.title.length * 3)
}

/** 超过一定长度的标题做截断，避免文字溢出画布。 */
function truncateTitle(title: string): string {
  return title.length > 12 ? `${title.slice(0, 12)}…` : title
}

/** 初始位置：中心笔记钉在画布中心，其余节点按深度分层环形分布。 */
function seedPositions(nodes: GraphNodeDatum[], width: number, height: number): void {
  const centerX = width / 2
  const centerY = height / 2
  const root = nodes.find((node) => node.isRoot)
  if (root) {
    root.x = centerX
    root.y = centerY
    root.fx = centerX
    root.fy = centerY
  }
  const layers = new Map<number, GraphNodeDatum[]>()
  for (const node of nodes) {
    if (node.isRoot) continue
    const layer = layers.get(node.depth) ?? []
    layer.push(node)
    layers.set(node.depth, layer)
  }
  const maxDepth = Math.max(1, ...[...layers.keys()])
  const maxRadius = Math.max(64, Math.min(width, height) / 2 - 34)
  for (const [layerDepth, layer] of layers) {
    const radius = maxRadius * (layerDepth / maxDepth)
    layer.forEach((node, index) => {
      const angle = -Math.PI / 2 + (Math.PI * 2 * index) / layer.length
      node.x = centerX + radius * Math.cos(angle)
      node.y = centerY + radius * Math.sin(angle)
    })
  }
}

/** 以中心笔记为根，展开深度可控的邻接图谱，并驱动 d3 力导向布局。 */
async function loadGraph(): Promise<void> {
  if (!props.noteId) return
  loading.value = true
  try {
    graph.value = await window.notesDesktop.getNoteGraph(props.noteId, depth.value)
  } finally {
    loading.value = false
  }
  // 先把 loading 收起、等 SVG 真正挂载后再驱动布局，否则 svgRef 仍为空。
  await nextTick()
  runSimulation()
}

function setDepth(next: number): void {
  if (depth.value === next) return
  depth.value = next
  void loadGraph()
}

/**
 * 打开图谱节点对应的笔记。
 *
 * 固定走「新标签页打开」：图谱是探索式浏览，点一个节点往往还要回来接着看别的邻居，
 * 原地切换会让图谱跟着跳到目标笔记、刚看出的结构就没了。
 * 不用 IPC `openNoteLink`：那条链路是原地切换，且仍被深链 / 站内链接复用，语义不动。
 *
 * :param noteId: 目标笔记 ID。
 * :return: 无返回值。
 */
function openNote(noteId: string): void {
  dispatchOpenNote(noteId, true)
}

/** 基于当前节点/边运行力导向布局，并把坐标回写到 SVG。 */
function runSimulation(): void {
  const svg = svgRef.value
  if (!svg) return
  // 以画布真实尺寸作为坐标空间，viewBox 与显示区 1:1，保证中心节点视觉居中。
  // 高度必须现测：侧栏页签下画布是 flex 撑满的，沿用 280 初值会让 viewBox 与显示区不匹配（图形被缩放/偏移）。
  const rect = svg.getBoundingClientRect()
  const width = Math.round(rect.width) || canvasWidth.value || 320
  const height = Math.round(rect.height) || canvasHeight.value || 280
  if (width !== canvasWidth.value) canvasWidth.value = width
  if (height !== canvasHeight.value) canvasHeight.value = height
  const nodes: GraphNodeDatum[] = graph.value.nodes.map((node) => ({
    id: node.id,
    title: node.title,
    depth: node.depth,
    isRoot: node.id === graph.value.rootId
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
      .distance(78)
      .strength(0.7))
    .force('charge', forceManyBody<GraphNodeDatum>().strength(-140))
    .force('collide', forceCollide<GraphNodeDatum>().radius(collisionRadius))
    .force('x', forceX<GraphNodeDatum>(width / 2).strength(0.12))
    .force('y', forceY<GraphNodeDatum>(height / 2).strength(0.12))
    .on('tick', () => {
      // 中心节点钉在画布中心，其余节点不许进入中心半径。
      const root = nodes.find((node) => node.isRoot)
      if (root) {
        root.fx = width / 2
        root.fy = height / 2
      }
      positionedNodes.value = nodes.map((node) => ({ ...node }))
      linkLines.value = links.map((link) => {
        const source = link.source as GraphNodeDatum
        const target = link.target as GraphNodeDatum
        return { sourceX: source.x ?? 0, sourceY: source.y ?? 0, targetX: target.x ?? 0, targetY: target.y ?? 0 }
      })
    })
}

function handleBackgroundClick(): void {
  // 点空白处不触发任何跳转，保留给未来缩放/平移。
}

watch(
  () => props.noteId,
  () => {
    void loadGraph()
  },
  { immediate: true },
)

onMounted(() => {
  const root = rootRef.value
  if (!root) return
  canvasWidth.value = root.clientWidth || 0
  lastRootHeight = root.clientHeight || 0
  resizeObserver = new ResizeObserver((entries) => {
    const entry = entries[0]
    const nextWidth = entry?.contentRect.width ?? 0
    const nextHeight = entry?.contentRect.height ?? 0
    let sizeChanged = false
    if (nextWidth && Math.abs(nextWidth - canvasWidth.value) > 1) {
      canvasWidth.value = nextWidth
      sizeChanged = true
    }
    // 画布现在是撑满容器的，高度变化同样要重跑布局（旧版只跟宽度，高度永远停在 280）。
    if (nextHeight && Math.abs(nextHeight - lastRootHeight) > 1) {
      lastRootHeight = nextHeight
      sizeChanged = true
    }
    if (sizeChanged && svgRef.value) runSimulation()
  })
  resizeObserver.observe(root)
})

onBeforeUnmount(() => {
  simulation?.stop()
  simulation = undefined
  resizeObserver?.disconnect()
  resizeObserver = undefined
})
</script>

<style scoped>
.note-graph {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.note-graph__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px 6px;
}

.note-graph__label {
  color: var(--muted, #78869b);
  font-size: 13px;
  font-weight: 600;
}

.note-graph__depths {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: rgba(24, 39, 63, 0.05);
}

.note-graph__depth {
  padding: 3px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted, #78869b);
  cursor: pointer;
  font-size: 11px;
}

.note-graph__depth.is-active {
  background: var(--blue, #2f80ed);
  color: #fff;
}

/* 高度交给容器：侧栏页签下画布要撑满剩余空间（旧版固定 280px 是因为它被塞在滚动流末尾） */
.note-graph__canvas {
  width: 100%;
  flex: 1;
  min-height: 220px;
  cursor: default;
}

.note-graph__node {
  cursor: pointer;
  outline: none;
}

.note-graph__node-dot {
  fill: var(--blue, #2f80ed);
  stroke: #fff;
  stroke-width: 1.5px;
}

.note-graph__node.is-root .note-graph__node-dot {
  fill: var(--blue, #2f80ed);
}

.note-graph__node.is-depth-1 .note-graph__node-dot {
  fill: #7c9bff;
}

.note-graph__node.is-depth-2 .note-graph__node-dot {
  fill: #a9b8e8;
}

.note-graph__node.is-depth-3 .note-graph__node-dot {
  fill: #c6cfe6;
}

.note-graph__node-label {
  fill: var(--text, #37475f);
  font-size: 10px;
  text-anchor: middle;
}

.note-graph__edge {
  stroke: rgba(100, 125, 160, 0.32);
  stroke-width: 1.2px;
}

.note-graph__state {
  display: grid;
  place-items: center;
  gap: 4px;
  min-height: 220px;
  padding: 16px;
  color: var(--muted, #78869b);
  text-align: center;
  font-size: 12px;
}

.note-graph__state-icon {
  width: 26px;
  height: 26px;
  color: var(--blue, #2f80ed);
  opacity: 0.8;
}

.note-graph__state p {
  margin: 0;
  font-weight: 600;
}

.note-graph__state span {
  font-size: 11px;
  opacity: 0.8;
}
</style>
