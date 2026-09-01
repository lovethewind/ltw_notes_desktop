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

function openNote(noteId: string): void {
  void window.notesDesktop.openNoteLink(noteId).catch(() => {})
}

/** 基于当前节点/边运行力导向布局，并把坐标回写到 SVG。 */
function runSimulation(): void {
  const svg = svgRef.value
  if (!svg) return
  // 以容器真实宽度作为坐标空间，viewBox 与显示 1:1，保证中心节点视觉居中。
  const width = canvasWidth.value || svg.clientWidth || 320
  const height = canvasHeight.value || 280
  if (width !== canvasWidth.value) canvasWidth.value = width
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
  resizeObserver = new ResizeObserver((entries) => {
    const entry = entries[0]
    const nextWidth = entry?.contentRect.width ?? 0
    if (nextWidth && Math.abs(nextWidth - canvasWidth.value) > 1) {
      canvasWidth.value = nextWidth
      if (svgRef.value) runSimulation()
    }
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

.note-graph__canvas {
  width: 100%;
  height: 280px;
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
