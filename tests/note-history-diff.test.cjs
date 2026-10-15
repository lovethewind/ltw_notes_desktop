const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const read = (relativePath) => fs.readFileSync(resolve(projectRoot, relativePath), 'utf8')

const dialog = read('src/components/NoteHistoryDialog.vue')
const viewer = read('src/components/ConflictDiffViewer.vue')
const styles = read('src/style.css')

/**
 * 历史版本「对比改动」的接线守卫。
 *
 * 差异算法由 `tests/text-diff.test.cjs` 用真实数据守住、对比视图的结构由
 * `tests/conflict-diff-view.test.cjs` 守住；这里只钉历史版本这一侧的接线，
 * 因为有两件事**没有任何界面报错**、错了也只是「看起来没改动」：
 *
 * 1. 「上一版」取错方向（取成更新的一条）—— 差异会整体反过来，用户据此判断
 *    「这一版加了什么」就会得到相反结论；
 * 2. 两版正文没都到手就渲染 —— 未加载的一侧是空串，界面显示成「整篇都是新增」，
 *    与真的新增无法区分。
 */

test('历史弹窗有「预览 / 对比改动」两个档位，默认落在对比档', () => {
  assert.match(
    dialog,
    /const viewMode = ref<'preview' \| 'diff'>\('diff'\)/,
    '默认档位的取值决定了打开历史版本时先看到什么'
  )
  assert.match(dialog, /@click="viewMode = 'preview'"/)
  assert.match(dialog, /@click="viewMode = 'diff'"/)
  assert.match(dialog, /class="history-view-switch"[\s\S]*?aria-label="历史版本查看方式"/)
})

test('对比档复用 ConflictDiffViewer，左=上一版、右=选中版本', () => {
  assert.match(dialog, /import ConflictDiffViewer from '\.\/ConflictDiffViewer\.vue'/)
  assert.match(
    dialog,
    /<ConflictDiffViewer[\s\S]*?:left-content="previousHistory\?\.content \?\? ''"[\s\S]*?:right-content="selectedHistory\.content"/,
    '左旧右新：左侧必须是更早的那一版'
  )
  assert.match(dialog, /right-label="此版本"/)
})

test('「上一版」取列表中更旧的那一条（下标 +1）', () => {
  // 列表按 created_at 倒序，所以「更旧」在下标更大的方向。
  assert.match(dialog, /return index >= 0 \? \(histories\.value\[index \+ 1\] \?\? null\) : null/)
  assert.match(dialog, /const previousHistory = computed\(/)
})

test('选中版本时把「上一版」的正文一起取回（两条都要）', () => {
  assert.match(dialog, /function findOlderHistory\(historyId: string\): NoteHistory \| null/)
  assert.match(
    dialog,
    /await ensureHistoryLoaded\(historyId\)[\s\S]*?await ensureHistoryLoaded\(findOlderHistory\(historyId\)\?\.id \?\? null\)/,
    '预览档与对比档共用一次加载：对比要用的上一版也得取回来'
  )
})

test('两侧正文没都到手之前不渲染差异（否则整篇被误读成新增）', () => {
  assert.match(
    dialog,
    /const compareLoading = computed\(\(\) => \{[\s\S]*?if \(!selectedLoaded\.value\) return true[\s\S]*?Boolean\(base && !loadedHistoryIds\.value\.has\(base\.id\)\)/,
    '加载门禁必须同时覆盖选中版本与上一版'
  )
  assert.match(dialog, /<div v-else-if="compareLoading" class="history-empty">/)
})

test('最旧的一版没有更早版本可比时给出提示，而不是静默留一片新增色', () => {
  assert.match(dialog, /<p v-if="!previousHistory" class="history-diff-hint">/)
  assert.match(dialog, /:left-label="previousHistory \? '上一版' : '无更早版本'"/)
})

test('对比视图的列头图标可传入（历史版本两侧都是同一篇笔记，设备/云图标会误导）', () => {
  assert.match(viewer, /leftIcon: 'tabler:device-laptop'/)
  assert.match(viewer, /rightIcon: 'tabler:cloud'/)
  assert.match(viewer, /<Icon :icon="props\.leftIcon" \/>/)
  assert.match(viewer, /<Icon :icon="props\.rightIcon" \/>/)
  assert.match(dialog, /left-icon="tabler:history"[\s\S]*?right-icon="tabler:file-text"/)
})

test('切换档与对比容器都有样式，且暗色下单独覆盖', () => {
  assert.match(styles, /\.history-view-switch button\s*\{/)
  assert.match(styles, /\.history-view-switch button\.is-active\s*\{/)
  assert.match(styles, /\.history-diff\s*\{/)
  assert.match(styles, /\.history-diff-hint\s*\{/)
  // 暗色分支：亮色底 #f5f8fb 在暗色下会刺眼，必须有覆盖。
  assert.match(styles, /\.history-view-switch button \{ border-color: #30445f; background: #1a2b43;/)
  assert.match(styles, /\.history-diff-hint \{ background: rgba\(47,128,237,\.14\)/)
})

/**
 * 版式守卫：弹窗宽度、档位高度、对比行高与底部留白（与网页端同一套口径）。
 *
 * ⚠️ `.conflict-diff*` 是**历史版本与冲突中心共享**的样式。所以这一组行高
 * 必须挂在 `.history-diff` 前缀下 —— 最后一条断言就是钉住冲突中心不被带改。
 */
test('历史弹窗的宽度、档位高度与对比行高', () => {
  assert.match(styles, /\.history-dialog \{ width: min\(1120px, calc\(100vw - 56px\)\)/)
  // 弹窗尽量高：上限 780px，上下各只留 22px。
  assert.match(styles, /\.history-dialog \{ width: min\(1120px, calc\(100vw - 56px\)\); height: min\(780px, calc\(100vh - 44px\)\)/)
  // 右侧第一行（版本标题 + 档位）压薄；标题字号收一档，竖向空间让给对比正文。
  assert.match(styles, /\.history-preview-head \{ flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 22px 8px 26px; \}/)
  assert.match(styles, /\.history-preview h3 \{[^}]*?font-size: 16px;/)
  // 统计条（「共 N 处差异」+ 上一处/下一处）是元信息行：压薄，且按钮要跟着收，否则自己把 bar 撑回 34px。
  assert.match(styles, /\.history-diff \.conflict-diff__bar \{ min-height: 30px; padding: 4px 10px; \}/)
  assert.match(styles, /\.history-diff \.conflict-diff__nav button \{ height: 22px; padding: 0 8px; \}/)
  assert.match(styles, /\.history-view-switch button \{ height: 32px;/)
  assert.match(
    styles,
    /\.history-diff \.conflict-diff \{ margin-top: 8px; margin-bottom: 18px; \}/,
    '对比卡片要跟弹窗底部留出距离'
  )
  assert.match(styles, /\.history-diff \.conflict-diff__cell \{ padding: 3px 12px 3px 0; \}/)
  assert.match(styles, /\.history-diff \.conflict-diff__text \{ min-height: 1\.8em; font-size: 12px; line-height: 1\.8; \}/)
  // 冲突中心自己的行高保持紧凑（一屏要尽量多放行以便人工核对）。
  assert.match(styles, /\.conflict-diff__cell \{ position: relative; min-width: 0; display: flex; gap: 8px; padding: 1px 12px 1px 0; \}/)
  assert.match(styles, /\.conflict-diff__text \{[\s\S]*?font-size: 11\.5px; line-height: 1\.75;/)
})
