# Milkdown 自定义节点扩展试点 + Embed 落地路径

> 状态：待评审（draft）
> 日期：2026-09-03
> 领域：编辑器（MarkdownVisualEditor / Crepe）扩展能力验证
> 分级：L3（编辑器 schema 扩展、影响 markdown 往返 / 序列化一致性）
> 前置：`2026-09-03-note-embed-card.md`（本 spec 是其「工程可行性」侧的姊妹文档）

## 缘起：为什么写这份 spec

讨论「要不要为可扩展性更换编辑器技术栈」后，结论是**不迁移**，理由量化如下：

- `MarkdownVisualEditor.vue` 1746 行，32 处直接调用 Milkdown/ProseMirror 私有 API
  （`crepe.editor.action` / `editorViewCtx` / `DecorationSet` / `@milkdown/kit/prose/*`）
- 被 `App.vue`、`NoteHistoryDialog.vue` 引用，承载大纲/预览/撤销重做/反链提及/链接建议/代码高亮/AI 召回
- 代码注释明示「创建与网页版配置一致的 Milkdown Crepe 编辑器」→ 迁移 = 桌面端 + 网页端双端重写
- Embed 等「块级自定义节点」的难，本质在「要在文档流里表达一个块」，换 CM6 并不天然更易
  （Obsidian 容易，是因为其 embed 节点已沉淀可用，不是 CM6 更易扩展）

**因此留下的关键短板不是引擎，而是：项目里从未注册过自定义节点，无先例、无文档、风险被放大。**
本 spec 用一次**低风险试点**把这条能力路走通，沉淀为可复用范例，再为 Embed（方案 B）铺路。

## 目标

1. 用最小范围验证：在 Crepe 上安全注册一个**自定义块级节点**（schema + 渲染 + 输入 + 序列化往返无损）。
2. 建立「markdown 往返、撤销、同步一致性」的回归基线，证明自定义节点不污染存储链路。
3. 沉淀项目内**首个自定义节点范例 + 文档**，使后续 Embed 等有先例可循、风险可估。

## 非目标

- 本 spec **不实现** Obsidian `![[嵌入]]` wikilink 方言。
- 本 spec **不实施**正式的 Embed 卡片（那是 embed-card spec 的事）；这里只验证「能加自定义块」这一底层能力。
- 不改 `note_links` 表、不改同步增量、不改任何既有 preset 行为。
- 不评估/不迁移到 CM6 等其它引擎（已否决）。

## 已验证的技术依据（非臆断，读 node_modules 确认）

Milkdown 7 提供完整的自定义节点「配方」API，位于 `@milkdown/utils`（composable）：

| 配方 | 作用 | 对应 embed 需求 |
|---|---|---|
| `$node` | 定义 node schema（attrs、parseDOM、toDOM、toMarkdown） | embed 节点的数据形状 |
| `$view` | 绑定自定义 node view（渲染 DOM + 交互） | 卡片渲染 |
| `$input-rule` / `$paste-rule` | 输入/粘贴触发建节点 | 用户如何「插入一个嵌入」 |
| `$mark` / `$shortcut` | inline 标记 / 快捷键 | 可选 |
| `$ctx` / `composed` | 状态与组合多个 recipe | 组合成完整 feature |

Crepe 侧扩展挂载点为 **`addFeature(feature, config)` + `defineFeature`**（已读 `crepe-builder.d.ts` 确认）。
项目当前仅用 `new Crepe({...})` + `features`/`featureConfigs`，**尚未触达 addFeature/defineFeature**——这是本次试点的真正入口。

### ⚠️ 关键发现修正（2026-09-03，读 preset-commonmark 源码后确认）

**preset-commonmark 已内置一个 `html` 节点**（`htmlSchema`，lib/index.js ~1509 行）：

- 是 **atom inline** 节点，attrs 仅 `{ value: string }`，markdown 往返**天然无损**
- `parseMarkdown`：match remark 的 mdast `html` 节点 → `state.addNode(type, { value: node.value })`
- `toMarkdown`：match 该 node → `state.addNode("html", undefined, node.attrs.value)`（原样输出 HTML 字符串）
- `toDOM`：编辑态渲染成 `<span data-type="html" data-value="...">`（用 `textContent` 安全显示源码文本）
- Crepe 默认 `.use(commonmark)`，schema 数组（~1594 行）已含 `htmlSchema` → **默认启用**
- 项目内对 html value **无 DOMPurify / sanitize** 拦截（仅 ai-assistant 对 AI 上下文做裁剪）

