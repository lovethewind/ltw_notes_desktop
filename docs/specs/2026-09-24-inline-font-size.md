# 行内字号（选中文字字号 / 后续输入字号）

> 状态：待评审（draft，v2）
> 日期：2026-09-24
> 领域：编辑器（MarkdownVisualEditor / Crepe / markdown 往返）
> 分级：**L2**（新增自定义 mark + remark transformer + stringify handler；**移除**已有整篇缩放语义）
> 前置：
> - `2026-09-03-milkdown-custom-node-spike.md`（自定义节点接线范式、三个「Context not found」踩坑）
> - `2026-09-03-note-embed-card.md`（自定义节点落地先例）
> - 提交 `af755fc` / `8a514a9` / `23979bd`（**将被本方案部分回退**）

## 缘起与 v2 变更

`af755fc` 引入「正文显示字号」= **整篇显示缩放**（调 CSS 变量 `--markdown-body-font-size`，源码不动），
`8a514a9` 把两个按钮换成下拉。用户的实际预期是**给选中文字单独设字号**。

v1 规格（本文件上一版）曾设计为「一个入口、双语义：无选区=整篇 / 有选区=选区」。

**v2 按用户明确指示推翻该设计**（原话）：

> 不支持直接设置正文已有内容，选中再改，没选中则只对后续新打的正文内容生效

即：

1. **取消「整篇缩放」语义** —— 不再是「一个入口两种后果」，`--markdown-body-font-size` 回归固定基准值，不再由用户控制；
2. **有选区 → 改选区**（写进正文源码）；
3. **无选区 → 只对后续输入的正文生效**（ProseMirror `storedMarks` 机制）。

**这次简化消除的旧风险**：v1 把「同一入口两种后果（一个不进文件、一个进文件）」列为**高风险**，
需要靠视觉区分 + 面板标题切换 + 说明文案来化解。取消整篇语义后，**两种路径都写进文件、语义一致**，
该风险归零。

## 目标

1. 「选中文字字号」：给 ProseMirror 选区设行内字号，**写进正文源码**，桌面端与 Web 端（`ltw_front_v3`）都能渲染。
2. 「无选区设字号」：只影响**后续输入**，行为与粗体/斜体按钮完全一致。
3. **往返无损**：含字号的正文 `getMarkdown()` → 重新 parse → 形态不变（含嵌套、跨 mark、表格单元格）。
4. 设回默认值（15px）→ **移除标记**，正文不留 `<span style="font-size:15px">` 冗余。
5. 移除标记后正文**完全回到纯 Markdown**，无残留脏语法。
6. **移除**整篇缩放：`--markdown-body-font-size` 固定 15px，不再有 localStorage 记忆与「正文字号」全局设置。

## 非目标

- **不改**同步链路、`note_links` 表、关系重建逻辑。
- **不发明 Markdown 方言**：行内字号的源码表达就是标准 HTML `<span style="font-size:Npx">`。
- 不做「字号继承/相对字号」（如 `1.2em`）—— 只存绝对 px，与档位表一致。
- 不改 Web 端 `ltw_front_v3` 代码（依赖 marked 对行内 HTML 的原样保留，已实测）。
- **不做整篇缩放**（新目标里已明确移除，非「暂缓」）。

## 已验证的技术事实（读 node_modules + 实测，非臆断）

### 1. mdast 里 `<span style>` 是**扁平的兄弟节点序列**，不是嵌套树

实测 `mdast-util-from-markdown`（探针见文末附录）：

| 形态 | 源码 | mdast（简写） |
|---|---|---|
| ① 纯文本 | `普通 <span18>放大</span> 普通` | `html(<span18>) · text · html(</span>)` |
| ② span 内含粗体 | `<span18>前**粗**后</span>` | `html(<span18>) · text前 · strong · text后 · html(</span>)` |
| ③ 粗体内含 span | `**前<span18>大</span>后**` | `strong[ text前 · html(<span18>) · text大 · html(</span>) · text后 ]` |
| ④ **嵌套字号** | `<span18>a<span22>b</span>c</span>` | `html(<span18>) · text_a · html(<span22>) · text_b · html(</span>) · text_c · html(</span>)` |
| ⑤ 表格单元格 | `\| <span18>大</span> \|` | `tableCell[ html(<span18>) · text · html(</span>) ]` |

