/**
 * 行内字号「选中文字字号 / 后续输入字号」——编辑器扩展。
 *
 * ## markdown 表达（标准 HTML，往返无损、跨端可渲染）
 *
 *     <span style="font-size:18px">这段是 18px</span>
 *
 * 不发明方言：标准 HTML 在 Web 端（`ltw_front_v3` 用 marked，已实测原样保留）、
 * 纯文本编辑器、以及本编辑器的 mdast 往返里都能安全表达。识别正则只认
 * **仅含 font-size 一条声明**的 span（见 `src/utils/inline-font-size.ts` 的说明），
 * 以免把用户手写的 `color:red` 在保存时抹掉。
 *
 * ## 四条链路（缺一即静默失效）
 *
 * 1. **mdast → ProseMirror**：`fontSizeRemarkRule` 把**成对的** `<span…>` / `</span>`
 *    html 节点合并成自定义容器（mdast 里两者是**同层兄弟**，用栈配对即可）。
 * 2. **mark schema**：`xynoteFontSize`，attrs.size，toDOM 出带 `data-xynote-font-size` 的 span。
 * 3. **ProseMirror → mdast**：`toMarkdown` 用 `withMark` 生成同名容器节点
 *    （`size` 经 props 展开进 mdast 节点）。
 * 4. **mdast → markdown**：`remarkStringifyOptionsCtx.handlers` 注册四参 handler，
 *    输出 `<span style="font-size:Npx">` + children + `</span>`。
 *
 * ## ⚠️ 两个已实测的坑（改这里必读）
 *
 * ### 坑 1：`excludes: ''` 是**必需**的，且它让 `addMark` 变成「叠加」
 *
 * 实测（prosemirror-model）：
 *
 *     excludes 未设  → m22.addToSet([m18]) === [22]     ← 替换
 *     excludes: ''   → m22.addToSet([m18]) === [18,22]  ← 共存
 *
 * 共存是**解析既有嵌套文档**所必需的（`<span18>a<span22>b</span>c</span>` 里 b 同时带两个字号）。
 * 代价是「设字号」若直接用 `addMark` 会越改越嵌套 —— 所以调用侧**必须用替换语义**
 * （先 removeMark/removeStoredMark，再 add），见 `MarkdownVisualEditor.vue` 的 `applyInlineFontSize`。
 *
 * ### 坑 2：stringify handler 的签名与 Milkdown 的 runner **是两套 API**
 *
 * - 本文件 `toMarkdown.runner` 用的是 **Milkdown** 的 `state.withMark(...)` / `state.addNode(...)`；
 * - handler 用的是 **remark（mdast-util-to-markdown）** 的四参签名
 *   `(node, parent, state, info) => string`，靠 `state.write` / `state.containerPhrasing` 拼接。
 *
 * 混用会报 `state.addNode is not a function`（本轮实测踩到）。签名照抄
 * `mdast-util-to-markdown/lib/handle/emphasis.js`。
 *
 * ## 回退
 *
 * 删除本文件 + 移除 `MarkdownVisualEditor.vue` createEditor 里的
 * `crepe.addFeature(installFontSizeFeature)` 一行即可整体回退；
 * 正文里残留的 `<span style="font-size:…">` 会被通用 html 渲染安全退化（不崩、不脏同步）。
 */

