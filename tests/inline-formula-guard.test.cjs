/**
 * 工具栏「插入 → 行内公式」的安全守卫。
 *
 * ## 为什么必须有这道判定（2026-10-16 网页端先报，桌面端同源同码）
 *
 * Crepe 的 `ToggleLatex` 把 `doc.textBetween(from, to)` 当公式内容。**无选区**时
 * 取到空串 → 插进来一个**空公式节点**：
 *
 * 1. 屏幕上它零宽、看不见 —— 用户以为「点了没反应」；
 * 2. 序列化成 Markdown 是一个孤零零的 `$$`（已用 remark 实测）：这行若落在行首或独占一行，
 *    重新打开笔记时会被解析成**块级公式**的开头，把后面所有正文一口吞进公式里。
 *
 * 选区落在图片 / 嵌入卡这类原子节点上时 `textBetween` 同样是空串，会直接把卡片换掉。
 * 所以判定必须是「选区里有可包的文字」**或**「选中的本来就是公式节点（这次是拆掉）」，
 * 两者都不满足就只给提示，一个字都不动。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const readSource = (filePath) => readFileSync(resolve(projectRoot, filePath), 'utf8')

const EDITOR = 'src/components/MarkdownVisualEditor.vue'

test('无选区时不调用 ToggleLatex，只给提示', () => {
  const source = readSource(EDITOR)

  assert.match(
    source,
    /if \(!hasFormula && doc\.textBetween\(selection\.from, selection\.to, '\\n'\)\.trim\(\) === ''\) return false/
  )
  assert.match(source, /请先选中要转成公式的文字/)
  // 反面：不能再出现「不作任何判定、直接 call」的裸调用（数据损坏的入口）。
  assert.doesNotMatch(
    source,
    /editor\?\.editor\.action\(\(context\) => context\.get\(commandsCtx\)\.call\('ToggleLatex'\)\)/
  )
})

test('选中的本来就是公式节点时仍能拆掉', () => {
  const source = readSource(EDITOR)

  assert.match(source, /function selectionHasInlineFormula\(view: ProseMirrorView\): boolean \{/)
  assert.match(source, /const mathType = view\.state\.schema\.nodes\.math_inline/)
  assert.match(source, /view\.state\.doc\.nodesBetween\(from, to,/)
})