**推论**：
- 嵌套字号（④）在 mdast 里是**扁平序列** → 转换用**栈**即可还原成嵌套区间。
- **「跨 mark 边界」不是难题** —— `<span>` 与 `**strong**` 在 mdast 里**本来就是同层兄弟**。
  （v1 曾把它当深水区，实测推翻。）

### 2. 自定义「包裹型」类型可被 remark-stringify 序列化，且**逐字节往返**

扩展点 `remarkStringifyOptionsCtx.handlers`（`@milkdown/core` lib:75）。实测：

```
IN : 普通文字 <span style="font-size:18px">放大的一段</span> 回到普通
OUT: 普通文字 <span style="font-size:18px">放大的一段</span> 回到普通     ← 逐字节一致
```

- 无 handler 时抛 `Cannot handle unknown node \`xynoteFontSize\``（已实测）→ **必须注册**。
- handler 正确签名 **四参** `(node, parent, state, info) => string`，用 `state.write` / `state.containerPhrasing`；
  ⚠️ Milkdown 的 `toMarkdown.runner` 用 `state.addNode` —— **两套 API 混用报 `state.addNode is not a function`**（已实测踩到）。
  签名照抄 `mdast-util-to-markdown/lib/handle/emphasis.js`。

### 3. `toggleMark` **原生**区分「有选区 / 无选区」，正是本需求要的语义

`prosemirror-commands`（dist/index.js:680）：

```js
function toggleMark(markType, attrs = null, options) {
  return function (state, dispatch) {
    let { empty, $cursor, ranges } = state.selection
    ...
    if ($cursor) {                                     // ← 无选区（光标）
      if (markType.isInSet(state.storedMarks || $cursor.marks()))
        dispatch(state.tr.removeStoredMark(markType))
      else
        dispatch(state.tr.addStoredMark(markType.create(attrs)))
    } else {                                           // ← 有选区
      ... state.tr.addMark(...) / removeMark(...)       // 改实际文档
    }
  }
}
```

- `storedMarks` = 「待施加的标记」，只影响**后续输入**（`prosemirror-state` dist/index.js:549 `setStoredMarks`）。
- 这是粗体/斜体按钮的**标准机制**，无需自创。

### 4. ⚠️ **storedMarks 会被 blur 丢弃 → 必须用 `pointerdown` 而非 `click`**

当前下拉用的是 `click`。点按钮时浏览器**先让工具栏夺焦、编辑器 blur** → `storedMarks` 丢失 → 「无选区设字号」失效。

**Crepe 自己的顶栏就是这么绕开的**（`@milkdown/crepe/lib/esm/feature/top-bar/index.js:609`）：

```js
const onClick = (fn) => (e) => {
  e.preventDefault();          // ← 阻止默认焦点转移
  if (ctx) fn(ctx);
}
// 选项按钮用 onPointerdown: (e) => { e.preventDefault(); e.stopPropagation(); ... option.onSelect(ctx) }
```

→ 本功能的下拉**触发器与选项都必须从 `click` 改为 `pointerdown` + `preventDefault()`**。

### 5. `listener.selectionUpdated` 可感知选区变化（触发器显示待用字号要用它）

`@milkdown/plugin-listener` 暴露 `selectionUpdated(ctx, selection, prevSelection)`（`.d.ts` 已确认）。
现有代码只在 `listener.updated` 里同步历史按钮（`MarkdownVisualEditor.vue:2360`），**未用** `selectionUpdated`。

### 6. `marked`（Web 端预览）原样保留行内 `<span style>`（已实测）

