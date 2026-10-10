<script setup lang="ts">
/**
 * 同步冲突对比视图（并排文本 diff）。
 *
 * 为什么不用富文本渲染对比：Crepe 会把 Markdown 的行合并、重排（软换行并进同一段落、
 * 列表拆成 `<li>`），源码行与渲染块没有稳定对应，差异只能做到「整段变色」这种粗粒度。
 * 而冲突对比要回答的是「到底哪一行、哪几个字不一样」——用户据此决定保留哪一份，
 * 看错就是真丢内容，所以这里直接按行比对。
 *
 * 两侧行在同一个滚动容器里用同一套网格列渲染，同行两格由网格行高统一撑开，
 * 因此**两侧天生逐行对齐、滚动天生同步** —— 不需要监听 scroll，也就没有回环问题。
 */
import { Icon } from '@iconify/vue'
import { computed, ref, watch } from 'vue'
import { diffTextLines, type DiffCell, type DiffRow } from '../utils/text-diff'

interface Props {
  /** 左侧正文（本地冲突副本）。 */
  leftContent?: string
  /** 右侧正文（当前云端版本）。 */
  rightContent?: string
  /** 左侧列标题。 */
  leftLabel?: string
  /** 右侧列标题。 */
  rightLabel?: string
}

const props = withDefaults(defineProps<Props>(), {
  leftContent: '',
  rightContent: '',
  leftLabel: '本地冲突版本',
  rightLabel: '当前云端版本'
})

const scroller = ref<HTMLElement | null>(null)
/** 当前定位到的差异序号（-1 表示还没跳过）。 */
const currentHunk = ref(-1)

const diff = computed(() => diffTextLines(props.leftContent, props.rightContent))
const leftLineCount = computed(() => diff.value.rows.filter((row) => row.left).length)
const rightLineCount = computed(() => diff.value.rows.filter((row) => row.right).length)

/** 单元格样式：按差异归属着色，填充格（另一侧没有对应行）用斜纹。 */
function cellClass(cell: DiffCell | null): Record<string, boolean> {
  if (!cell) return { 'is-void': true }
  return {
    'is-removed': cell.status === 'removed',
    'is-added': cell.status === 'added',
    'is-changed': cell.status !== 'same' && Boolean(cell.segments)
  }
}

/** 行样式：当前跳转到的那一处差异整体加强调。 */
function rowClass(row: DiffRow): Record<string, boolean> {
  return {
    'is-diff': row.hunkIndex !== null,
    'is-current': row.hunkIndex !== null && row.hunkIndex === currentHunk.value
  }
}

/**
 * 跳到上一处 / 下一处差异。
 *
 * 循环跳转：到底后再按一次回到第一处 —— 差异通常只有几处，来回对比时不用先回顶部。
 *
 * :param step: 1 表示下一处，-1 表示上一处。
 * :return: 无返回值。
 */
function jumpHunk(step: number): void {
  const starts = diff.value.hunkStartIndexes
  const container = scroller.value
  if (!starts.length || !container) return
  const next = ((currentHunk.value + step) % starts.length + starts.length) % starts.length
  currentHunk.value = next

  const row = container.querySelector<HTMLElement>(`.conflict-diff__row[data-row="${starts[next]}"]`)
  if (!row) return
  // 用矩形差算偏移，而不是 offsetTop：后者依赖 offsetParent，容器外面套几层 flex 就会算错。
  const header = container.querySelector<HTMLElement>('.conflict-diff__columns')
  const offset = (header?.offsetHeight ?? 0) + 6
  const top = container.scrollTop + (row.getBoundingClientRect().top - container.getBoundingClientRect().top) - offset
  container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
}

// 换了一篇冲突笔记就重置跳转位置：上一份的序号（比如第 3 处）对新正文毫无意义，
// 留着只会让新内容一打开就有一段被莫名其妙强调。
watch(() => [props.leftContent, props.rightContent], () => {
  currentHunk.value = -1
  scroller.value?.scrollTo({ top: 0 })
})
</script>

<template>
  <div class="conflict-diff">
    <header class="conflict-diff__bar">
      <span :class="['conflict-diff__stat', { 'is-clean': !diff.hunkCount }]">
        <Icon :icon="diff.hunkCount ? 'tabler:git-compare' : 'tabler:circle-check'" />
        <template v-if="diff.hunkCount">共 <strong>{{ diff.hunkCount }}</strong> 处差异（{{ diff.changedLineCount }} 行）</template>
        <template v-else>两侧内容完全一致</template>
      </span>
      <div class="conflict-diff__nav">
        <button
          type="button"
          :disabled="!diff.hunkCount"
          aria-label="上一处差异"
          @click="jumpHunk(-1)"
        >
          <Icon icon="tabler:chevron-up" />上一处
        </button>
        <button
          type="button"
          :disabled="!diff.hunkCount"
          aria-label="下一处差异"
          @click="jumpHunk(1)"
        >
          <Icon icon="tabler:chevron-down" />下一处
        </button>
      </div>
    </header>

    <!-- 单一滚动容器：左右两列共用一个滚动条，滚动天然同步 -->
    <div ref="scroller" class="conflict-diff__scroll">
      <div class="conflict-diff__columns">
        <div class="conflict-diff__column-head is-local">
          <Icon icon="tabler:device-laptop" />
          <strong>{{ props.leftLabel }}</strong>
          <small>{{ leftLineCount }} 行</small>
        </div>
        <div class="conflict-diff__column-head is-remote">
          <Icon icon="tabler:cloud" />
          <strong>{{ props.rightLabel }}</strong>
          <small>{{ rightLineCount }} 行</small>
        </div>
      </div>

      <div
        v-for="(row, index) in diff.rows"
        :key="index"
        class="conflict-diff__row"
        :class="rowClass(row)"
        :data-row="index"
      >
        <div class="conflict-diff__cell" :class="cellClass(row.left)">
          <span class="conflict-diff__no">{{ row.left?.lineNo ?? '' }}</span>
          <span class="conflict-diff__text">
            <template v-if="row.left?.segments">
              <template v-for="(segment, segmentIndex) in row.left.segments" :key="segmentIndex">
                <mark v-if="segment.changed" class="conflict-diff__mark">{{ segment.text }}</mark>
                <template v-else>{{ segment.text }}</template>
              </template>
            </template>
            <template v-else>{{ row.left?.text }}</template>
          </span>
        </div>
        <div class="conflict-diff__cell" :class="cellClass(row.right)">
          <span class="conflict-diff__no">{{ row.right?.lineNo ?? '' }}</span>
          <span class="conflict-diff__text">
            <template v-if="row.right?.segments">
              <template v-for="(segment, segmentIndex) in row.right.segments" :key="segmentIndex">
                <mark v-if="segment.changed" class="conflict-diff__mark">{{ segment.text }}</mark>
                <template v-else>{{ segment.text }}</template>
              </template>
            </template>
            <template v-else>{{ row.right?.text }}</template>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
