/**
 * 笔记嵌入卡片 —— 编辑器扩展（T1 spike 探路 → T2 补全 nodeView 真卡片）
 *
 * - T1（spike）：验证「在 Crepe 上注册自定义块级节点 + 保 markdown 往返无损」可行。节点/schema/transformer 已落地。
 * - T2（2026-09-04）：补全 nodeView，把 demo 占位块升级为真实卡片（NoteEmbedCard.vue，拉取 getNote 渲染）。
 *   设计见 docs/specs/2026-09-03-note-embed-card.md「T2 落地设计」。
 *
 * markdown 表达（标准 HTML，往返无损、网页端可安全退化）：
 *   `<div data-xynote-embed="note:<id>" data-xynote-embed-server="<serverId>" title="..."></div>`
 *   —— `data-xynote-embed` 是**本机 uuid**（桌面端插入时写），`data-xynote-embed-server` 是
 *      **跨端标识**（服务端主键）。两个属性互为补充，**任一存在即算一张嵌入卡**：
 *      桌面端插入写前者（目标已同步时再补上后者），网页端插入只能写后者。
 *      缺值的属性一律不输出（不写 `note:` 空值）。
 *      设计见 docs/specs/2026-10-12-note-embed-web-render.md。
 *
 * 注意：若删除本文件，须同时移除 MarkdownVisualEditor.vue createEditor 里的
 *   `crepe.addFeature(installXynoteEmbedFeature)` 一行，方可整体回退。
 */

import { $nodeSchema, $remark, $view } from '@milkdown/kit/utils'
import { h, render } from 'vue'
import NoteEmbedCard from '../components/NoteEmbedCard.vue'
import { dispatchEmbedCardMenu } from '../utils/note-open-events'

/** 嵌入的 HTML 标记前缀：`<div data-xynote-embed="note:<id>">` */
export const EMBED_TAG = 'data-xynote-embed'
/**
 * 嵌入卡的**跨端标识**属性：`data-xynote-embed-server="<serverId>"`。
 *
 * `data-xynote-embed` 是本机 uuid，本属性是服务端数字主键；网页端只认本属性。
 * 目标笔记没有 serverId（尚未同步）时**不输出本属性**，网页端据此降级成占位卡片。
 * 详见 docs/specs/2026-10-12-note-embed-web-render.md。
 */
export const EMBED_SERVER_TAG = 'data-xynote-embed-server'
export const EMBED_MDAST_TYPE = 'xynoteEmbed'

/** 从 html 文本里解析出 noteId（无匹配返回 null） */
export function parseEmbedHtml(raw: string): string | null {
  const m = /data-xynote-embed=["']note:([^"']+)["']/.exec(raw)
  return m ? m[1] : null
}

/**
 * 从 html 文本里解析出跨端标识 serverId（无匹配返回 null）。
 *
 * ⚠️ 属性名不能写成 `data-xynote-embed-server` 被 `data-xynote-embed` 的正则误吞：
 * 前者是独立属性，取值不含 `note:` 前缀。
 *
 * @param raw 承载嵌入卡的 html 原文。
 * @returns 服务端笔记主键；老卡片（无该属性）返回 null。
 */
export function parseEmbedServerId(raw: string): string | null {
  const m = /data-xynote-embed-server=["']([^"']+)["']/.exec(raw)
  return m ? m[1] : null
}

/**
 * 从 html 文本里解析出**标题快照**（无该属性返回 null）。
 *
 * ⚠️ 必须取出来，否则往返会丢：`toMarkdown` 会写 `title="..."`，但 parseMarkdown 只在
 * transformer 里取值 —— 少这一行，用户编辑正文后保存就会把 title 属性整体抹掉
 * （卡片本身看不出异常，因为桌面端标题是实时查库得到的；受损的是网页端取数失败时的兜底标题）。
 *
 * 与 `toMarkdown` 的写法对称：不做 HTML 转义 / 反转义。标题里含半角双引号时本就写不出
 * 合法属性（插入侧同样如此），属既有边界，不在本函数内单方面「修好」以免两端不等价。
 *
 * 属性前必须要求空白边界，避免匹配到 `data-xynote-embed-server` 之类名字里带 title 的属性。
 *
 * @param raw 承载嵌入卡的 html 原文。
 * @returns 插入时的标题快照；卡片没有 title 属性时返回 null。
 */
