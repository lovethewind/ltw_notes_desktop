const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')

/**
 * 预览正文清洗的协议白名单。
 *
 * ## 为什么需要这组守卫
 *
 * DOMPurify 的默认 URI 白名单（`IS_ALLOWED_URI`）**不含本应用的私有资产协议**
 * `xinyue-asset:`。笔记正文里的本地图片是 `![图](xinyue-asset://local/<id>)`，
 * 清洗时会被判定为不可信地址，走 `_removeAttribute` **整条剥掉 `src`** ——
 * 元素还在、图片没了，预览里就是一个断图。
 *
 * 编辑器不走这条链路，所以症状很迷惑：同一篇笔记编辑模式正常，切到预览全断。
 * 用户报的「导入到笔记的文档，预览模式图片无法显示」就是这个。
 *
 * 单测在这里做两件事：
 *   1. **真行为**断言白名单正则（不依赖 DOM，能直接跑）；
 *   2. **接线**断言三个渲染入口都走共用清洗入口，且没有再各写一份 `DOMPurify.sanitize`。
 *
 * 最终「图片真的显示出来」由 e2e 兜底（`tests/e2e/single-markdown-import.e2e.test.cjs`）：
 * DOMPurify 依赖 DOM，node 环境下 `isSupported === false`，这里量不了清洗结果。
 */
let sanitizeModule

test.before(async () => {
  sanitizeModule = await import(pathToFileURL(resolve(projectRoot, 'src/utils/preview-sanitize.ts')).href)
})

test('白名单放行本应用资产协议，笔记里的本地图片不会被剥掉 src', () => {
  const { PREVIEW_ALLOWED_URI_REGEXP: allowed } = sanitizeModule

  assert.equal(
    allowed.test('xinyue-asset://local/0fa0f68c-ff5a-4cae-8117-0ab1b8109a6a'),
    true,
    'xinyue-asset://local/<id> 是本应用图片的正式写法，必须通过清洗白名单'
  )
})

test('只追加了一个协议：危险地址仍被拦下', () => {
  const { PREVIEW_ALLOWED_URI_REGEXP: allowed } = sanitizeModule

  // 这三条在 DOMPurify 默认白名单里同样是 false —— 加固不能把它们一起放进来。
  for (const dangerous of ['javascript:alert(1)', 'vbscript:msgbox(1)', 'file:///etc/passwd']) {
    assert.equal(allowed.test(dangerous), false, `${dangerous} 不该通过白名单`)
  }
  // file: 走的是另一条路：`resolvePreviewImageSource` 把它去协议归一成绝对路径，不靠白名单放行。
  assert.equal(allowed.test('/Users/me/docs/a.png'), true, '去协议后的绝对路径应放行')
})

test('常规地址的判定与默认口径一致', () => {
  const { PREVIEW_ALLOWED_URI_REGEXP: allowed } = sanitizeModule

  assert.equal(allowed.test('https://cdn.example.com/a.png'), true, '网络图片照常放行')
  assert.equal(allowed.test('http://cdn.example.com/a.png'), true, 'http 也照常')
  assert.equal(allowed.test('mailto:a@b.c'), true, '默认白名单里的 mailto 不受影响')
})

test('三个渲染入口都走共用清洗入口，且不再各写一份 DOMPurify.sanitize', () => {
  const entries = {
    笔记预览: 'src/components/MarkdownVisualEditor.vue',
    外部文件预览: 'src/components/MarkdownSourceEditor.vue',
    嵌入卡片展开区: 'src/components/NoteEmbedCard.vue'
  }

  for (const [label, relativePath] of Object.entries(entries)) {
    const source = fs.readFileSync(resolve(projectRoot, relativePath), 'utf8')
    assert.match(source, /sanitizePreviewHtml\(/, `${label} 应调用共用清洗入口`)
    assert.doesNotMatch(
      source,
      /from 'dompurify'/,
      `${label} 应改用共用清洗入口，不要自己 import DOMPurify（否则协议白名单又会散开）`
    )
  }
})

test('清洗入口确实把自定义白名单交给了 DOMPurify', () => {
  const source = fs.readFileSync(resolve(projectRoot, 'src/utils/preview-sanitize.ts'), 'utf8')

  assert.match(
    source,
    /DOMPurify\.sanitize\([\s\S]*?ALLOWED_URI_REGEXP:\s*PREVIEW_ALLOWED_URI_REGEXP/,
    'sanitize 时必须把自定义白名单传进去，否则等于没加'
  )
})

test('AI 助手面板不受影响：仍按默认白名单清洗', () => {
  // AI 回答里出现 `xinyue-asset://` 属越权引用本地附件，既有意图就是剥掉
  // （见 tests/ai-assistant.test.cjs）。这里钉住，避免「顺手统一」把它也放行。
  const source = fs.readFileSync(resolve(projectRoot, 'src/components/AiAssistantPanel.vue'), 'utf8')

  assert.match(source, /DOMPurify\.sanitize\(/, 'AI 面板应继续用默认白名单清洗')
  assert.doesNotMatch(source, /sanitizePreviewHtml/, 'AI 面板不该走预览清洗入口')
})
