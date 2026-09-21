/**
 * 内联 `<br>` 保真扩展。
 *
 * ## 为什么需要这个文件
 *
 * Crepe 的 `commonmark` preset 会注册 `remarkPreserveEmptyLinePlugin`
 * （`@milkdown/preset-commonmark/lib/index.js:2125`）。该插件的 visitor 把 mdast 中
 * **trim 后值等于 `<br>` / `<br/>` / `<br />` / `<br >` 的 `html` 节点直接 `splice` 删除**
 * （同文件 `:436-448`），设计意图是：把 `<br />` 当作「空段落占位符」——
 * 解析时删掉，序列化空段落时（`:489`）再写回 `<br />`。
 *
 * 副作用是**用户正文里真实的内联 `<br>` 也被一并删掉**：段落里 `前<br>后` 变成 `前后`，
 * 表格单元格里同样消失。这导致「粘贴 → 编辑 → 保存」全链路丢 `<br>`。
 *
 * ## 修复思路
 *
 * 内置插件靠 `node.type === "html"` + 值匹配来删节点。只要在它**之前**把
 * **内联语境**下的 `<br>` 改成另一个 mdast type（`xynoteHardbreak`），它就匹配不到、不会删；
 * 随后本模块的 schema 把该 type 映射成 ProseMirror 的 `xynoteHardbreak` 内联原子节点
 * （`toDOM` 渲染成真正的 `<br>`），序列化时回写成 html 节点 `<br>`，
 * 于是段落与表格单元格都能**逐字节往返**。
 *
 * 为避免破坏 Milkdown 的空行占位语义，以下两种 `<br>` **原样放过**，交给内置插件按老逻辑删除：
 *  1. 块容器（root / blockquote / listItem）的**直接子级**；
 *  2. `paragraph` 的**唯一子级**（进入 `remarkHtmlTransformer` 后，独立成块的 `<br />`
 *     会被包成 `paragraph > html`，所以最终父级是 paragraph 而非 root）。
 *
 * ## ⚠️ 时序依赖（改这里务必先读）
 *
 * 内置 preserve 插件由 commonmark preset 注册，**排在本插件之前**，所以单纯
 * `$remark`（只能追加到 `remarkPluginsCtx` 尾部）**救不回**被删的节点。
 * 因此本模块用自定义 Milkdown 插件 `remarkPluginsCtx` **前置插入**自己的 transformer。
 *
 * 能前置成功的依据：各 `$remark` 插件用 `await ctx.wait(InitReady)`（直接 await，早一跳
 * microtask）把自身 push 进 `remarkPluginsCtx`；而 schema 插件用
 * `Promise.all([wait(InitReady)])`，比直接 await **多等一跳 microtask**，
 * 故 reduce 建 remark processor 时能看到全部插件。实测顺序：
 * 内置插件 push → 本插件前置 → schema reduce。详见 /tmp/probe-order.mjs。
 */

import { InitReady, remarkPluginsCtx } from '@milkdown/kit/core'
import { $nodeSchema } from '@milkdown/kit/utils'

/** 本扩展专属的 mdast 节点类型，用于避开内置插件的 `html` 匹配。 */
export const HARDBREAK_MDAST_TYPE = 'xynoteHardbreak'

/** 本扩展节点在 ProseMirror schema 里的名字。 */
export const HARDBREAK_NODE_NAME = 'xynoteHardbreak'

/** 表格单元格节点名（`table_cell` 与表头 `table_header` 同等对待）。 */
export const TABLE_CELL_NODE_NAMES = ['table_cell', 'table_header']

/** 内置 `remarkPreserveEmptyLinePlugin` 会删除的 `<br>` 写法（trim 后精确匹配）。 */
const BR_VALUES = ['<br />', '<br>', '<br >', '<br/>']

/**
 * 块容器类型。这些节点的**直接子级**若为 `<br>`，按 Milkdown 的
 * 「空行占位符」语义处理（交给内置插件删除），本扩展不接管。
 * 与内置 `BLOCK_CONTAINER_TYPES` 保持一致。
 */
const BLOCK_CONTAINER_TYPES = ['root', 'blockquote', 'listItem']

/** mdast 节点（仅取本模块关心的字段）。 */
interface MdastNode {
  type?: string
  value?: unknown
  children?: MdastNode[]
}

/** 判断 mdast 节点是否为待抢救的 `<br>` html 节点。 */
function isBrHtmlNode(node: MdastNode | null | undefined): boolean {
  if (!node || node.type !== 'html') return false
  return BR_VALUES.includes(String(node.value ?? '').trim())
}

/**
 * remark transformer：把**内联语境**下的 `<br>` html 节点改写成 `xynoteHardbreak`。
 *
 * 由 `remarkPluginsCtx` 前置插入，确保早于内置 `remarkPreserveEmptyLinePlugin` 执行。
 * 签名必须是 `(options) => (tree) => void` —— unified 以 `use(plugin, options)` 调用。
 */