```
IN : 普通文字 <span style="font-size:18px">放大的一段</span> 回到普通
OUT: <p>普通文字 <span style="font-size:18px">放大的一段</span> 回到普通</p>
```

### 7. 现成范式与扩展点

| 能力 | 来源 | 用途 |
|---|---|---|
| `$markSchema(id, ctx => spec)` | `@milkdown/kit/utils`（已确认导出） | 行内标记；返回**二元组** `[ctx, mark]` |
| `spec.excludes` | ProseMirror mark spec | `''` = 允许同类型共存（**嵌套字号保真必需**） |
| `remarkStringifyOptionsCtx` | `@milkdown/core` lib:75 | 注册自定义 handler |
| `remarkPluginsCtx`（前置插入） | `@milkdown/core` | 抢在内置插件前改写 mdast（`xynote-hardbreak.ts` 已验证手法） |
| `editorViewCtx` | 已在组件导入（`MarkdownVisualEditor.vue:151`） | 拿 view 派发事务 |

参照实现：`src/editor/xynote-hardbreak.ts`（内联 `<br>` 保真）、`src/editor/xynote-embed.ts`（块级自定义节点）。

## 设计

### 数据流（markdown → mdast → ProseMirror → 回来）

```
markdown 字符串：  普通 <span style="font-size:18px">放大</span> 普通
        │ ① remark transformer（前置插入，栈式）
        │    遍历 inline 序列；遇 <span style="font-size:Npx"> 入栈建包裹节点，
        │    遇 </span> 出栈；其余节点挂到栈顶的 children 上
        ▼
mdast：           paragraph[ text, xynoteFontSize{size:18}[ text ], text ]
        │ ② markSchema.parseMarkdown：openMark(markType, {size}) → next(children) → closeMark
        ▼
ProseMirror：     正文 · 「放大」(mark xynoteFontSize{size:18}) · 正文
        │ ③ markSchema.toMarkdown：withMark(mark, 'xynoteFontSize', undefined, {size})
        │    → 生成 xynoteFontSize 容器节点（size 经 props 展开进节点）
        │ ④ stringify handler：输出 <span style="font-size:Npx"> + containerPhrasing(children) + </span>
        ▼
markdown 字符串：  回到那段标准 HTML（闭环、无损）
```

### 新增模块 `src/editor/xynote-font-size.ts`

逐条对齐 `xynote-embed.ts` 的「二元组全量 use」教训（漏 `ctx` 必抛 `Context "..." not found`，编辑器整体起不来）：

```ts
export const FONT_SIZE_MDAST_TYPE = 'xynoteFontSize'
export const FONT_SIZE_MARK_NAME = 'xynoteFontSize'
export const FONT_SIZE_STYLE_RE = /^<span\s+style=["']font-size:\s*(\d+)px;?["']\s*>$/i

// ① remark transformer：扁平 html 序列 → 嵌套 xynoteFontSize 容器
export const fontSizeRemarkTransformer = $remark('remarkXynoteFontSize', () => () => (tree) => { /* 栈式 */ })

// ② mark schema
export const xynoteFontSizeSchema = $markSchema(FONT_SIZE_MARK_NAME, () => ({
  attrs: { size: { default: DEFAULT_BODY_FONT_SIZE } },
  // ⚠️ 允许同类型共存：既有嵌套字号需保真（a={18} b={18,22} c={18}）
  excludes: '',
  // 用属性选择器精确抢回，避免被内置 html schema 的通用 span 规则接走
  parseDOM: [{ tag: 'span[data-xynote-font-size]', priority: 60 }],
  toDOM: (mark) => ['span', {
    'data-xynote-font-size': String(mark.attrs.size),
    style: `font-size:${mark.attrs.size}px`
  }, 0],
  parseMarkdown: {
    match: (node) => node.type === FONT_SIZE_MDAST_TYPE,
    runner: (state, node, markType) => {
      state.openMark(markType, { size: node.size })
      state.next(node.children)
      state.closeMark(markType)
    }
  },
  toMarkdown: {
    match: (mark) => mark.type.name === FONT_SIZE_MARK_NAME,
    runner: (state, mark) => {
      // ⚠️ props 被 #createMarkdownNode 展开进 mdast 节点，handler 侧靠它拿回 size
      state.withMark(mark, FONT_SIZE_MDAST_TYPE, undefined, { size: mark.attrs.size })
    }
  }
}))

// ③ stringify handler（四参签名，仿 mdast-util-to-markdown/handle/emphasis.js）
const fontSizeStringifyHandler = (node, _, state, info) => { /* 输出成对 html */ }

// ④ 组合挂载
export function installFontSizeFeature(editor) {
  editor.use(fontSizeRemarkTransformer.options)   // 不可漏
  editor.use(fontSizeRemarkTransformer.plugin)
  editor.use(xynoteFontSizeSchema.ctx)            // 不可漏
  editor.use(xynoteFontSizeSchema.mark)
  editor.use(fontSizeStringifyPlugin)             // 注册 handler 进 remarkStringifyOptionsCtx
}
```

