/**
 * 笔记嵌入卡片 —— 编辑器扩展（T1 spike 探路 → T2 补全 nodeView 真卡片）
 *
 * - T1（spike）：验证「在 Crepe 上注册自定义块级节点 + 保 markdown 往返无损」可行。节点/schema/transformer 已落地。
 * - T2（2026-09-04）：补全 nodeView，把 demo 占位块升级为真实卡片（NoteEmbedCard.vue，拉取 getNote 渲染）。
 *   设计见 docs/specs/2026-09-03-note-embed-card.md「T2 落地设计」。
 *
 * markdown 表达（标准 HTML，往返无损、网页端可安全退化）：
 *   `<div data-xynote-embed="note:<id>" title="..."></div>`
 *
 * 注意：若删除本文件，须同时移除 MarkdownVisualEditor.vue createEditor 里的
 *   `crepe.addFeature(installXynoteEmbedFeature)` 一行，方可整体回退。
 */

import { $nodeSchema, $remark, $view } from '@milkdown/kit/utils'
import { h, render } from 'vue'
import NoteEmbedCard from '../components/NoteEmbedCard.vue'

/** 嵌入的 HTML 标记前缀：`<div data-xynote-embed="note:<id>">` */
export const EMBED_TAG = 'data-xynote-embed'
export const EMBED_MDAST_TYPE = 'xynoteEmbed'

/** 从 html 文本里解析出 noteId（无匹配返回 null） */
export function parseEmbedHtml(raw: string): string | null {
  const m = /data-xynote-embed=["']note:([^"']+)["']/.exec(raw)
  return m ? m[1] : null
}

/**
 * 深度遍历 mdast 树。回调签名 (node, parent, index)：
 * - 对根节点调用时 parent=null、index=-1
 * - 递归进入子节点时，parent 为当前节点、index 为其在 parent.children 中的下标
 * 不剪枝；原地改动树结构时务必只在必要时修改，避免遍历器在已改动的 children 上继续递归。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function walkMdast(
  node: any,
  fn: (n: any, parent: any, index: number) => void,
  parent: any = null,
  index: number = -1
): void {
  fn(node, parent, index)
  const children = node?.children
  if (Array.isArray(children)) children.forEach((c, i) => walkMdast(c, fn, node, i))
}

/**
 * remark 插件：把含 `data-xynote-embed` 的 html 节点改造成自定义 mdast type，
 * 让后续 noteEmbed.parseMarkdown 能稳定命中，而不与内置 htmlSchema 抢 mdast 'html'。
 *
 * ⚠️ 签名必须与 preset 内置 remarkHtmlTransformer 完全一致的三层箭头：
 *   `$remark(id, () => () => (tree) => void)`
 * 即 factory(remark ctx) 返回一个「remark 插件工厂」（接受 options、返回 transformer）。
 * 若只写两层 `() => (tree) => void`，unified 会把它当插件直接以 processor 调用，
 * 抛 `Cannot read properties of undefined (reading 'type')`，导致**所有** markdown
 * 解析（含 replaceAll 切换笔记）失败 —— 这就是「任何切换都不渲染」的根因。
 *
 * 执行时序：commonmark 先注册（内置先跑）→ 独立成块的 embed div 已被内置
 * remarkHtmlTransformer 包成 `paragraph > html`。因此本插件必须把「paragraph 内唯一的
 * embed html」提升回 root 级 block（noteEmbed 是 block，不能作 paragraph 子级）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const embedRemarkTransformer = $remark('remarkXynoteEmbedTransformer', () => () => (tree: any) => {
  walkMdast(tree, (node, parent, index) => {
    // 情况一：root 直接子级就是 embed html（本插件若先于内置执行时兜底）
    if (node.type === 'html') {
      const noteId = parseEmbedHtml(String(node.value ?? ''))
      if (noteId == null) return
      node.type = EMBED_MDAST_TYPE
      node.noteId = noteId
      return
    }
    // 情况二：embed html 已被内置 transformer 包进 paragraph（内置先执行的主路径）
    //   paragraph 唯一子级为 html 且命中 embed → 提升为 root 级 block
    if (node.type === 'paragraph' && parent && index != null && parent.children) {
      const kids = node.children as any[]
      if (kids && kids.length === 1 && kids[0] && kids[0].type === 'html') {
        const noteId = parseEmbedHtml(String(kids[0].value ?? ''))
        if (noteId == null) return
        const embedNode = kids[0] as { type: string; value?: string; noteId?: string }
        embedNode.type = EMBED_MDAST_TYPE
        embedNode.noteId = noteId
        delete embedNode.value
        // 用提升后的 embed 节点替换外层 paragraph
        parent.children[index] = embedNode
      }
    }
  })
})

/**
 * noteEmbed 块级节点。
 * - block 节点：正文里作为独立一块
 * - attrs：noteId（被嵌入笔记 id）、title（可选，展示用）
 * - markdown 表达：`<div data-xynote-embed="note:<id>" title="..."></div>`（标准 HTML）
 *   往返经 remark transformer + 本 schema 的 parseMarkdown/toMarkdown 闭环，不发明方言
 */