**推论（精确化，避免基于乐观假设推进）：**

1. **正文里写一段标准 HTML（如 `<div data-embed="note:xxx">`）会被安全存成 html node、往返无损**——
   markdown 层是「HTML 承载」，**不需要发明自定义 markdown 方言**，mdast 侧只需 match 既有 `html` type。
2. 但 html node 是 **atom inline + textContent 显示源码**，**编辑态不会渲染成卡片**——用户看到的是 HTML 代码字符串。
   → 若要「卡片呈现」，仍需自建一个带 **nodeView** 的节点（ProseMirror 硬约束：读态渲染只能靠 nodeView）。
3. 因此最干净的形态是：**自建 `noteEmbed` 节点（schema + nodeView 渲染卡片），但 markdown 序列化输出一段标准 HTML**。
   既拿到编辑/预览态的「真卡片」，又保 markdown 可移植性（网页端/纯 md 编辑器看到的是可读 HTML，不破坏同步）。

> 即：上轮 embed-card spec 的「方案 A 纯渲染层替换、几乎不碰 schema」**不完全成立**——只读态 DOM 二次替换可行，
> 但编辑态内联卡片仍需要 nodeView。而自建节点的「重」也被大幅缓解（markdown 落 HTML，免方言 parser/serializer）。

### 实现路线的关键卡点与最终方案（2026-09-03 读 transformer 源码精确化，非臆断）

**✅ 真机制澄清（推翻此前「先到先得、需抢注」的假设）**：读了 `@milkdown/transformer` 源码，parser 消费 mdast 节点
用的是 `#matchTarget`：`Object.values({...schema.nodes, ...schema.marks}).find(x => x.spec.parseMarkdown.match(node))`——
即**遍历 schema 里所有已注册 node 类型，找第一个 match 命中的**，命中后调其 runner。
推论：
- 只要给自定义 mdast type（如 `xynoteEmbed`）一个**独有**的 mdast type，内置 htmlSchema 的 match（`type==='html'`）
  对它返回 false，**会被 find 跳过** → 我的 noteEmbed 是**唯一命中者，无任何抢占/竞争**。此方案比预期更稳。
- 因此关键**不在**「抢 mdast html」，而在「remark transformer 是否在 parser 前成功把 html 改成 xynoteEmbed」。

**⚠️ 真正的运行时风险（T2 打磨点，非 T1 阻塞）**：内置还有一个 `remarkHtmlTransformer`（preset lib/index.js ~1838），
它对 parent ∈ {root,blockquote,listItem} 的**块级** html 做处理：`node.children=[{...node}]; delete node.value; node.type='paragraph'`
→ 即**把独立成行的块级 HTML 包成一个 paragraph**，原 html 成为其唯一子级（type 仍 'html'）。
我的自定义 `$remark` 通过 addFeature **后注册、后执行** → 若嵌入以独立块形式写入，内置可能先把它包进 paragraph。
- 此时 noteEmbed 是 **block 节点**，若被留在 paragraph 内（block 不能作 paragraph 子级）会出错。
- **已在 T1 一并实现**：transformer 识别「paragraph 内唯一子级是命中 embed 的 html」→ 把该 paragraph 就地提升为
  root 级 xynoteEmbed block（`parent.children[index] = 改造后的 embedNode`）。
- 提升逻辑位置：`src/editor/xynote-embed.ts` `embedRemarkTransformer` 的「情况二」；「情况一」兜底 root 直接子级 embed html。

### ⚠️ $remark 签名硬约束（T1 实测崩出来的坑，2026-09-03 18:15）
`$remark` 的第二个参数 factory 返回的是「**remark 插件工厂**」（unified 插件），**必须三层箭头**：
```
$remark(id, () => () => (tree) => void)     // ✅ 正确（照抄 preset 内置 remarkHtmlTransformer）
$remark(id, () => (tree) => void)           // ❌ 两层会崩
```
**原因**：core 用 `remark().use(plug.plugin, plug.options)` 应用。unified 对插件以 **processor** 调用；
两层写法使首参收到 unified 实例而非 tree，抛 `Cannot read properties of undefined (reading 'type')`，
**导致所有 markdown 解析（含 replaceAll 切换笔记）失败 → 正文任何切换都不渲染**。已实测确认（纯 remark 层：
两层连 `# hi` 都崩，三层正常）。教训：Milkdown `$remark`/`$node` 类 recipe 的**箭头层数**是易错点，
改完要在真实 markdown 解析路径验证，不能只 typecheck。