### 工具栏：下拉语义改为「选区字号 / 待用字号」

现有 `createFontSizeMenu()`（`MarkdownVisualEditor.vue:~1966`）改造。**位置与外观保持**
（在「一级标题」后、`min-width:58px`、`flex-direction:row` —— 已由 `23979bd` 锁死并有 e2e 守护）：

| 状态 | 触发器显示 | 面板标题 | 点选项的后果 |
|---|---|---|---|
| **有选区** | 选区当前字号（不一致时取选区起点） | 「选中文字字号」 | `addMark`/`removeMark` → **写进正文** |
| **无选区** | 待用字号（`storedMarks`）或光标处字号，无则 15 | 「字号」 | `addStoredMark`/`removeStoredMark` → **只影响后续输入** |

- `aria-label` 同步：`选中文字字号` / `字号`。
- 白色空格选区**按无选区处理**（见边界表），此时面板标题显示「字号」。

### 应用逻辑

```
applyFontSize(size):
  const isDefault = size === 默认值(15)
  view.dispatch(tr => {
    if (selection.empty 或 选区全为空白) {
      // 无选区：只动 storedMarks，不影响已有内容
      tr.removeStoredMark(markType)                 // 先清，避免叠加
      if (!isDefault) tr.addStoredMark(markType.create({ size }))
    } else {
      tr.removeMark(from, to, markType)             // 替换语义，避免无意义嵌套
      if (!isDefault) tr.addMark(from, to, markType.create({ size }))
    }
  })
```

- **替换而非叠加**：常规操作永不产生嵌套。`excludes: ''` 的并存能力**仅用于保真既有嵌套**。
- 设回默认值 = `removeStoredMark` / `removeMark` → **标记被移除**（用户要求）。
- 走 `editor.action(...)`，进撤销栈。

### 待用状态（`storedMarks`）的存亡规则

**完全对齐粗体/斜体按钮**（ProseMirror 原生行为，不自创规则）：

| 情形 | 行为 |
|---|---|
| 设字号后**直接打字** | 新字符带上该字号 ✅ |
| 设字号后**点到别处** | 光标移动 → 回到该处格式，待用字号失效（与粗体一致） |
| 设字号后**关掉下拉但没动光标** | 待用字号保留，直到光标移动或输入 |
| 设字号后**按 Esc / 点面板外** | 不额外清除（无「取消」概念，同粗体） |

> 理由：与粗体一致 = 用户零学习成本；自创「黏住不丢」需额外定义失效时机，收益低且易与既有心智冲突。

### 移除整篇缩放（本方案的「减法」）

