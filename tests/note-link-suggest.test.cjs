const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const read = (relativePath) => fs.readFileSync(resolve(projectRoot, relativePath), 'utf8')

const editor = read('src/components/MarkdownVisualEditor.vue')
const popover = read('src/components/LinkSuggestPopover.vue')

/**
 * `[[` 补全的候选规模与浮层可读性守卫。
 *
 * 这组行为的共同点是**出错也不报错**，只是「看起来能用但不好用」：
 *
 * 1. 候选被写死成 8 条 —— 用户以为自己的笔记没被搜到，其实是渲染前被砍掉了
 *    （有搜索词那支先 `searchNotes(limit: 50)` 再砍成 8，白取 42 条）；
 * 2. 条目一多，键盘 ↑/↓ 选中项会滚出浮层视野（原先没有滚动跟随，
 *    8 条刚好不超高所以看不出来）；
 * 3. 浮层只声明 `overflow-y` 会让 `overflow-x` 计算成 `auto`，
 *    配合未收缩的 nowrap 标题就冒出一条横向滚动条。
 */

test('候选上限是常量而非写死的 8 条', () => {
  assert.match(editor, /const LINK_SUGGEST_RECENT_LIMIT = 20/)
  assert.match(editor, /const LINK_SUGGEST_SEARCH_LIMIT = 50/)
  assert.doesNotMatch(
    editor,
    /\.slice\(0, 8\)/,
    '两处 slice(0, 8) 是「只显示几条」的根因，不许回退'
  )
})

test('空关键词取最近更新、有关键词取搜索结果，各自用到上限常量', () => {
  assert.match(editor, /\.slice\(0, LINK_SUGGEST_RECENT_LIMIT\)/)
  assert.match(editor, /\.slice\(0, LINK_SUGGEST_SEARCH_LIMIT\)/)
  assert.match(
    editor,
    /searchNotes\(text, \{ limit: LINK_SUGGEST_SEARCH_LIMIT \}\)/,
    '搜索上限要和取回条数同源，否则又会「取了再砍」'
  )
})

test('浮层接收关键词，用于高亮摘要命中片段', () => {
  assert.match(editor, /:keyword="linkSuggestQuery"/)
  assert.match(popover, /keyword\?: string/)
  assert.match(popover, /<SearchExcerpt :content="note\.content" :keyword="keyword" \/>/)
})

test('条目显示正文摘要（数据来自 IPC 预处理的 content）', () => {
  assert.match(popover, /v-if="note\.content" class="link-suggest__excerpt"/)
  assert.match(popover, /class="link-suggest__title"/)
})

test('键盘选中项会滚进浮层视野', () => {
  assert.match(popover, /function scrollActiveIntoView\(\): void/)
  assert.match(
    popover,
    /watch\(\s*\(\) => props\.activeIndex,/,
    '↑/↓ 改的是 activeIndex，不监听它就不会跟随滚动'
  )
  assert.doesNotMatch(
    popover,
    /scrollIntoView\(/,
    '浮层是 position: fixed 的 Teleport 节点，scrollIntoView 会连带滚动文档'
  )
})

test('浮层不出现横向滚动条', () => {
  assert.match(popover, /(?:^|\n)\s*overflow-x: hidden;/)
  assert.match(
    popover,
    /\.link-suggest__list \{[^}]*?grid-template-columns: minmax\(0, 1fr\);/,
    'grid 的自动轨道会被 nowrap 内容撑宽，必须显式 minmax(0, 1fr)'
  )
  assert.match(
    popover,
    /\.link-suggest__item \{[^}]*?min-width: 0;/,
    'grid item 的自动最小尺寸不放开，轨道照样被顶开'
  )
  assert.match(
    popover,
    /\.link-suggest__body \{[^}]*?min-width: 0;/,
    'flex 项的默认 min-width: auto 会让 nowrap 文本顶开父级'
  )
  assert.match(
    popover,
    /\.link-suggest__title \{[^}]*?min-width: 0;/,
    '标题自身也要允许收缩'
  )
})