**最终方案（markdown 字符串 = 标准 HTML；mdast 内部 = 自定义 type，二者解耦）**：

```
markdown 字符串层：  <div data-xynote-embed="note:<id>" title="..."></div>   （标准 HTML，往返无损、网页端安全退化）
        │  parse 时：先挂一个 remark transformer 插件，在 mdast 层把 value 含
        │  `data-xynote-embed=` 的 html 节点改造成自定义 mdast type：{ type:'xynoteEmbed', ... }
        │  [T2] 若该 html 已被内置 remarkHtmlTransformer 包进 paragraph，需提升为 root 级 block
        ▼
mdast 层：           { type:'xynoteEmbed', noteId }                           （独有 type，find 唯一命中，无冲突）
        │  noteEmbed.parseMarkdown.match 这个自定义 type → state.addNode(noteEmbed, ...)
        ▼
ProseMirror 层：     noteEmbed block node（attrs: noteId），nodeView 渲染为卡片占位（编辑/预览态皆卡片）
        │  noteEmbed.toMarkdown → state.addNode('html', undefined, '<div data-xynote-embed...>') 还原 HTML
        ▼
markdown 字符串层：  回到那段标准 HTML（闭环、无损）
```

- **mdast 内部结构可自定义**（仅内存态），只要 markdown 字符串表达是标准 HTML 即可无损往返——这正是本方案的基石。
- remark transformer 用 Milkdown 的 `remark`/`$ctx` 能力挂载，或直接作为 remark plugin 注入 parser。
- 此路线**避开**「match 冲突」与「发明方言」两大难题，是 Embed（方案 B）的精确可实施路径。

## 试点设计：用一个「无实际业务、纯验证」的块级节点

为避免直接拿 Embed 当实验品（污染正文存储、拖累产品），试点用一个**确定能无害回退**的示例块，
例如一个只读的「分隔卡」（horizontal callout / 一个自闭合的纯展示节点），其 markdown 表达为一个**专属但自包含**的语法。

### 试点节点定义草案（示意，非最终实现；基于 html node 发现修正）

```text
语法表达：不发明 markdown 方言。正文里就是一段标准 HTML：
         <div data-xynote-embed="note:<id>" title="..."></div>
         经 remark 解析 → mdast html type → 我们的 parseMarkdown match 它 → 建 noteEmbed 节点
         noteEmbed 节点 toMarkdown → 输出回同样一段 HTML（往返无损）
schema：block 节点，attrs = { noteId: string, title?: string }（试点可用演示 id）
parseMarkdown：match mdast { type:'html' }，其 value 含 data-xynote-embed= → 建 noteEmbed
toMarkdown：noteEmbed → state.addNode('html', undefined, '<div data-xynote-embed="note:<id>"></div>')
node view（$view）：把该块渲染成一张「卡片占位」，编辑态也能看到卡片形态（而非 HTML 源码）
input rule：可选。试点建议先用命令/按钮触发插入，避开输入 rule 手感调优
```

> 原则：**markdown 往返不可破**。正文存储的字符串经过 `editor.getMarkdown()` 出来必须能再 `parse` 回去，
> 否则同步、导出、网页版都会散架。试点最重要的验收就是这一条。
> 若网页端未识别 `data-xynote-embed`，该 HTML 在网页端安全显示为一段 HTML（不崩溃、不脏同步），符合「安全退化」。

## 落地步骤（试点 → 沉淀 → 正式 Embed）