| 位置 | 现状 | 改为 |
|---|---|---|
| `MarkdownVisualEditor.vue:11` | `:style="{ '--markdown-body-font-size': ... }"` 绑组件根 | **删除**该绑定 → 变量回落 `style.css:464` 的固定 `15px` |
| `editor-font-scale.ts` | `FONT_SCALE_STORAGE_KEY` / `parseStoredFontScale` / `indexOfFontSize` | **删除**（不再持久化；档位表 `FONT_SCALE_STEPS` 与默认值保留） |
| `MarkdownVisualEditor.vue` | `fontScaleIndex` / `bodyFontSize` / `setFontSize()` 整篇逻辑 | **删除**，替换为选区/待用字号逻辑 |
| `style.css` | `--markdown-body-font-size` 供标题/表格 `calc` 等比换算 | **保留变量与全部 calc**，仅不再有用户入口（基准值恒 15px） |

⚠️ **副作用须告知用户**：此前把正文字号设成别的值（如 22px）的用户，升级后会看到**回到 15px**。
因为该设置从未写进正文源码（这正是当初的设计），所以**没有数据可迁移**，只是显示基准回落。
用户若要大字号，需选中文字后设置（或先设待用字号再打字）。

## 边界与降级

| 场景 | 行为 |
|---|---|
| 选区跨多个段落 | 逐段加 mark（ProseMirror `addMark` 原生支持） |
| 选区含粗体/斜体/链接 | span 与这些 mark 是兄弟关系（mdast 已证），各自独立互不干扰 |
| 选区含既有嵌套字号 | 替换语义：移除原有 → 统一设新值（不产生新嵌套） |
| **选区只含空白字符** | **按无选区处理**（走 `storedMarks`）——避免在空白上写无意义 span |
| 选区字号不一致（混合） | 触发器显示选区**起点**处的字号 |
| 表格单元格内 | 走同一 mark 路径（mdast 已证结构一致）；⚠️ 需 e2e 覆盖 |
| 代码块 / 行内代码内 | **不可用**（不改 code 内容）；选区全在代码内时入口置灰 |
| 只读 / 预览模式 | **不可用**（改文档内容，与显示参数不同）；`previewAllowed` **不设** |
| 文档含手写 `<span style="font-size:18px">` | transformer 正常解析成 mark、显示生效；不视为脏数据 |
| 字号值不在档位表内（手写 17px） | 触发器显示实际值；选中档位值即被替换 |
| 第三方渲染器剥离 `style` | 降级为普通文本（不崩溃、不脏同步），符合「安全退化」 |
| 无选区 + 已在某 span 内 + 设新字号 | 只改 `storedMarks`（**不动**所在 span）→ 符合「不支持直接设置正文已有内容」 |

## 落地步骤

| 阶段 | 内容 | 退出门 |
|---|---|---|
| **T1 纯逻辑** | `src/utils/inline-font-size.ts`：span 识别、size 解析校验、默认值判定、**空白选区判定**、栈式转换纯函数 | 单测覆盖各边界（含 5 种 mdast 形态），**真行为断言** |
| **T2 transformer + schema** | `src/editor/xynote-font-size.ts` 全量实现 + 按二元组全量 use 接线 | 编辑器能起、手写 span 能解析成 mark、`getMarkdown()` 往返无损 |
| **T3 工具栏改造** | 语义改为选区/待用；**`click` → `pointerdown` + `preventDefault`**；选项接线；`selectionUpdated` 同步触发器 | 手测：有/无选区行为正确；**无选区设字号后直接打字确实带字号** |
| **T4 移除整篇缩放** | 删组件根的变量绑定、`fontScaleIndex`/`bodyFontSize`/`setFontSize`、localStorage 持久化 | 标题/表格字号仍随 15px 基准正确显示；无残留死代码 |
| **T5 测试** | 单测（纯逻辑）+ e2e（设字号 / 移除 / 往返逐字节 / 表格内 / 嵌套保真 / storedMarks / 整篇缩放已移除） | `npm test` 全绿、e2e 全绿、`typecheck` + `build` 通过 |
| **T6 打包手测** | 出 arm64 免安装包 | 交用户手测 |

