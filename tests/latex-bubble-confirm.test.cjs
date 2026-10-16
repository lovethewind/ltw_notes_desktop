/**
 * 行内公式气泡「确认按钮」的行为守卫（桌面端）。
 *
 * ## 为什么要有这条（2026-10-16 用户报）
 *
 * 气泡里**点了勾不关闭**。根因在 Crepe 的 `LatexInlineTooltip`：那个按钮只挂了
 * `pointerdown → updateValue`（把输入框文字写回 `math_inline` 的 `value`），
 * **一个字都不动选区**；而气泡显隐判据是
 * `selection instanceof NodeSelection && node.type.name === math_inline`，
 * 光标还赖在公式节点上，判据继续成立 → 值写完了气泡还杵在原地。
 *
 * 修法（探针实测有效）：确认后把光标挪到公式节点**后面**，`data-show` 由 `true` 转 `false`。
 * 这里钉住四个最容易被重构丢掉的接线事实；真行为由
 * `tests/e2e/inline-formula-button.e2e.test.cjs` 第 ⑥ 段守住。
 *
 * 同一份实现也在网页端（`ltw_front_v3/src/components/editor/MdEditor.vue`），
 * 那边由 `md-editor-latex-confirm.spec.ts` 守。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const readSource = (filePath) => readFileSync(resolve(projectRoot, filePath), 'utf8')

const EDITOR = 'src/components/MarkdownVisualEditor.vue'
const STYLE = 'src/style.css'

test('确认后把光标挪出公式节点（气泡才会收起）', () => {
  const source = readSource(EDITOR)

  assert.match(source, /function handleLatexBubbleConfirm\(event: PointerEvent\): void \{/)
  assert.match(source, /state\.selection instanceof NodeSelection/)
  assert.match(source, /TextSelection\.near\(state\.doc\.resolve\(pos\), 1\)/)
  // 反面：若放宽到整个气泡容器，点输入框 / 预览区也会把气泡收掉。
  assert.doesNotMatch(source, /closest\?\.\('\.milkdown-latex-inline-edit'\)/)
})

test('监听走冒泡阶段，且注册与移除成对', () => {
  const source = readSource(EDITOR)

  assert.match(source, /document\.addEventListener\('pointerdown', handleLatexBubbleConfirm\)/)
  assert.match(source, /document\.removeEventListener\('pointerdown', handleLatexBubbleConfirm\)/)
  // 反面：捕获阶段会**早于** Crepe 挂在 button 上的 handler 跑，那时选区还是旧的。
  assert.doesNotMatch(source, /addEventListener\('pointerdown', handleLatexBubbleConfirm, true\)/)
})

test('气泡抬到顶栏之上，且打开时块手柄让位', () => {
  const style = readSource(STYLE)

  assert.match(
    style,
    /\.milkdown-editor-root \.milkdown \.milkdown-latex-inline-edit \{ z-index: 30; \}/
  )
  assert.match(
    style,
    /\.milkdown-editor-shell \.milkdown-editor-root \.milkdown:has\(\.milkdown-latex-inline-edit\[data-show='true'\]\) \.milkdown-block-handle \{ opacity: 0; pointer-events: none; \}/
  )
})