| 阶段 | 内容 | 退出门（完成才算过） |
|---|---|---|
| **T1 探路（最小 spike）** | 用 `defineFeature` + `$node`/`$view` 注册一个自闭合展示块，经 `addFeature` 挂进 Crepe；确认能渲染、能删 | 编辑器能创建并显示该块，无 console 报错，撤销可回退。**【已落地；两个 bug 均已修；待桌面复验】**：`src/editor/xynote-embed.ts` typecheck 全绿、已打包。历史两个独立 bug——①`$remark` 两层签名；②**真正根因**：`installXynoteEmbedFeature` 只 `use(noteEmbedNodeSchema.node)` 漏 `use(noteEmbedNodeSchema.ctx)`，$node 运行 `ctx.get('xynoteEmbed')` 抛 `MilkdownError: Context "xynoteEmbed" not found` → crepe.create() 崩、编辑器起不来 → 表现为「切换不渲染」（经 DevTools 实测定位）。修复：补 `editor.use(noteEmbedNodeSchema.ctx)`（$nodeSchema 是二元组 [ctx, $node]，两者都要 use）。桌面复验项：①切换笔记恢复渲染 ②手写 embed html 能渲染成占位块 |
| **T2 序列化往返闭环** | 补 `toMarkdown`/`parseMarkdown`，让该块在 `getMarkdown`→重开文档后**形态不变** | 存→重载后仍是同一块节点，未退化成孤立文本 |
| **T3 回归门禁** | 跑全量数据库/同步/迁移测试 + `typecheck`/`build`，确认零副作用 | 全套回归通过；确认正文存储串未引入脏数据 |
| **T4 沉淀范例** | 把 T1-T3 的代码抽成 `docs/` 下自定义节点范例 + 简短 how-to，注明 API 与坑 | 有可复制的最小范例，Embed 可直接参考 |
| **T5（后续，另立 spec）** | 基于沉淀的范例，实现正式 Embed（对应方案 B 或回落方案 A） | 交回 embed-card spec 决策 |

## 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 自定义节点破坏 markdown 往返 / 同步 | 高 | T2 强制往返闭环 + T3 全量回归门禁；试点块用无害自闭合形态，出错可整段删除回退 |
| Crepe `addFeature` 与现有 feature（TopBar/BlockEdit）配置冲突 | 中 | T1 先在独立最小环境验证，再并入主编辑器；冲突可隔离回滚 |
| 网页端共用配置 → 网页端不认识新语法 | 高 | 试点块语法设计成网页端可「安全退化为纯文本/普通链接」；未达成前不推正式 Embed |
| 自定义 node view 与 Vue 渲染 / 撤销栈交互异常 | 中 | $view 优先用轻量 DOM 渲染，避免在 node view 里重度依赖 Vue 生命周期 |

## 验收标准

1. T1：编辑态能插入并显示试点块，可选中、可删除、可撤销重做。
2. T2：含试点块的正文 `getMarkdown` → 重建文档 → 仍是同类型块节点（往返无损）。
3. T3：`npm test`、`npm run typecheck`、`npm run build` 全绿；数据库/同步/迁移测试零失败。
4. 删除试点块后正文回到纯 Markdown，无残留脏语法。
5. 主编辑器既有功能（大纲/预览/撤销/反链/图片/表格/公式）无回归。
6. 沉淀的范例文档可指导后续 Embed 直接照抄接线方式。

## 待评审 / 决策门

1. **试点块选哪种形态**（自闭合展示块 vs 容器式）——影响序列化复杂度，倾向自闭合展示块先验证。
2. **触发方式**（输入 rule / 工具栏命令 / 都做）——试点阶段建议用命令/按钮，避开输入 rule 的手感调优。
3. 是否同意「先试点验证、T5 再正式 Embed」的次序（不拿 Embed 直接当实验品）。
4. 是否需要网页端同批支持（若否，试点的语法退化为普通文本即可先桌面端推进）。
5. **是否接受「markdown 承载用标准 HTML（`<div data-xynote-embed>`）」而非发明 markdown 方言** —— 基于 html node 发现推荐接受：往返引擎已保证无损、网页端安全退化、无需手写方言 parser。若拒绝（坚持原生结构 markdown），则需回到自造方言，工作量显著上升。

## 实测踩坑清单（2026-09-03，三个都是「编辑器整体起不来 → 表现为切换不渲染」的真实案例）

> 后续做正式 Embed / 任何自定义节点时，这几条是最容易重蹈覆辙的接线错误。DevTools 报错是定位利器，
> 远比反复静态审读渲染逻辑高效。踩坑 1 与坑 3 是**同一种 bug 的两次变体**，见下方「统一规律」。