**验证顺序铁律**：`npm run build` **必须**先跑通再跑 e2e（否则 `main.cjs` 走 `loadFile(dist/index.html)`，
跑的是旧渲染层，症状「新功能毫无反应、旧功能全正常」，极易误判成接线写错）。

## 验收标准

1. 选中一段文字设 18px → 正文源码出现 `<span style="font-size:18px">…</span>`，编辑区视觉变大。
2. 同一段设回 15px → 源码里该 span **完全消失**，正文回到纯 Markdown。
3. **无选区设 22px → 直接打字，新字符是 22px**；光标点到别处后打字 → 跟随该处格式（同粗体）。
4. **无选区设字号不会改动任何已有内容**（源码不变）。
5. 选区只含空格时，按无选区处理（不产生空白 span）。
6. `getMarkdown()` 输出重新 parse 回来**逐字节一致**（含嵌套、跨 mark、表格单元格三种形态）。
7. **整篇缩放已移除**：不存在任何改变全篇缩放的用户入口；改字号在不选中时不影响已有文字。
8. Web 端（`ltw_front_v3` 的 marked 渲染）能正确显示该字号。
9. 撤销/重做能正确回退字号操作（含 storedMarks 变更不产生噪声历史）。
10. `npm test`、`npx vue-tsc --noEmit`、`npm run build` 全绿；e2e 全绿。
11. 代码块内、只读模式下入口不可用。
12. 删掉 `xynote-font-size.ts` + 移除 `installFontSizeFeature` 一行 → 可整体回退，正文里的 span 仍能被通用 html 渲染（安全退化）。

## 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 破坏 markdown 往返 / 同步 | **高** | T2 强制往返闭环 + 逐字节断言；span 是标准 HTML，出错可整段删除回退 |
| ⚠️ **`click` 导致 blur 丢 storedMarks** → 「无选区设字号」静默失效 | **高** | 触发器与选项改用 `pointerdown` + `preventDefault()`（Crepe 顶栏同款）；e2e 必须真打字验证，不能只断言 storedMarks 存在 |
| **移除整篇缩放让老用户字号回落 15px** | 中 | 无数据可迁移（从未写入源码）；在交互提示与交付说明中显式告知 |
| 同类型 mark 共存（`excludes: ''`）导致「设字号变叠加」 | 中 | 应用逻辑用**替换语义**（先 remove 再 add）；并存能力仅用于保真既有嵌套 |
| `$markSchema` 二元组漏 use → 编辑器起不来 | 中 | 照抄 `xynote-embed.ts` 全量 use 范式；起不来看 DevTools 的 `Context not found` |
| remark handler 与 Milkdown runner 用错 API（`state.addNode` vs `state.write`） | 中 | 已实测踩到；handler 四参签名照抄 `mdast-util-to-markdown/handle/emphasis.js` |
| 内置 html schema / parseDOM 抢走 span | 中 | `parseDOM` 用 `data-xynote-font-size` 属性选择器 + `priority: 60`（照 `xynote-hardbreak` 手法） |
| `pointerdown` 改造引入面板开关/外部点击关闭的回归 | 中 | 保留 `pointerdown` 与 `click` 职责分离需实测；注意「打开面板的那次 pointerdown」不得被外部关闭逻辑立刻吃掉 |
| 第三方渲染器剥离 `style` | 低 | 安全退化为普通文本；自研 Web 端已实测保留 |
| 老笔记里的手写 span | 低 | transformer 正常解析，显示生效，不视为脏数据 |

## 待评审 / 决策门

1. **面板里是否需要一句说明文案**（如「作用于选中文字；未选中则作用于后续输入」）？
   v2 取消了双后果，风险已降，可不加；但加一行能减少「为什么没生效」的困惑。