export const hardbreakRemarkRule = () => (tree: MdastNode) => {
  // ⚠️ `node` 恒为 children 的**直接父节点**（不要把外层 parent 传进来当父级，
  // 那会把「段落内 <br>」误判成「块容器子级」而跳过，等于没修）。
  const walk = (node: MdastNode): void => {
    const children = node.children
    if (!Array.isArray(children)) return
    for (const child of children) {
      if (isBrHtmlNode(child)) {
        // 跳过 1：块容器（root/blockquote/listItem）的直接子级 —— 空行占位符，交给内置插件删除
        const isBlockContainerChild = BLOCK_CONTAINER_TYPES.includes(String(node.type))
        // 跳过 2：paragraph 的唯一子级 —— 同为空行占位符
        const isSoleParagraphChild = node.type === 'paragraph' && children.length === 1
        if (!isBlockContainerChild && !isSoleParagraphChild) {
          // 内联语境：换成专属类型，逃过内置插件的 html 匹配
          child.type = HARDBREAK_MDAST_TYPE
          child.value = '<br>'
        }
      }
      walk(child)
    }
  }
  walk(tree)
}

/**
 * Milkdown 插件：把 `hardbreakRemarkRule` 前置插入 remark 插件链。
 *
 * 为什么不用 `$remark`：`$remark` 只能把插件**追加**到 `remarkPluginsCtx` 尾部，
 * 这样会排在内置 preserve 插件之后，`<br>` 早已被删除，抢救无效。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hardbreakOrderPlugin = (ctx: any) => async () => {
  await ctx.wait(InitReady)
  const entry = { plugin: hardbreakRemarkRule, options: {} }
  ctx.update(remarkPluginsCtx, (list: unknown[]) => [entry, ...list])
  return () => {
    ctx.update(remarkPluginsCtx, (list: unknown[]) => list.filter((x) => x !== entry))
  }
}

/**
 * `xynoteHardbreak` 内联原子节点。
 *
 * - `inline` + `atom`：不可编辑的叶子节点
 * - `toDOM` 输出带 `data-type` 标记的 `<br>`；`parseDOM` 以**更高 priority** 精确抢回
 * - `toMarkdown` 回写 html 节点 `<br>`：**段落与表格单元格都逐字节保真**
 *   （对比内置 hardbreak → `break` 节点，在表格里会被 remark-stringify 压成空格）
 *
 * ⚠️ `parseDOM` 的 `priority: 60` 是**必需**的，不是调优：
 * 剪贴板粘贴链路是 `parser(text)` → `DOMSerializer` → `parseSlice`，
 * 节点必须先被序列化成 DOM 再读回来。内置 `hardbreakSchema` 注册了
 * `parseDOM: [{ tag: "br" }]`（默认 priority 50），会抢走这个 `<br>`，
 * 把节点降级成内置 hardbreak —— 于是段落里变 `\`+换行、表格里被压成空格，
 * 修复等于白做。提高 priority 后由属性选择器精确命中，稳定拿回本节点。
 */
export const xynoteHardbreakSchema = $nodeSchema(HARDBREAK_NODE_NAME, () => ({
  inline: true,
  group: 'inline',
  atom: true,
  selectable: false,
  // 复制为纯文本时，本节点贡献一个换行（与内置 hardbreak 的 leafText 一致）
  leafText: () => '\n',
  toDOM: () => ['br', { 'data-type': 'xynote-hardbreak' }],
  parseDOM: [{
    tag: 'br[data-type="xynote-hardbreak"]',
    priority: 60
  }],
  parseMarkdown: {
    match: ({ type }: { type: string }) => type === HARDBREAK_MDAST_TYPE,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runner: (state: any, _node: unknown, type: unknown) => {
      state.addNode(type)
    }
  },
  toMarkdown: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    match: (node: any) => node.type.name === 'xynoteHardbreak',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runner: (state: any) => {
      state.addNode('html', undefined, '<br>')
    }
  }
}))

/**
 * 组合成可在 `createEditor` 里经 `crepe.addFeature` 挂载的 feature。
 *
 * ⚠️ `$nodeSchema` 返回二元数组 `[schemaCtx, $node]`，两者都必须 use：
 * 只 use node 会在 `ctx.get('xynoteHardbreak')` 时抛
 * `Context "xynoteHardbreak" not found` 导致编辑器起不来。
 * （范式与 `src/editor/xynote-embed.ts` 一致。）
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function installHardbreakFeature(editor: any): void {
  editor.use(hardbreakOrderPlugin)
  editor.use(xynoteHardbreakSchema.ctx)
  editor.use(xynoteHardbreakSchema.node)
}

/** 供测试引用的内部常量。 */
export const __internal = { BR_VALUES, BLOCK_CONTAINER_TYPES, isBrHtmlNode }