### 坑 1（经 DevTools 实测坐实）：`$nodeSchema` 是二元组，`ctx` 和 `node` 都要 use

```
MilkdownError: Context "xynoteEmbed" not found, do you forget to inject it?
```

- `$nodeSchema(id, schema)`（@milkdown/utils）返回的是**二元数组** `[schemaCtx, $node]`：
  - `.ctx`（内部 `$ctx(schema, id)`）：负责把名为 `id` 的 slice **inject 进 context**（存 schema factory）
  - `.node`（内部 `$node(...)`）：运行时执行 `ctx.get(schemaCtx.key)` 去读那个 slice
- preset-commonmark 没这问题，是因为它用 `[..., headingSchema, ...].flat()` 把每个 `$nodeSchema` **自动展开成
  `[ctx, node]`** 一起 use。手写 `installFeature` 时必须**显式 use 两者**，漏 `.ctx` 就会抛上面那个错。
- ❌ 错误接线：`editor.use(noteEmbedNodeSchema.node)`（漏 ctx）

### 坑 3（坑 1 的变体，经 DevTools 二轮实测坐实）：`$remark` 是二元组，`options` 和 `plugin` 都要 use

```
MilkdownError: Context "remarkXynoteEmbedTransformer" not found, do you forget to inject it?
```

> 修复坑 1 后报错从 `xynoteEmbed` 推进到 `remarkXynoteEmbedTransformer`，坐实两者是同构 bug，也反证坑 1 已修好。

- `$remark(id, remark)` 同样返回**二元数组** `[optionsCtx, plugin]`：
  - `.options`（内部 `$ctx(initialOptions, id)`）：负责把名为 `id` 的 slice **inject 进 context**（存 initialOptions）
  - `.plugin`：运行时执行 `ctx.get(options.key)` 去读那个 slice（拿 initialOptions）
- ❌ 错误接线：`editor.use(embedRemarkTransformer.plugin)`（漏 options）

### ⚠️ 统一规律（坑 1 与坑 3 的合并教训，T5/后续开发必读）

Milkdown 的**合成 recipe 全是「二元组」**：`return [注入用的 ctx, 主体]`，两个部分各司其职、**都必须独立 use**：

| recipe | 注入部分 | 主体部分 |
|---|---|---|
| `$nodeSchema` | `.ctx` | `.node` |
| `$remark` | `.options` | `.plugin` |
| `$markSchema` | `.ctx` | `.mark` |

- 手写 `installFeature` 时，把用到的每个 recipe 的**所有导出属性都 `editor.use`**（对照 `$Xxx.d.ts` 类型逐一核对，
  别只图省事 `.plugin`/`.node` 一个属性带走）。漏任何一个注入 ctx → `crepe.create()` 崩 + `Context "..." not found`。
- 内置 preset 从不缺，是因为它们 `[...].flat()` 把整个数组自动展开；手写无此便利。
- ✅ 正确接线（src/editor/xynote-embed.ts `installXynoteEmbedFeature`，四 use 全量）：
  ```ts
  editor.use(embedRemarkTransformer.options)  // 注入 `remarkXynoteEmbedTransformer` slice（不可漏）
  editor.use(embedRemarkTransformer.plugin)
  editor.use(noteEmbedNodeSchema.ctx)         // 注入 `xynoteEmbed` slice（不可漏）
  editor.use(noteEmbedNodeSchema.node)
  ```

### 坑 2：`$remark` 的箭头层数

```
Cannot read properties of undefined (reading 'type')   // 两层箭头时
```
- 签名必须三层 `$remark(id, () => () => (tree) => void)`，照抄 preset 内置 `remarkHtmlTransformer`；两层会把 unified 实例当 tree 传入而崩。
- 细节见上文「实现路线的关键卡点与最终方案」章节 95-103 行。

### 诊断方法论

- 表现「切换笔记不渲染」≠ 切换逻辑坏。**先判断编辑器是否 create 成功**——若 `crepe.create()` 就抛错，那是
  schema/recipe 接线问题（坑 1/2/3 皆属此类），与 replaceAll 无关。
- 桌面端诊断通道：`electron/main.cjs` 顶部菜单已加「开发者 → 打开开发者工具」（⌘⌥I，detach 模式），
  打开 Console 看红错即点名根因。