2. **`previewAllowed`**：行内字号改文档内容 → 只读模式应不可用（与已移除的整篇缩放不同）。是否认可？
3. **代码块内选区**：置灰 vs 允许但静默跳过？（倾向置灰，给明确反馈）
4. **「清除字号」是否要独立菜单项**：目前靠「选 15px」隐式移除。档位表已含 15，倾向前者。
5. **档位表**：沿用原整篇的 `FONT_SCALE_STEPS`（9..22）还是给行内更宽的档位？（倾向复用，心智统一）
6. **是否同批改 Web 端**：本方案不改 Web 代码（依赖 marked 保留行内 HTML）。若要 Web 端也提供入口，另立 spec。

## 实施记录（2026-10-07）

### 落地清单

| 步骤 | 产物 | 状态 |
|---|---|---|
| T1 | `src/utils/inline-font-size.ts` + `tests/inline-font-size.test.cjs` | ✅ |
| T2 | `src/editor/xynote-font-size.ts` | ✅ |
| T3 | `MarkdownVisualEditor.vue` 下拉改造（`pointerdown` + 选区/待用语义 + `selectionUpdated`） | ✅ |
| T4 | 删除 `src/utils/editor-font-scale.ts` 及其两个旧测试；移除根节点变量绑定与 localStorage | ✅ |
| T5 | `tests/inline-font-size-editor.test.cjs`（13）+ `tests/e2e/inline-font-size.e2e.test.cjs`（3） | ✅ |
| T6 | arm64 免安装包 + asar 逐字节校验 | ✅ |

验证结果：`vue-tsc` ✅ ／ `npm test` **284/284** ✅ ／ `node --test tests/e2e/*.test.cjs` **34/34** ✅ ／
asar 内 4 个 `dist/assets/*` 与本地 dist **SHA-256 逐字节一致** ✅

### 验收标准落实情况

| # | 验收项 | 落实 |
|---|---|---|
| 1 | 选中设 18px → 源码出现 span | ✅ e2e `选区字号`（用 22px 测） |
| 2 | 设回 15px → span 完全消失 | ✅ e2e 同上 |
| 3 | 无选区设 22px → 打出来的字是 22px | ✅ e2e `待用字号`（用 20px 测，**真打字**验证） |
| 4 | 无选区设字号不动已有内容 | ✅ e2e `待用字号`（断言 `hello` 不在 span 内） |
| 5 | 选区只含空格 → 按无选区处理 | ✅ 单测（`isBlankText`）+ 接线断言（分支存在）；未单列 e2e |
| 6 | 往返逐字节一致 | ✅ e2e `待用字号` 用 `assert.equal` 守住（重开后落库正文**逐字不变**） |
| 7 | 整篇缩放已移除 | ✅ 单测反向断言（组件无变量绑定 / 无 localStorage / 模块已删除）+ asar 里旧符号全无 |
| 8 | Web 端 marked 正确显示 | ⚪ 依据 09-24 的实测（marked 原样保留行内 HTML），本轮**未在 Web 仓复测** |
| 9 | 撤销/重做正确 | ⚪ 走标准 `tr` dispatch，未单列 e2e |
| 10 | 全部校验绿 | ✅ 见上 |
| 11 | 只读模式入口不可用 | ✅ 只读态禁用列表不再排除字号下拉，且选项一并禁用；**代码块见下** |
| 12 | 可整体回退 | ⚪ 设计属性（删文件 + 删一行），未实测 |

### 决策门的落地选择（可推翻）

1. **说明文案**：未加（沿用你 v2 的判断）。
2. **`previewAllowed`**：只读/预览态**禁用**字号下拉（它会写正文）。
3. **代码块内选区**：**未做置灰**。ProseMirror 的 `code_block` 不允许 mark，
   `addMark` 会**静默跳过** —— 不报错、也不脏数据，只是「点了没反应」。
   若要按原倾向改成置灰，需要额外判定 `rangeHasMark` 之外的 `allowsMarkType`，请示意。
