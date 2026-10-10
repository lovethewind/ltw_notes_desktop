const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const read = (relativePath) => fs.readFileSync(resolve(projectRoot, relativePath), 'utf8')

const viewer = read('src/components/ConflictDiffViewer.vue')
const app = read('src/App.vue')
const styles = read('src/style.css')

/**
 * 冲突对比视图的接线守卫。
 *
 * 差异算法本身由 `tests/text-diff.test.cjs` 用真实数据守住；这里只钉「接线」：
 * 视图必须用同一个滚动容器、两列必须同宽、填充行与暗色分支必须存在。
 *
 * ⚠️ 冲突中心只有「同步结果 → 立即处理」一个入口，而同步需要真实服务端，
 * 因此这里没有 e2e：一旦有人把两列拆成两个各自滚动的容器，界面上会悄悄
 * 从「同步滚动」退回「各滚各的」，只有这条断言能拦住。
 */
test('左右两列共用同一个滚动容器（同步滚动的前提）', () => {
  // 真正要守的是 DOM：模板里只能有一个滚动容器，两列必须是它的后代。
  const template = viewer.slice(viewer.indexOf('<template>'))
  assert.equal(
    (template.match(/class="conflict-diff__scroll"/g) ?? []).length,
    1,
    '模板里只允许一个滚动容器；拆成两个就失去「天然同步滚动」'
  )
  // 行必须是滚动容器的子树：把 v-for 移出容器就等于两列各滚各的。
  const rowsIndex = template.indexOf('class="conflict-diff__row"')
  const scrollIndex = template.indexOf('class="conflict-diff__scroll"')
  assert.ok(scrollIndex > 0 && rowsIndex > scrollIndex, '差异行必须渲染在滚动容器内部')
})

test('两列用同一套网格列，保证同行等高、行号对齐', () => {
  assert.match(
    styles,
    /\.conflict-diff__columns,\s*\.conflict-diff__row\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/,
    '行与表头必须共用 repeat(2, minmax(0, 1fr))，否则左右列宽不一致、看起来会错位'
  )
})

test('差异算法只有一个真源（视图层不得自己再算一遍）', () => {
  assert.match(viewer, /import \{ diffTextLines, type DiffCell, type DiffRow \} from '\.\.\/utils\/text-diff'/)
  assert.doesNotMatch(app, /diffTextLines/, 'App.vue 不应直接调用差异算法')
})

test('差异行、填充行与行内高亮都有对应实现', () => {
  assert.match(viewer, /'is-removed':\s*cell\.status === 'removed'/)
  assert.match(viewer, /'is-added':\s*cell\.status === 'added'/)
  assert.match(viewer, /'is-void':\s*true/, '另一侧没有对应行时要渲染填充格')
  assert.match(viewer, /<mark v-if="segment\.changed"/, '行内改动片段要用 mark 标出')
  assert.match(styles, /\.conflict-diff__cell\.is-void\s*\{/, '填充格必须有可见样式')
})

test('跳转：记录当前差异序号，并给该处加 is-current 强调', () => {
  assert.match(viewer, /currentHunk/)
  assert.match(viewer, /'is-current':\s*row\.hunkIndex !== null && row\.hunkIndex === currentHunk\.value/)
  assert.match(viewer, /container\.querySelector<HTMLElement>\(`\.conflict-diff__row\[data-row="\$\{starts\[next\]\}"\]`\)/)
  assert.match(viewer, /diff\.value\.hunkStartIndexes/)
  assert.match(styles, /\.conflict-diff__row\.is-current \.conflict-diff__cell\.is-removed\s*\{/)
})

test('暗色主题给差异配色单独覆盖（否则浅底浅字）', () => {
  assert.match(styles, /html\[data-theme="dark"\]\)\s*\{[\s\S]*\.conflict-diff \{/, '暗色 @scope 里应有 .conflict-diff 的覆盖')
  assert.match(styles, /\.conflict-diff__row\.is-diff \.conflict-diff__cell\.is-removed \{ background: rgba\(190,123,25/)
  assert.match(styles, /\.conflict-diff__row\.is-diff \.conflict-diff__cell\.is-added \{ background: rgba\(65,126,191/)
})

test('App.vue：差异对比为默认视图，富文本视图按原实现保留', () => {
  assert.match(app, /import ConflictDiffViewer from '\.\/components\/ConflictDiffViewer\.vue'/)
  assert.match(app, /const conflictViewMode = ref<'diff' \| 'rich'>\('diff'\)/)
  assert.match(app, /<ConflictDiffViewer\s+v-else-if="selectedConflictDetail && conflictViewMode === 'diff'"/)
  // 富文本那套并排渲染必须还在（走 else-if 分支）。
  assert.match(app, /<div v-else-if="selectedConflictDetail" class="conflict-compare-grid">/)
  assert.match(app, /<button[\s\S]{0,240}@click="conflictViewMode = 'rich'"/)
  assert.match(styles, /\.conflict-detail \{ min-width: 0;/)
})

test('页面文案不与「差异」按钮混淆：两处按钮各自绑定自己的模式', () => {
  assert.match(app, /:aria-pressed="conflictViewMode === 'diff'"/)
  assert.match(app, /:aria-pressed="conflictViewMode === 'rich'"/)
})
