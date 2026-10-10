/**
 * 主编辑器的 `.ProseMirror` 规则必须**只作用于主编辑器**——样式作用域守卫。
 *
 * ## 为什么要有这个文件
 *
 * 编辑器里不止一个 `.ProseMirror`：Crepe 的行内公式编辑气泡会内嵌**第二个 EditorView**
 * （`.milkdown > .milkdown-latex-inline-edit > .container > div > .ProseMirror`）。
 * `src/style.css` 里那条主规则带 `min-height: calc(100vh - 250px)`，一旦写回**后代选择器**，
 * 这个「一行的输入框」就会被撑成一屏高 —— 2026-10-08 用户报的「公式弹窗有问题」正是如此
 * （实测气泡 222×674，窗口 920 高）。
 *
 * ## 为什么正则断言放在单测
 *
 * 位置/尺寸的**真行为**由 `tests/e2e/inline-formula-tooltip.e2e.test.cjs` 量 rect 守住；
 * 这里只钉「接线口径」，让快速单测就能拦住「有人把 `>` 去掉」这种回归，不必等 e2e。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const STYLE = 'src/style.css'
const css = readFileSync(resolve(projectRoot, STYLE), 'utf8')

test('主编辑器 ProseMirror 规则必须是直接子代（否则会泄漏进公式气泡）', () => {
  assert.match(
    css,
    /\.milkdown-editor-root \.milkdown > \.ProseMirror\s*\{/,
    '主编辑器规则应写成 `.milkdown-editor-root .milkdown > .ProseMirror`'
  )
  // ⚠️ 杀手是 min-height: calc(100vh - 250px)：写成后代选择器时它会把公式气泡的内层编辑器
  //    撑成一屏高。项目里还有几条合法的后代写法（只读态 caret 色 / 冲突版本 min-height:100% /
  //    ≥1600px 的 padding-inline / 暗色 color），所以这里**只钉「视口级高度」**：
  //    嵌套编辑器不该有任何以 vh 计的 min-height。
  const descendantRules = [
    ...css.matchAll(/\.milkdown-editor-root \.milkdown \.ProseMirror\s*\{([^}]*)\}/g)
  ].map((m) => m[1])
  const offenders = descendantRules.filter((body) => /min-height\s*:[^;]*vh/.test(body))
  assert.equal(
    offenders.length,
    0,
    `后代选择器写法不得用 vh 设置 min-height（会泄漏到公式编辑气泡）：${JSON.stringify(offenders)}`
  )
})

test('公式编辑气泡里的内层编辑器必须有显式复位规则', () => {
  const block = css.match(
    /\.milkdown-editor-root \.milkdown \.milkdown-latex-inline-edit \.ProseMirror\s*\{[^}]*\}/
  )?.[0]
  assert.ok(block, '应有一条针对 `.milkdown-latex-inline-edit .ProseMirror` 的复位规则')
  assert.match(block, /min-height:\s*0/, '复位规则必须把 min-height 归零')
  assert.match(block, /width:\s*auto/, '复位规则必须把 width 放开')
  // 特异性要高于 3 类名（Crepe 主题的 `.milkdown .milkdown-latex-inline-edit .ProseMirror`）。
  assert.ok(
    (block.match(/\./g) || []).length >= 4,
    '复位规则的选择器至少要有 4 个类名，压过 Crepe 主题的同名规则'
  )
})