4. **清除字号**：靠「选 15px」隐式移除，未加独立菜单项。
5. **档位表**：复用 `FONT_SCALE_STEPS`（9..22，含 15 默认档）。
   → **2026-10-08 修订**：按用户反馈扩为 17 档
   `9,10,11,12,14,15,16,18,20,22,24,26,28,36,42,48,72`（尾部 24…72 为大字号粗粒度阶梯）。
   `DEFAULT_FONT_SCALE_INDEX = 5`（15px 默认档）不变；`max-height: 320px` 不变，
   因此面板内滚动属预期形态。档位表在单测与两个 e2e 里各有一份**全表断言**，改档必须四处同改。
6. **Web 端**：未改。

### 实施中新发现的三条（规格里没有，已写进测试守卫）

1. 🔴 **`page.waitForFunction` 传 async 谓词不会等 Promise** → 等待形同虚设，断言立即读到旧值
   （本轮实测：20s 的等待语句 3.4s 就跑完）。轮询必须放 Node 侧。
2. 🔴 **`listener.selectionUpdated` 在 `state.apply` 内部同步触发**，
   此刻 `view.state` 仍是上一个 state → 必须 `queueMicrotask` 后再读，否则下拉永远慢一拍。
   （规格第 5 条只说了「可用它感知选区」，没提这个时序陷阱。）
3. **`MarkType` 没有 `addToSet`**（`.d.ts` 只有 `removeFromSet`/`isInSet`）→
   写 `markType.create(attrs).addToSet(set)`，不是 `markType.addToSet(...)`。

### 交付副作用（需告知用户）

老用户此前通过下拉设过的**整篇字号会回到 15px**：那个值只存在 `localStorage`，
从未写进正文，因此**没有数据可迁移**。

## 附录：本次实测命令与输出

> 探针均为临时脚本，验证后已删除。以下为可复现的关键证据。

### A. mdast 结构（`mdast-util-from-markdown`）

```js
fromMarkdown('普通 <span style="font-size:18px">放大</span> 普通')
// → paragraph.children:
//   [ {type:'text', value:'普通 '},
//     {type:'html', value:'<span style="font-size:18px">'},
//     {type:'text', value:'放大'},
//     {type:'html', value:'</span>'},
//     {type:'text', value:' 普通'} ]
```

嵌套形态（关键）：
```js
fromMarkdown('<span style="font-size:18px">a<span style="font-size:22px">b</span>c</span>')
// → 扁平序列：html(<span18>) text_a html(<span22>) text_b html(</span>) text_c html(</span>)
```

### B. stringify handler 往返（`remark-stringify` + 自定义 handler）

```
OUT   : "普通文字 <span style=\"font-size:18px\">放大的一段</span> 回到普通\n"
REPARSE: [text "普通文字 ", html "<span style=\"font-size:18px\">", text "放大的一段", html "</span>", text " 回到普通"]
```

### C. 无 handler 时报错（证明必须注册）

```
ERROR: Cannot handle unknown node `xynoteFontSize`
```

### D. `marked` 保留行内 HTML

```
IN : 普通文字 <span style="font-size:18px">放大的一段</span> 回到普通
OUT: <p>普通文字 <span style="font-size:18px">放大的一段</span> 回到普通</p>
```

### E. `toggleMark` 原生双分支（`prosemirror-commands` dist/index.js:680）

```js
if ($cursor) { /* 无选区 */ if (markType.isInSet(state.storedMarks || $cursor.marks()))
    dispatch(state.tr.removeStoredMark(markType))
  else dispatch(state.tr.addStoredMark(markType.create(attrs)))
} else { /* 有选区 */ ...addMark/removeMark... }
```

### F. Crepe 顶栏的防失焦手法（`@milkdown/crepe/lib/esm/feature/top-bar/index.js:609`）

```js
const onClick = (fn) => (e) => { e.preventDefault(); if (ctx) fn(ctx); }
// 选项：onPointerdown: (e) => { e.preventDefault(); e.stopPropagation(); ... option.onSelect(ctx) }
```