import { InitReady, remarkPluginsCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core'
import { $markSchema } from '@milkdown/kit/utils'
import {
  DEFAULT_BODY_FONT_SIZE,
  FONT_SIZE_MDAST_TYPE,
  nestFontSizeSpans,
  type MdastInlineNode
} from '../utils/inline-font-size'

/** 本扩展 mark 在 ProseMirror schema 里的名字。 */
export const FONT_SIZE_MARK_NAME = 'xynoteFontSize'

/** `toDOM` 写出的标记属性；也是 `parseDOM` 精确抢回本节点的依据。 */
export const FONT_SIZE_DOM_ATTR = 'data-xynote-font-size'

/**
 * remark transformer：把**成对**的字号 span 合并成 `xynoteFontSize` 容器。
 *
 * 签名是**两层** `() => (tree) => void` —— 与 `$remark` 需要的三层不同：
 * 本 transformer 是经自定义插件**直接塞进** `remarkPluginsCtx` 的
 * （unified 以 `use(plugin, options)` 调用，即 `plugin(options)` 拿到 tree 函数），
 * 与 `src/editor/xynote-hardbreak.ts` 的 `hardbreakRemarkRule` 同构。
 *
 * 真正的配对逻辑在 `nestFontSizeSpans`（纯函数、有真行为测试）；
 * 这里只负责把它套到 mdast 根上 —— 该函数自身会递归整棵树。
 */
export const fontSizeRemarkRule = () => (tree: MdastInlineNode) => {
  if (Array.isArray(tree?.children)) {
    tree.children = nestFontSizeSpans(tree.children)
  }
}

/**
 * Milkdown 插件：把 `fontSizeRemarkRule` **前置插入** remark 插件链。
 *
 * 为什么不直接用 `$remark`：`$remark` 只能**追加**到 `remarkPluginsCtx` 尾部，
 * 那样本 transformer 会排在内置 `remarkHtmlTransformer` 之后 —— 后者会把
 * 独立成块的 html 包进 paragraph，span 配对将受其结构改动影响。
 * 前置插入可让配对发生在任何可能改组结构的插件之前，且与项目既有做法
 * （`xynote-hardbreak.ts` 的 `hardbreakOrderPlugin`）保持一致。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fontSizeOrderPlugin = (ctx: any) => async () => {
  await ctx.wait(InitReady)
  const entry = { plugin: fontSizeRemarkRule, options: {} }
  ctx.update(remarkPluginsCtx, (list: unknown[]) => [entry, ...list])
  return () => {
    ctx.update(remarkPluginsCtx, (list: unknown[]) => list.filter((x) => x !== entry))
  }
}

/**
 * remark（mdast-util-to-markdown）侧的 stringify handler。
 *
 * ⚠️ 四参签名、返回**字符串**（与 Milkdown 的 `toMarkdown.runner` 不是一套 API，
 * 后者用 `state.withMark`/`state.addNode`）。
 *
 * 用 `containerPhrasing` 处理 children，使 span 内部还能容纳粗体、链接、甚至嵌套字号。
 *
 * @param node mdast 节点（`size` 由 `withMark` 的 props 带过来）。
 * @param _parent 父节点（此 handler 不使用）。
 * @param state remark state，提供 write / containerPhrasing / enter / createTracker。
 * @param info 位置信息（tracker 需要）。
 * @returns 序列化后的 markdown 片段。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fontSizeStringifyHandler(node: any, _parent: unknown, state: any, info: any): string {
  const size = Number(node?.size)
  const open = `<span style="font-size:${Number.isFinite(size) && size > 0 ? size : DEFAULT_BODY_FONT_SIZE}px">`
  const close = '</span>'
  const exit = state.enter(FONT_SIZE_MDAST_TYPE)
  const tracker = state.createTracker(info)
  const before = tracker.move(open)
  const between = tracker.move(
    state.containerPhrasing(node, {
      after: close,
      before,
      ...tracker.current()
    })
  )
  const after = tracker.move(close)
  exit()
  return before + between + after
}

/**
 * 把 handler 注册进 `remarkStringifyOptionsCtx`。
 *
 * 时序：本插件的**同步部分**在 core 的 `init` 插件 inject 该 slice 之后执行
 * （插件按注册顺序执行，`addFeature` 的插件排在内置插件之后），
 * 而 `init` 的异步部分稍后才 `ctx.get(remarkStringifyOptionsCtx)` 去建 remark processor
 * —— 所以这里同步 update 一定能被读到。
 *
 * ⚠️ 不做清理：本 slice 在编辑器销毁时会被 `init` 的清理函数 remove 掉，
 * 若在清理阶段再 `update` 会抛错；而 handler 随 ctx 一起废弃，无需回收。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fontSizeStringifyPlugin = (ctx: any) => () => {
  ctx.update(remarkStringifyOptionsCtx, (options: { handlers?: Record<string, unknown> }) => ({
    ...options,
    handlers: {
      ...(options?.handlers ?? {}),
      [FONT_SIZE_MDAST_TYPE]: fontSizeStringifyHandler
    }
  }))
}

/**
 * `xynoteFontSize` 行内标记。
 *
 * - attrs：`size`（px）
 * - `excludes: ''`：允许同类型 mark 共存（**必需**，见文件头「坑 1」）
 * - `toDOM`：带 `data-xynote-font-size` 的 `<span>`，供剪贴板往返精确还原
 * - `parseDOM`：`priority: 60` 精确抢回（照 `xynote-hardbreak.ts` 的做法，避免被内置规则接走）
 */
export const xynoteFontSizeSchema = $markSchema(FONT_SIZE_MARK_NAME, () => ({
  attrs: {
    size: { default: DEFAULT_BODY_FONT_SIZE }
  },
  // ⚠️ 显式空串，不是「默认」。未设时 addToSet 会替换同类型 mark，
  // 嵌套字号区间（b 同时属于 18 与 22）就无法表达。详见文件头「坑 1」。
  excludes: '',
  parseDOM: [
    {
      tag: `span[${FONT_SIZE_DOM_ATTR}]`,
      priority: 60,
      getAttrs: (dom: HTMLElement | string) => {
        if (typeof dom === 'string') return false
        const size = Number(dom.getAttribute(FONT_SIZE_DOM_ATTR))
        return Number.isFinite(size) && size > 0 ? { size } : false
      }
    }
  ],
  toDOM: (mark) => [
    'span',
    {
      [FONT_SIZE_DOM_ATTR]: String(mark.attrs.size),
      style: `font-size:${mark.attrs.size}px`
    },
    0
  ],
  parseMarkdown: {
    match: (node) => node.type === FONT_SIZE_MDAST_TYPE,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runner: (state: any, node: any, markType: unknown) => {
      state.openMark(markType, { size: node.size ?? DEFAULT_BODY_FONT_SIZE })
      state.next(node.children)
      state.closeMark(markType)
    }
  },
  toMarkdown: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    match: (mark: any) => mark.type.name === FONT_SIZE_MARK_NAME,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runner: (state: any, mark: any) => {
      // props 会被 Milkdown 的 #createMarkdownNode 展开进 mdast 节点（handler 侧靠它拿回 size）。
      state.withMark(mark, FONT_SIZE_MDAST_TYPE, undefined, { size: mark.attrs.size })
    }
  }
}))

/**
 * 组合成可在 `createEditor` 里经 `crepe.addFeature` 挂载的 feature。
 *
 * ⚠️ `$markSchema` 返回**二元组** `[schemaCtx, $Mark]`（已读 `$mark-schema.d.ts` 确认），
 * `.ctx` 与 `.mark` **两者都必须 use**：只 use `.mark` 会在运行时抛
 * `MilkdownError: Context "xynoteFontSize" not found, do you forget to inject it?`
 * 导致 `crepe.create()` 崩、编辑器整体起不来（表现为「切换笔记不渲染」）。
 * 同一规律见 `docs/specs/2026-09-03-milkdown-custom-node-spike.md`。
 *
 * :param editor: Milkdown Editor 实例（由 `crepe.addFeature` 传入）。
 * :return: 无返回值。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function installFontSizeFeature(editor: any): void {
  editor.use(fontSizeOrderPlugin)
  editor.use(fontSizeStringifyPlugin)
  editor.use(xynoteFontSizeSchema.ctx)
  editor.use(xynoteFontSizeSchema.mark)
}

/** 供测试引用的内部常量。 */
export const __internal = { fontSizeStringifyHandler, fontSizeRemarkRule }
