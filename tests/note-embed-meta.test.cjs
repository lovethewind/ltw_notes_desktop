const test = require('node:test')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')

/**
 * 嵌入卡片展示口径的真行为测试。
 *
 * 摘要与日期的算法是编辑态卡片（`NoteEmbedCard.vue`）与预览态占位卡
 * （`utils/markdown-preview.ts`）的**共用真源** —— 这里一改，两边卡片同时变，
 * 所以必须直接断言函数输出，而不是对源码做正则匹配。
 */
let metaModule

test.before(async () => {
  metaModule = await import(pathToFileURL(resolve(projectRoot, 'src/utils/note-embed-meta.ts')).href)
})

test('摘要截断长度与编辑态卡片一致（160）', () => {
  assert.equal(metaModule.NOTE_EMBED_EXCERPT_LENGTH, 160)
})

test('formatNoteDate 把 ISO 时间归成 YYYY.MM.DD', () => {
  assert.equal(metaModule.formatNoteDate('2026-10-13T09:51:00.000Z'), '2026.10.13')
  assert.equal(metaModule.formatNoteDate('2026-01-02'), '2026.01.02')
  // 取不到日期部分时返回空串，不能把脏字符带进卡片。
  assert.equal(metaModule.formatNoteDate(''), '')
  assert.equal(metaModule.formatNoteDate('not-a-date'), '')
})

test('stripNoteMarkdown 去掉记号、保留可读文本', () => {
  assert.equal(metaModule.stripNoteMarkdown('# 标题'), '标题')
  assert.equal(metaModule.stripNoteMarkdown('![图](x.png)'), '图')
  assert.equal(metaModule.stripNoteMarkdown('[文字](https://a.b)'), '文字')
  assert.equal(metaModule.stripNoteMarkdown('正文<br>换行'), '正文 换行')
  // 嵌入占位整块被吃掉：不能把空 div 原样带进摘要。
  assert.equal(metaModule.stripNoteMarkdown('前<div data-xynote-embed="note:x"></div>后'), '前 后')
  // 多行压成单行。
  assert.equal(metaModule.stripNoteMarkdown('一\n\n二'), '一 二')
  assert.equal(metaModule.stripNoteMarkdown(''), '')
})