export function parseEmbedTitle(raw: string): string | null {
  const m = /(?:^|\s)title=["']([^"']*)["']/.exec(raw)
  return m ? m[1] : null
}

/**
 * 判断一段 html 是不是嵌入卡的载体 —— **两个标识属性任一存在**即算。
 *
 * 为什么不能只认 `data-xynote-embed`：网页端没有本机 uuid，插入卡片时只能写跨端标识
 * `data-xynote-embed-server`。只认前者会让这类卡片在桌面端退化成源码文本
 * （既认不出是卡片，也不会走 nodeView 渲染）。
 *
 * @param raw 承载嵌入卡的 html 原文。
 * @returns 是嵌入卡载体返回 true。
 */
export function isEmbedHtml(raw: string): boolean {
  return parseEmbedHtml(raw) != null || parseEmbedServerId(raw) != null
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
      const raw = String(node.value ?? '')
      if (!isEmbedHtml(raw)) return
      node.type = EMBED_MDAST_TYPE
      node.noteId = parseEmbedHtml(raw) ?? ''
      node.serverId = parseEmbedServerId(raw)
      node.title = parseEmbedTitle(raw)
      return
    }
    // 情况二：embed html 已被内置 transformer 包进 paragraph（内置先执行的主路径）
    //   paragraph 唯一子级为 html 且命中 embed → 提升为 root 级 block
    if (node.type === 'paragraph' && parent && index != null && parent.children) {
      const kids = node.children as any[]
      if (kids && kids.length === 1 && kids[0] && kids[0].type === 'html') {
        const raw = String(kids[0].value ?? '')
        if (!isEmbedHtml(raw)) return
        const embedNode = kids[0] as {
          type: string
          value?: string
          noteId?: string
          serverId?: string | null
          title?: string | null
        }
        embedNode.type = EMBED_MDAST_TYPE
        embedNode.noteId = parseEmbedHtml(raw) ?? ''
        embedNode.serverId = parseEmbedServerId(raw)
        embedNode.title = parseEmbedTitle(raw)
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
 * - attrs：noteId（被嵌入笔记 id）、title（可选，展示用）、serverId（可选，跨端标识）
 * - markdown 表达：`<div data-xynote-embed="note:<id>" data-xynote-embed-server="<serverId>" title="..."></div>`
 *   （标准 HTML）往返经 remark transformer + 本 schema 的 parseMarkdown/toMarkdown 闭环，不发明方言
 */
export const noteEmbedNodeSchema = $nodeSchema('xynoteEmbed', () => ({
  group: 'block',
  atom: false,
  selectable: true,
  // ⚠️ 必须 false。prosemirror-view 会按此字段给卡片 DOM 加原生 draggable
  // （viewdesc: `if (node.type.spec.draggable) dom.draggable = true`），而 nodeView 的
  // `stopEvent: () => true` 又让 PM 的 `eventBelongsToView` 对卡片内**所有**事件返回 false
  // （initInput 的事件闸门），PM 自己的 dragstart 处理器因此永不执行 —— 于是这个 true 只会
  // 触发浏览器原生 DOM 拖拽：既不写 `view.dragging` 切片（拖了也移不动节点），又会抢走鼠标
  // 拖选，表现为「一拖动整张卡片跟着动、正文文字无法选中复制」。移动卡片请用 Crepe BlockHandle。
  draggable: false,
  attrs: {
    noteId: { default: '' },
    title: { default: null as string | null },
    // 跨端标识：目标笔记的云端 serverId（未同步为 null）。桌面端解析不依赖它。
    serverId: { default: null as string | null }
  },
  parseDOM: [
    {
      // 两个标识属性**任一存在**即认作嵌入卡：网页端插入的卡片只有 `data-xynote-embed-server`。
      tag: 'div[data-xynote-embed], div[data-xynote-embed-server]',
      getAttrs: (dom) => {
        const el = dom as HTMLElement
        return {
          noteId: el.getAttribute('data-xynote-embed')?.replace(/^note:/, '') ?? '',
          title: el.getAttribute('title'),
          serverId: el.getAttribute(EMBED_SERVER_TAG)
        }
      }
    }
  ],
  toDOM: (node) => {
    const noteId = node.attrs.noteId as string
    const title = (node.attrs.title as string | null) ?? '笔记卡片'
    const attrs: Record<string, string> = {
      'data-embed-demo': 'true',
      class: 'xynote-embed-demo'
    }
    // 本机 ID 为空说明这张卡是网页端插入后同步下来的（只带跨端标识）—— 不要写出 `note:` 空值。
    if (noteId) attrs['data-xynote-embed'] = `note:${noteId}`
    // 有 serverId 才输出，避免给未同步目标写出空属性（网页端据「有无」决定是否降级）。
    const serverId = (node.attrs.serverId as string | null) ?? null
    if (serverId) attrs[EMBED_SERVER_TAG] = String(serverId)
    const suffix = noteId ? ` (note:${noteId})` : ''
    // ProseMirror 约定：toDOM 返回 DOMOutputSpec（数组描述），不可返回已创建的元素。
    return ['div', attrs, `[嵌入卡片] ${title}${suffix}`]
  },
  parseMarkdown: {
    match: ({ type }) => type === EMBED_MDAST_TYPE,
    runner: (state, node, proseType) => {
      const embedNode = node as { noteId?: string; title?: string | null; serverId?: string | null }
      state.addNode(proseType, {
        noteId: embedNode.noteId ?? '',
        title: embedNode.title ?? null,
        serverId: embedNode.serverId ?? null
      })
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === 'xynoteEmbed',
    runner: (state, node) => {
      const id = (node.attrs.noteId as string) ?? ''
      const title = (node.attrs.title as string | null) ?? ''
      const serverId = (node.attrs.serverId as string | null) ?? null
      const attr = title ? ` title="${title}"` : ''
      // 跨端契约：属性顺序固定「本机标识 → 跨端标识 → 标题」，网页端序列化逐字节同此序。
      // 缺值的属性一律不输出 —— 本机 ID 为空（网页端插入的卡片）时写出 `note:` 空值只会污染正文。
      const idAttr = id ? ` data-xynote-embed="note:${id}"` : ''
      const serverAttr = serverId ? ` ${EMBED_SERVER_TAG}="${serverId}"` : ''
      state.addNode('html', undefined, `<div${idAttr}${serverAttr}${attr}></div>`)
    }
  }
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const noteEmbedView = $view(noteEmbedNodeSchema.node, () => (node: any, _view: any, getPos: () => number | undefined) => {
  const container = document.createElement('div')
  container.className = 'xynote-embed-nodeview'
  // 卡片为只读展示块，自身不可编辑；由 Vue 内部点击逻辑负责跳转。
  container.setAttribute('contenteditable', 'false')

  const renderCard = (): void => {
    const noteId = (node.attrs.noteId as string) || ''
    const title = (node.attrs.title as string | null) ?? null
    const serverId = (node.attrs.serverId as string | null) ?? null
    render(h(NoteEmbedCard, {
      noteId,
      // 本机 ID 可能为空（网页端插入的卡片只带跨端标识），卡片据 serverId 取数。
      serverId,
      title,
      // 右键卡片：nodeView 补上节点位置（getPos），交给编辑器复用正文右键菜单弹卡片操作项。
      onContextMenu: (payload: { x: number; y: number; available: boolean }) => {
        dispatchEmbedCardMenu({
          noteId,
          title,
          serverId,
          pos: getPos() ?? -1,
          x: payload.x,
          y: payload.y,
          available: payload.available
        })
      }
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
      const serverIdChanged = nextNode.attrs.serverId !== node.attrs.serverId
      node = nextNode
      if (noteIdChanged || titleChanged || serverIdChanged) renderCard()
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