export const noteEmbedNodeSchema = $nodeSchema('xynoteEmbed', () => ({
  group: 'block',
  atom: false,
  selectable: true,
  draggable: true,
  attrs: {
    noteId: { default: '' },
    title: { default: null as string | null }
  },
  parseDOM: [
    {
      tag: 'div[data-xynote-embed]',
      getAttrs: (dom) => {
        const el = dom as HTMLElement
        return {
          noteId: el.getAttribute('data-xynote-embed')?.replace(/^note:/, '') ?? '',
          title: el.getAttribute('title')
        }
      }
    }
  ],
  toDOM: (node) => {
    const noteId = node.attrs.noteId as string
    const title = (node.attrs.title as string | null) ?? '笔记卡片'
    // ProseMirror 约定：toDOM 返回 DOMOutputSpec（数组描述），不可返回已创建的元素。
    return [
      'div',
      { 'data-xynote-embed': `note:${noteId}`, 'data-embed-demo': 'true', class: 'xynote-embed-demo' },
      `[嵌入卡片] ${title} (note:${noteId})`
    ]
  },
  parseMarkdown: {
    match: ({ type }) => type === EMBED_MDAST_TYPE,
    runner: (state, node, proseType) => {
      state.addNode(proseType, {
        noteId: (node as { noteId?: string }).noteId ?? '',
        title: (node as { title?: string }).title ?? null
      })
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === 'xynoteEmbed',
    runner: (state, node) => {
      const id = (node.attrs.noteId as string) ?? ''
      const title = (node.attrs.title as string | null) ?? ''
      const attr = title ? ` title="${title}"` : ''
      state.addNode('html', undefined, `<div data-xynote-embed="note:${id}"${attr}></div>`)
    }
  }
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const noteEmbedView = $view(noteEmbedNodeSchema.node, () => (node: any) => {
  const container = document.createElement('div')
  container.className = 'xynote-embed-nodeview'
  // 卡片为只读展示块，自身不可编辑；由 Vue 内部点击逻辑负责跳转。
  container.setAttribute('contenteditable', 'false')

  const renderCard = (): void => {
    render(h(NoteEmbedCard, {
      noteId: (node.attrs.noteId as string) || '',
      title: (node.attrs.title as string | null) ?? null
    }), container)
  }
  renderCard()

  return {
    dom: container,
    // ProseMirror NodeView.update：返回 true 表示已自行处理，无需重建 DOM。
    update(nextNode: any): boolean {
      if (nextNode.type !== node.type) return false
      const noteIdChanged = nextNode.attrs.noteId !== node.attrs.noteId
      const titleChanged = nextNode.attrs.title !== node.attrs.title
      node = nextNode
      if (noteIdChanged || titleChanged) renderCard()
      return true
    },
    destroy(): void {
      render(null, container)
    },
    // 卡片是原子展示块：拦截内部指针/键盘事件交给 Vue，避免 ProseMirror 介入光标/选择。
    stopEvent: (): boolean => true
  }
})

/**
 * 组合成可在 createEditor 里经 crepe.addFeature 挂载的 feature（editor.use 挂 recipe 插件）。
 *
 * ⚠️ $nodeSchema 返回的是二元数组 [schemaCtx, $node]，两者都必须 use：
 * - noteEmbedNodeSchema.ctx  = $ctx(schema, 'xynoteEmbed') —— 负责把名为 `xynoteEmbed` 的 slice
 *   inject 进 Milkdown context（存 schema factory）
 * - noteEmbedNodeSchema.node = $node(...) —— 运行时会 `ctx.get('xynoteEmbed')` 读取该 slice
 *
 * 若只 use node、漏 use ctx，$node 执行 `ctx.get('xynoteEmbed')` 时抛
 * `MilkdownError: Context "xynoteEmbed" not found, do you forget to inject it?`
 * 导致 crepe.create() 崩、编辑器整体起不来 → 表现为「切换笔记不渲染」。
 * （commonmark 的 schema 数组是靠 `[..., headingSchema, ...].flat()` 把每个 $nodeSchema
 *   自动展开成 [ctx, node]，故无此问题；手写 installFeature 需显式 use 两者。）
 */
/**
 * ⚠️ 两个 recipe 都是「二元数组」结构，return 数组里的**每个元素**都必须显式 use，缺一即崩：
 * - $remark  => 二元 [optionsCtx, plugin]，`.options`(=$ctx) 注入名为 `remarkXynoteEmbedTransformer`
 *   的 slice（存 initialOptions），`.plugin` 运行时 `ctx.get(options.key)` 读它 → 只 use plugin、
 *   漏 options 会抛 `Context "remarkXynoteEmbedTransformer" not found`。
 * - $nodeSchema => 二元 [schemaCtx, $node]，`.ctx` 注入 `xynoteEmbed` slice，`.node` 运行时读它。
 * 四者一个都不能少，顺序无硬性要求但建议 options/ctx 在各自 node/plugin 之前。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function installXynoteEmbedFeature(editor: any): void {
  editor.use(embedRemarkTransformer.options) // 注入 `remarkXynoteEmbedTransformer` slice（不可漏）
  editor.use(embedRemarkTransformer.plugin)
  editor.use(noteEmbedNodeSchema.ctx) // 注入 `xynoteEmbed` slice（不可漏）
  editor.use(noteEmbedNodeSchema.node)
  editor.use(noteEmbedView) // 单一 MilkdownPlugin，直接 use（非二元组）
}
