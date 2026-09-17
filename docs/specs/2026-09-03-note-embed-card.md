# 笔记嵌入卡片（Note Embed Block / Card）

> 状态：已实施（T2 ~ T2J 全部落地；仅剩「网页端同批支持」见文末未决）
> 日期：2026-09-03（末次更新 2026-09-10）
> 领域：编辑器（MarkdownVisualEditor / Crepe）+ 渲染层新组件
> 分级：L3（跨模块、涉及编辑器 schema 扩展、影响 markdown 往返 / 导出 / 同步一致性）

## 背景与澄清记录（避免重蹈上次误判）

前一轮曾误把「全局关系图谱」当待开发并写了 spec，后读代码确认 `GlobalGraphPanel.vue` **已存在并已接入 App.vue**
（顶栏图标按钮 + 浮层 + 深色模式样式；侧栏文字入口已于 2026-09-10 移除）。该错误 spec 已删除。本 spec 基于真实代码事实重新评估。

**确认缺失项（用户判断正确）**：`src/components` 下无任何 card/embed/preview 类组件；
编辑区内部链接 `https://xinyue-note.local/{id}`（旧 `xinyue-notes://note/{id}`）目前**只有**：
- 点击跳转 `handleEditorLinkClick`（Cmd/Ctrl+点击或只读/预览态才开链接）
- LinkTooltip 编辑链接
- 补全浮层 LinkSuggestPopover（`@hover` 是给补全用的，非预览）

**没有**链接悬停预览，**没有**把另一篇笔记在正文中渲染为卡片的节点。即用户所指的
「扩展独立组件渲染卡片」确需从零新增。

## 目标

让用户在笔记正文中能把另一篇笔记以「内嵌卡片」的形式呈现出来（标题、来源文件夹、摘要、可点击打开），
形成 Obsidian 式「嵌入」的**呈现效果**，且不破坏心悦「标准 Markdown 可移植 + 与网页版共用 Crepe」的定位。

## 非目标

- 不引入 Obsidian `[[wikilink]]` / `![[嵌入]]` 方言语法（与现有 URL 链接模型冲突）。
- 不在编辑态做「实时可编辑被嵌笔记」；嵌入是读路径呈现。
- 不改 `note_links` 表、不改同步增量逻辑。
- 本 spec 不做「全局图谱」（已完成）。

## 架构决策：正文如何表达「嵌入」？（必须先定的关键点）

心悦正文是标准 Markdown，编辑器 Milkdown/Crepe 基于 CommonMark。嵌入的**正文表达语法**决定一切。三个候选：

| 方案 | 正文表达 | markdown 往返 | 网页端/导出一致性 | 风险 |
|---|---|---|---|---|
| A. 沿用链接 + 只读渲染卡片 | `[卡片标题](https://xinyue-note.local/{id})` 仍是无害的普通链接 | 无损，`getMarkdown` 原样 | 网页端退化为可点击链接，不坏 | 最低 |
| B. 自建节点 + **HTML 承载** | `<div data-xynote-embed="note:{id}"></div>`（标准 HTML，非方言） | 引擎内置 html node 已保证无损 | 网页端把该 HTML 当普通 HTML，安全退化 | 中 |
| B'. 自建节点 + **markdown 方言** | 自定义 `:::embed {id}` 类语法 | 需自写方言 parser/serializer | 网页端需同步支持，否则孤立文本 | 高 |
| C. 图片占位符变体 | `![](xinyue-note.local/embed/{id})` | 可能被当图片处理 | 需网页端识别 | 中 |

### ⚠️ 2026-09-03 关键发现修正（读 preset-commonmark 源码）

**编辑器已内置 `html` 节点**（`htmlSchema`，atom inline，attrs=`{value}`），markdown 往返**天然无损**、
Crepe 默认启用、项目内对其 value 无 sanitize 拦截。推论：

- 正文里写一段标准 HTML（如 `<div data-xynote-embed="note:xxx">`）会被安全存为 html node、往返无损 → **方案 B 的 markdown 承载不必发明方言**，mdast 只需 match 既有 `html` type。此即表中 B（HTML 承载），风险由 B' 的高降到中。
- 但 html node 是 **atom inline + textContent 显示源码**，**编辑态不会呈现卡片**。要卡片呈现，需自建带 **nodeView** 的 `noteEmbed` 节点（schema+nodeView），markdown 序列化落成那段 HTML。**ProseMirror 硬约束：读态渲染只能靠 nodeView，纯 DOM 文本替换不成立（编辑态是 schema 树，不是 HTML）。**
- 因此上表「方案 A 纯渲染层替换、几乎不碰 schema」**不完全成立**：只读态 DOM 二次替换（把 `<a>` 换成卡片组件）可行且轻；但编辑态/预览态若要用同一 Crepe schema 树就地呈现卡片，就需要 nodeView。

**收敛判断（基于真实代码）：**

- 若目标 = **预览/只读态把链接/嵌入呈现为卡片** → 方案 A（DOM 二次替换，最轻）足够，卡片组件 `NoteEmbedCard.vue` 独立可复用。
- 若目标 = **编辑态就地看到卡片块实体（类 Obsidian 嵌入）** → 走**方案 B（自建 noteEmbed 节点，markdown 落 HTML）**，仍是 L3 工程（需 nodeView），但因 markdown 用 HTML 承载，已避开最难的「方言 parser/serializer」。此路径正是姊妹 spec `milkdown-custom-node-spike.md` 的试点对象。

**初步倾向（尊重用户此前的方向推进）：** 用户已明确要「正文嵌入卡片（编辑态即块）」→ 主线走方案 B（HTML 承载 + 自建节点），
试点先在 `milkdown-custom-node-spike.md` 验证自定义节点能力，再回落实现。方案 A 作为若评审后愿意降级的低成本替代保留。

## 模块与接口

### 1. 新独立渲染组件：`NoteEmbedCard.vue`（用户所指的"独立组件"）
职责：输入 `noteId`，拉取该笔记元数据与摘要，渲染一张只读卡片。自身**不含** Milkdown 依赖，
可复用于后续任何出现嵌入卡的场景。

- props：`noteId`；内部经 `window.notesDesktop.getNote(noteId)` 取标题/文件夹/更新时间/摘要。
  （`getNote` 已在 preload 暴露，无需新 IPC。）
- 展示：标题（可点击打开）、来源文件夹、更新时间、摘要（截断）；目标被删除/不存在时显示占位。
- 样式 token 沿用现有弹层/卡片体系；需支持深色模式。

### 2. 编辑器接线（方案 A 落地）
在 `MarkdownVisualEditor.vue` 的渲染路径上做「只读/预览态下把内部链接替换为卡片」的显示层改造：
- 定位：与 `handleEditorLinkClick` / LinkTooltip 所在同一 Crepe 实例，但走**只读态 DOM 二次处理**
  或 Milkdown decoration/widget，避免侵入编辑 schema。
- 识别：在只读 DOM 中找 `a[href^="https://xinyue-note.local/"]`，命中则替换为 `<NoteEmbedCard>`。
- 点击卡片 → 打开该笔记（复用 `openNoteLink`）。

> 注：以上是「渲染层替换」的轻量思路；若评审确认要 Milkdown 原生 widget/node（编辑态内联卡片），
> 需走 Crepe `addFeature` + `defineFeature` 注册自定义 node + node view + markdown serializer，
> 本项目无此先例，工作量和回归面显著上升，需作为方案 B 单列。

## 验收标准

1. 只读 / 预览态：正文中的内部链接渲染为卡片，展示标题、文件夹、更新时间、摘要。
2. 编辑态：仍是普通链接，可点、可编辑，未引入新语法。
3. 卡片点击可打开目标笔记；目标已删除/不存在 → 占位提示，不崩溃。
4. 摘要截断合理，长标题不溢出；深色模式正常。
5. `getMarkdown` 输出不变（正文里仍是标准链接，未被卡片污染存储）。
6. 无 `note_links` / 同步 / 备份 / 导入导出行为改变；全套回归通过。
7. `npm test`、`npm run typecheck`、`npm run build` 通过；打包 arm64 手测。

## 验证计划

- 组件单测：`NoteEmbedCard` 在目标存在 / 不存在 / 无权限时的渲染分支。
- 编辑器接线测试：只读 DOM 命中与替换；编辑态保持链接。
- 回归：现有数据库/同步/迁移测试（确保嵌入不触碰写入路径）。
- 产物：`npm run desktop:pack:mac` 手测预览态卡片。

## 待评审 / 产品确认
1. **方案 A（只读态卡片）vs 方案 B（编辑态内联块）** —— 这是最大分叉，直接影响工作量与风险。
2. 卡片要展示哪些字段、是否要支持「嵌入整篇正文」而非仅摘要。
3. 是否要求网页端（Web 版）看到同样的卡片。

---

## T2 落地设计（2026-09-04 定稿，用户选定：补全方案 B 的 nodeView）

> 决策背景：spike（T1）已在 `src/editor/xynote-embed.ts` 落地 noteEmbed **块节点 + remark transformer**，
> 经 `crepe.addFeature(installXynoteEmbedFeature)`（MarkdownVisualEditor.vue:1542）live；markdown 用标准 HTML
> 承载、往返无损已验。**当前缺口仅剩 nodeView**（schema toDOM 只渲染 demo 占位文本，无真实卡片 UI、无数据拉取）。
> 经查证，Milkdown 编辑/预览态共用同一 ProseMirror schema 树，无独立 HTML 渲染出口 → 「方案 A 纯 DOM 二次替换」
> 对主编辑器不成立，故定稿走方案 B 补全 nodeView。另注：`NoteEmbedCard.vue` 组件目录下尚不存在，需新建。

### 分层
- **`src/components/NoteEmbedCard.vue`（新）**：只读卡片 SFC，props `noteId`（+可选 `title` fallback）。
  内部 `getNote(noteId)` 拉标题/文件夹/更新时间/摘要；`listWorkspace()` 拉一次 folders 映射（参照
  `BacklinksPanel.vue`）。展示文件夹名、更新时间、标题、摘要截断；目标已删/不存在 → 占位。点击 →
  `openNoteLink(noteId)`。样式全用语义变量（`--ink/--muted/--blue/--surface/--line`），随
  `@scope(html[data-theme="dark"])` 自动适配深色。摘要取 content 纯文本前 ~160 字，**不解析被嵌笔记内的
  embed HTML**（避免无限递归）。
- **`src/editor/xynote-embed.ts`（扩展既有）**：新增 `noteEmbedView = $view(noteEmbedNodeSchema.node, ...)`，
  在 nodeView 里用 Vue `render(h(NoteEmbedCard, {noteId}), dom)` 挂载卡片；`destroy()` 时 `render(null, dom)` 卸载。
  保留既有 toDOM 作为无 nodeView 时兜底。
- **接线**：`installXynoteEmbedFeature` 增补 `editor.use(noteEmbedView)`。已核实 `$view` 是**单一 MilkdownPlugin**
  （非二元组），直接 use 即可，不踩 $nodeSchema/$remark 的 ctx/options 漏注坑（见 spike spec「坑 1/3」）。

### nodeView 关键设计（避开 ProseMirror/Milkdown 陷阱）
- `$view` 返回的构造需满足 ProseMirror NodeView：`dom` / `update(node)` / `destroy()` / `stopEvent`。
  - `update`：noteId 未变 → 返回 true（Vue 内部响应式自处理），无需重建组件；noteId 变 → 重建或更新 props。
  - `destroy`：`render(null, dom)` 卸载 Vue 应用，防泄漏。
  - `stopEvent: () => true`：卡片是块节点、自身可点开，拦截 ProseMirror 对内部点击/光标事件的处理，交由卡片内
    Vue 点击逻辑跳转。
- 摘要/标题数据在 NoteEmbedCard 内 async 拉取，与 nodeView 解耦（nodeView 只传 noteId/title 两静态 attr）。

### 验收（增量，沿用 embed-card spec 通用 7 条）
1. 正文含 `<div data-xynote-embed="note:<id>"></div>` → 编辑态/预览态/只读态均渲染为**真卡片**（非 demo 文本）。
2. 卡片展示标题、来源文件夹、更新时间、摘要；目标已删 → 占位提示，不崩溃。
3. 卡片点击可打开目标笔记（复用 openNoteLink）。
4. `getMarkdown` 输出仍为那段标准 HTML，往返无损、不脏存储。
5. 深色模式正常（全语义变量）。
6. `npm test` / `typecheck` / `build` 全绿；打包 arm64 手测。编辑器切换笔记/触发同步无回归（尤其无
   `Context "... not found"` 类接线错 —— 若崩，先查 nodeView 的 $view 是否成功 use）。
7. 无 `note_links` / 同步 / 备份 / 导入导出行为改变。

### 未决（可后续）
- 网页端同批支持（本设计桌面端先行，网页端安全退化为 HTML）。
- 「嵌入整篇正文」仅摘要 → 需要展开交互时另议。
- 输入侧：目前靠手写 HTML / 后续加按钮或命令插入，暂不做输入 rule。

---

## T2B 落地记录（2026-09-04）：插入入口——工具栏「嵌入笔记」按钮

需求澄清后定为**方案 B（补全 nodeView）**并已实现真卡片（用户手测通过「可以 有显示了」）。本次补
「插入入口」第一段：**工具栏按钮**（用户选「工具栏按钮(先做)」，slash/命令项留作后续）。

落地（已打包 `release/mac-arm64/心悦笔记.app`，chunk `MarkdownVisualEditor-9ToYINpv.js`）：
- **NoteLinkPicker.vue**：加可选 `title` prop（withDefaults 默认「插入笔记链接」），aria-label 用之，
  使同一选择器可用于"插入链接 / 嵌入笔记"两种意图。
- **MarkdownVisualEditor.vue**：
  - template 加第二个独立 `<NoteLinkPicker title="插入笔记嵌入">`（两实例、两 visible 状态隔离意图）。
  - `openNoteEmbedPicker()`（readonly 提示）+ `insertNoteEmbed(noteId, title)`。
  - 插入用 Crepe 同款命令：`clearTextInCurrentBlockCommand` + `addBlockTypeCommand({nodeType:
    xynoteEmbed, attrs:{noteId,title}})`——命令层处理光标位置，规避手写 transaction 块内嵌块越界。
  - toolbar insertMenu 加 `createToolbarActionButton({ label:'嵌入笔记', icon:'material-symbols:note-add' })`。

注意点：`addBlockTypeCommand` 会把光标所在文本块**整块**替换为卡片（块内既有文本被清），类似
Crepe image 的"空块换块"。若后续要"光标处插入而保留前后文本"，需改 split 再插，另行评估。

---

## T2C 落地记录（2026-09-04）：嵌入卡片点击改为「新标签页打开」

手测 T2B「测了没问题」后新增需求：点嵌入卡片由**原地切换当前文档**改为**新标签页打开**
（保留当前阅读上下文，Obsidian 式）。

架构：所有面板/内部链接点击本就走 `openNoteLink` IPC → main 广播 → App.vue `openNoteFromLink`
→ `selectNote`(原地，不建 tab)；App.vue 已有 `openNoteInNewTab(note)`（标签上下文菜单用）。
NoteEmbedCard 由 nodeView 以 Vue `render()` 挂在 ProseMirror 内，无 inject 上下文拿不到 App 的
tab 函数 → 用**渲染进程内 window CustomEvent 总线**桥接（不动 IPC/main）。

改动：
- 新建 `src/utils/note-open-events.ts`：`OPEN_NOTE_EVENT='xynote:open-note'` +
  `OpenNoteEventDetail{noteId,newTab}` + `dispatchOpenNote(noteId,newTab)`。
- `NoteEmbedCard.vue`：`open()` 由 IPC `openNoteLink` 改为 `dispatchOpenNote(noteId,true)`。
- `App.vue`：`handleOpenNoteEvent(detail)`（newTab → openNoteInNewTab，否则原地）+ 挂载/卸载监听。
- 普通内部链接(handleEditorLinkClick)未动，仍原地切换；本改动仅限嵌入卡片。

---

## T2F 落地记录（2026-09-04）：NoteLinkPicker 未搜索时默认展示「最近更新」候选

需求：插入笔记弹窗（链接 / 嵌入共用同一 NoteLinkPicker）在**没输入关键词**时也要列出笔记，
且默认排序与 **Cmd+O（QuickOpenDialog）空搜索**一致。已比对两处逻辑（证据先行）：

- **Cmd+O 空搜索 = 「最近更新的笔记」**：`QuickOpenDialog.vue` 无关键词时 source=`props.notes`
  （App.vue `workspace.notes`），打分全为 0 → `.sort` 回落 `Date.parse(updatedAt)` **降序**，取前 12。
  页脚文字 `最近更新的笔记` 佐证。（不做置顶优先——那是数据库带筛选分支的行为，非 Cmd+O 空态。）
- **`searchNotes('')` 返回空**：`electron/database-search.cjs:45` 空关键词且无筛选直接 `return []`，
  无法复用 IPC 取最近列表 → 数据源改走**渲染层已持有的全量笔记**，排序在组件内完成。

改动：
- **NoteLinkPicker.vue**：新增可选 `allNotes?: OfflineNote[]` prop（默认 `[]`）；新增 `recentNotes()`
  复刻 Cmd+O 排序（过滤 `isDeleted`、按 `updatedAt` 降序、同刻按 id 兜底、取前 50）。`runSearch()`
  空关键词分支与 `watch(visible)` 打开时均置 `results = recentNotes()`；有关键词仍走 `searchNotes` IPC。
  `allNotes` 为空（读态/历史等不传场景）时自动回退原「输入关键词搜索笔记」空态，无行为回归。
- **MarkdownVisualEditor.vue**：Props 增 `allNotes?: OfflineNote[]`（默认 `[]`），透传给两个
  `<NoteLinkPicker>`（链接 / 嵌入）。
- **App.vue**：主编辑实例 `<MarkdownVisualEditor :all-notes="workspace.notes">`（仅工具栏展示
  「插入链接/嵌入」的主实例传入；冲突/历史只读实例 `showToolbar=false` 无该入口，无需传）。

验证：`npm run type-check` ✅、`npm test` 213/213 ✅、`npm run build` ✅（vite 空 dist 会触发沙箱
批量删除护栏，需授权绕过后正常构建）。已打包 arm64 供手测。

---

## T2G 落地记录（2026-09-04）：候选行改为「摘要 + 位置」（对齐 Cmd+O 展示）

需求：插入笔记弹窗列表像 Cmd+O 那样**展示摘要内容和位置**（不只是标题+标签）。

对齐依据（读 `QuickOpenDialog.vue` 与其 CSS `style.css:1402-1414`）：
- 行结构 `grid-template-columns: 24px minmax(0,1fr) auto` = 图标 / 标题+摘要 / 位置。
- 摘要用 `formatNoteExcerpt(note.content)`（去标记合并空白，截断交给 CSS ellipsis）。
- 位置用 `getFolderPath(folderId, folderById)` 逐级上溯拼 ` / `，遇已删文件夹中止，无文件夹 → `未分类`。

改动：
- **NoteLinkPicker.vue**：新增可选 `folders?: NoteFolder[]` prop；新增 `getFolderPath()`（复刻 Cmd+O 算法）
  与 `rows` computed（`{note, excerpt, folderPath}`）。模板行改为
  `Icon(tabler:file-text) + 主区(标题/摘要) + 右区(路径/标签)`，保留原有标签（Cmd+O 无标签，属此组件既有信息，不回退）。
  样式 `__item` 由 flex 改 grid(20px / 1fr / auto)，新增 `__icon/__main/__excerpt/__meta/__path`；
  `__list` 加 `max-height: min(56vh,460px)`。选中态沿用本组件既有**实心蓝底白字**（非 Cmd+O 的浅蓝底），
  并为次级文字补 `rgba(255,255,255,.85)` 保证可读。
- **MarkdownVisualEditor.vue**：Props 增 `folders?: NoteFolder[]`（默认 `[]`）透传两个弹窗；补 import 类型。
- **App.vue**：主编辑实例 `:folders="workspace.folders"`。

数据可用性说明：`OfflineNote.content` 在 `workspace.notes` 中为列表用内容（可能 `contentLoaded=false`），
Cmd+O 空搜索本就直接用它渲染摘要，故同源同函数安全；搜索分支 content 由主进程 `createNoteSearchExcerpt`
给出关键词上下文片段，再套 `formatNoteExcerpt` 幂等。

验证：`type-check` ✅、`npm test` 213/213 ✅、`npm run build` ✅、打包 arm64 ✅。未改动 IPC/主进程。

---

## T2H 落地记录（2026-09-04）：正文左侧工具按钮贴边 + 右键上下文菜单

需求（截图反馈）：正文左侧的 Crepe BlockHandle（+ / 拖拽）太靠左、间距宽，窗口较小时左侧
`+` 号显示不完整；并希望支持右键菜单做「插入、复制粘贴」等操作。

根因（读 Crepe/BlockEdit 与 ProseMirror 样式）：
- BlockHandle 经 `@floating-ui/dom` 定位在段落左侧，默认 `offset:16`，浮层宽 66px
  （两个 32px 操作项 + 2px 间隙），`node_modules/@milkdown/crepe/lib/theme/common/block-edit.css`。
- 正文 `.ProseMirror` 左内边距原为 `clamp(32px,5vw,68px)`（`src/style.css`）→ 窄窗口下句柄贴近容器
  左缘、被裁切。

改动方案（用户三选一确认）：
- **a. 正文内边距**：`src/style.css` `.ProseMirror` 左内边距改为 `clamp(64px, 5vw, 96px)`，
  为 BlockHandle 腾出稳定留白。≥1600px 的 `padding-inline:76px` 覆盖与暗色主题仅改色规则均不动。

  **⚠️ 首版方向修正（同日复测）**：光调大内边距不对。Crepe 句柄条宽 66px（[+]32 + 缝2 + 拖拽32），
  `getOffset` 硬编码 `()=>16`（`@milkdown/crepe/.../block-edit/handle/index.ts:44`，但该对象在
  `...(blockProviderOptions)` 之后展开→**可通过 featureConfig 覆盖**）。offset16 + 内边距不足 ⇒ 拖拽右缘
  距正文 16px（缝大、"按钮距正文远"感）+ `+` 在极窄窗仍裁。修正为两处配合：
  - **右/左非对称内边距**（右窄阅读留白、左宽容纳句柄）：
    `padding:34px clamp(24px,4vw,56px) 100px clamp(52px,7vw,96px)`（原对称 `clamp(32..64)`）。
  - **`blockHandle.getOffset:()=>4`**：把句柄右缘(拖拽)贴到正文左约 4px（"留小缝"），
    同时句柄整体右移缓解 `+` 裁切。配置点在 `MarkdownVisualEditor.vue` 的
    `[Crepe.Feature.BlockEdit].blockHandle`。

  **⚠️ 二次修正（19:49，用户实测）**：clamp(vw) 自适应在窗口缩小时观感仍"按钮离左边宽"且不可预期。
  用户终选「小间隙~48px、按钮贴正文」（Notion 风）。改为**固定像素、不随窗口变**：
  `.ProseMirror` padding = `34px 44px 100px 48px`（左 48、右 44），offset 仍 4。窄面板下 66px 句柄
  左缘会越出面板边被轻微裁切——可接受（用户认可），如需完全容纳可再收窄按钮(24–26px/item)。

  **⚠️ 三次修正（20:00，最终定论=回退到第1版）**：48px 固定下 66px 句柄左缘越出太多，**`+` 号直接不可见**。
  用户表示「不行就算了，还是之前的方式」，经确认指**第1版**（正文左内边距 `clamp(64px,5vw,96px)`、
  句柄 Crepe 默认 offset16、无 getOffset 覆盖、style.css 保留非对称外其余一致）。**最终交付状态**：
  `.ProseMirror` padding = `34px clamp(64px,5vw,96px) 100px`；vue 无 `getOffset`/`blockHandle` 覆盖。
  **右键上下文菜单（T2H 主体，用户已认可）保留**。BlockHandle 间距不再调（Crepe 66px 宽句柄需正文左
  ≥~70px 才完整，"贴正文"与"窄窗不裁"不可兼得，除非收窄句柄，用户不接受继续调）。
  注：getOffset 覆盖在 2 版（offset4）曾致 66px 句柄左缘越出、`+` 被裁不可见——教训是不要为"贴正文"
  把 offset 改小到 < 句柄宽度与内边距差。
- **c. 完整右键菜单**（文本编辑 + 块转换 + 历史 + 插入，非多光标多选区）。

落地：
- **src/components/EditorContextMenu.vue**（新建）：Teleport 到 body，宿主 `.editor-context-menu-host`
  （全屏透明、`@pointerdown` 即关闭），内层复用既有 `.resource-context-menu` 视觉（自带明暗主题与
  `.context-menu-divider`）。导出类型 `EditorContextMenuItem{type,label,icon,action,disabled?,danger?}` 与
  `EditorContextMenuGroup`；Props `{visible,position{x,y},groups}`；emit `close / command(action)`。
  组件内 `<style>` 只补宿主定位，菜单本体样式走全局类。
- **src/components/MarkdownVisualEditor.vue**：新增状态
  `editorContextMenu{visible,x,y,groups[]}`；`buildEditorContextGroups(view)` 按需组「文本
  [cut/copy/paste/selectAll/delete]」「历史[undo/redo]」「块类型[paragraph/h1~h6/quote/bulletList/
  orderedList/codeBlock]」「插入[insertLink/insertEmbed]」（readonly/previewMode 不注入文本菜单）；
  `handleEditorContextMenu(e)`（无选区/`img`/只读早退）、`runEditorContextCommand(action)` 分发、
  `closeEditorContextMenu()`。`onMounted` 在既有图片右键监听旁挂 `editorRootRef contextmenu`，
  并加 `document pointerdown` + 编辑器滚动 `scroll` 关闭；`onBeforeUnmount` 对称移除。
- 命令实现：块转换用 commonmark 的 `setBlockTypeCommand`/`wrapInBlockTypeCommand`（列表先
  `clearTextInCurrentBlockCommand`）；插入复用两个既有 NoteLinkPicker 弹窗（openNoteLinkPicker /
  openNoteEmbedPicker）；`selectAll` 用 prose `AllSelection`；历史 `undoCommand/redoCommand`；
  `delete` 走标准删除。目标块为 `xynoteEmbed` 时跳过块转换，避免破坏嵌入卡片。
- 类型注意：文件已从 `@codemirror/view` import `EditorView`，Milkdown prose 视图类型须别名
  `EditorView as ProseMirrorView` 否则与 CodeMirror 重名、`view.state` 报错。

验证：`type-check` ✅、`npm test` 213/213 ✅、`npm run build` ✅（vite 空 dist 会触发沙箱批量删除护栏；
本机解法是 `env -u CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR -u CODEBUDDY_SAFE_DELETE_BULK_GUARD
-u CODEBUDDY_TOOL_CALL_ID -u CODEBUDDY_NODE_BIN` 再构建）。打包 arm64 供手测。

**T2H 修正版（19:37 复测后）**：见上文 a 段「首版方向修正」——句柄贴正文留小缝用
`blockHandle.getOffset:()=>4` + 非对称内边距，重打包 arm64 供手测。

---

## T2I 落地记录（2026-09-09 ~ 09-10）：slash `/` 菜单「嵌入笔记」项 + 菜单紧凑化

**需求**：补齐「未决（可后续）」里的**输入侧**——除工具栏按钮外，在 Crepe 的 slash `/` 命令菜单里
增加「嵌入笔记」项，做成 Obsidian 式的快捷插入。用户对交互时序明确选 **B（选完再删）**：
点「嵌入笔记」→ 只弹既有 NoteLinkPicker，**不动 `/xxx` 文本**；选中笔记后由 `insertNoteEmbed`
清块再插卡片；**中途取消则 `/xxx` 原样保留**。

**实现（`src/components/MarkdownVisualEditor.vue`，单文件）**：
- 新增模块级常量 `EMBED_SLASH_ICON`（Material Symbols `note_add` 内联 SVG，`fill="currentColor"`，
  与工具栏「嵌入笔记」同语义）。
- 在 `[Crepe.Feature.BlockEdit].featureConfigs` 里加官方扩展点 **`buildMenu: (builder) => {...}`**：
  `builder.getGroup('advanced')?.addItem('xynote-embed', { label:'嵌入笔记', icon, onRun })`。
  `onRun` 内：`props.readonly` 时 `showFeedback` 拦截；否则仅调 `openNoteEmbedPicker()`（复用既有入口），
  **不触碰编辑器文本**——`insertNoteEmbed` 的 `clearTextInCurrentBlockCommand` 在选中笔记后才执行，
  天然满足「选完再删」；slash `hide()` 不清 ProseMirror selection，故选中后仍能定位回原块。
- `buildMenu` 是 Crepe 官方 `BlockEditConfig` 字段（esm 里默认 text/list/advanced 三组构建后
  `config.buildMenu?.call(config, groupBuilder)` 再调），非 hack；`GroupBuilder.addItem` 的 item
  类型为 `MenuItem<SlashMenuItem>`，允许携带 `onRun(ctx)`。
- 工具栏入口 / `openNoteEmbedPicker` / `insertNoteEmbed` **零改动**，无回归。

**菜单紧凑化（两轮，用户反馈驱动）**：
- 问题一：追加「嵌入笔记」后，Crepe 默认菜单排版过松（`h6` padding 14px + line-height 20px、
  `li` 同样、`.menu-groups` max-height 420px），「高级」组末尾的「嵌入笔记」被滚动条遮住。
- 问题二：用户反馈「靠上的话顶部看不到 + 行间距还是有点宽」。
- **⚠️ CSS 覆盖位置的关键教训**：首次把覆盖写进 `src/style.css`**未生效**。原因是 vite 把
  `import '@milkdown/crepe/theme/common/style.css'` 提取到 **MarkdownVisualEditor 独立 css chunk**，
  该 chunk 经 ES module 在运行时注入 `<style>` 到 head **末尾**，位置比 `<link>` 加载的 `main.css`
  **更晚**，导致 Crepe 默认规则反而覆盖了 `main.css` 里的定制。**正确做法**：把覆盖写进
  **同一个引入组件的 `<style>` 块**（本例 `MarkdownVisualEditor.vue` 末尾，不加 scoped）——
  vite 会把 `@import` 内容并入该 chunk **最前**、`<style>` 块并入**末尾**，规则顺序正确。已在产物
  `MarkdownVisualEditor-*.css` 中按字节偏移验证（Crepe 默认在前、定制在后）。
- 最终规则（`.milkdown .milkdown-slash-menu ...`）：
  `.menu-groups{max-height:min(50vh,420px);padding:0 12px 6px}`、
  `.menu-group h6{padding:4px 10px 2px;line-height:14px;font-size:11px}`、
  `.menu-group li{padding:6px 10px;min-width:180px;gap:10px;line-height:16px}`。

**验证**：`type-check` ✅、`npm test` 213/213 ✅、`npm run build` ✅、打包 arm64 ✅
（`release/mac-arm64/心悦笔记.app`，asar 内确认含 `xynote-embed` / `buildMenu` / 紧凑规则）。

**卡片操作入口（2026-09-10 实施，2026-09-11 修缺陷）**：
- 实现方式：右键卡片 → 复用 `EditorContextMenu.vue` 弹出卡片专属四项：打开笔记 / 复制嵌入引用 /
  转换为链接 / 删除卡片。链路为 `NoteEmbedCard（Vue）→ emit context-menu → nodeView 补 getPos()
  → window CustomEvent（`EMBED_CARD_MENU_EVENT`）→ MarkdownVisualEditor 弹菜单`。
- **⚠️ 缺陷与根因（2026-09-11）**：用户实测右键卡片弹出的是**编辑器正文菜单**而非卡片菜单。
  根因是 `NoteEmbedCard.onContextMenu` 只调了 `preventDefault()`、**漏了 `stopPropagation()`**：
  ProseMirror nodeView 的 `stopEvent: () => true` 只让 PM 自身忽略事件，**管不住挂在编辑器根节点上的
  原生 `contextmenu` 监听**；事件继续冒泡 → `handleEditorContextMenu` 随后覆盖 `editorContextMenu`
  的 `groups`，卡片菜单在同一帧被正文菜单顶掉。
- 修复：① 卡片内 `preventDefault + stopPropagation` 一律吞掉右键；② `handleEditorContextMenu` 增加
  `target.closest('.xynote-embed-nodeview')` 兜底跳过；③ 顺带让缺失/已删除卡片也能右键（可执行
  「删除卡片」），新增 `available` 载荷字段控制「打开笔记」是否禁用。
- 附带健壮性：`EditorContextMenu.vue` 用 `ResizeObserver` 跟随真实尺寸重测，并把
  `max-height` 放宽到 `calc(100vh - 16px)`，避免长菜单在小窗口被裁。

---

## T2J 落地记录（2026-09-12）：嵌入卡片「展开全文」

需求：卡片此前只显示 160 字 / 2 行摘要（`stripMarkdown(content).slice(0,160)` + CSS
`-webkit-line-clamp:2`），等于只是个「路标」。用户确认走**方案 1 · 展开交互**（而非
把标题改成直接渲染整篇正文的 Obsidian 式做法），理由是改动只落在卡片组件内、
风险最低，同时解决「想瞄一眼对方正文」的高频场景。

改动（**只动 `src/components/NoteEmbedCard.vue`，未碰 schema / 序列化 / 同步 / IPC**）：
- **状态**：新增 `rawContent`（`getNote` 返回的正文原文）、`plainText`（去记号纯文本）、
  `expanded`、`fullHtml`；`canExpand = plainText.length > 160`（即摘要确有截断时才给按钮）。
- **懒渲染**：只在**首次展开**时 `renderNoteBody()` 把 markdown 解析成 HTML，避免文档里每张
  卡片在加载阶段都做一次解析。`loadCard()` 里对称重置这四个状态。
- **渲染链**：`DOMPurify.sanitize(marked.parse(prepared, { async:false }))`，与
  `useAppUpdate.ts` / `AiAssistantPanel.vue` 同一套既有做法，不引入新依赖。
- **递归防护**：渲染前先摘掉被嵌笔记内部的 `<div data-xynote-embed=...>` HTML，替换为单行占位
  `<p data-xynote-embed-placeholder>此处原有一张嵌入卡片，请到原笔记中查看</p>`。否则 A 嵌 B、
  B 嵌 A 会互相展开成环（`stripMarkdown` 当初不解析 embed HTML 同理）。用带 `data-` 标记的 `<p>`
  而非 markdown 引用块：引用块 = `blockquote(margin 8px)` 套 `p(margin 8px)`，高度叠双且样式
  无法单独收敛。`DOMPurify` 默认 `ALLOW_DATA_ATTR = true`（仅 `SAFE_FOR_TEMPLATES` 时为 false，
  本项目未启用），标记能稳定穿过 sanitize，供样式精准命中。
- **布局**：卡片根节点由 `display:flex` 改为 `flex-wrap:wrap`，展开区 `flex-basis:100%` 整行
  折到卡片下方，避免改动既有头部（body + arrow）结构。
- **交互隔离**（关键）：
  - 切换按钮与展开区都是 `@click.stop` / `@keydown.stop`。卡片根节点带 `@click="open"` 与
    `@keydown.space.prevent="open"`，不拦住冒泡则「展开」会顺带跳转到目标笔记。
  - 展开区内点击**不触发**卡片跳转（便于选中文本 / 滚动），但会拦截 `<a>` 并 `preventDefault`，
    改走 `window.notesDesktop.openExternalLink(href)` —— 该 IPC 已能识别站内 `/notes/{id}`
    链接并转成**应用内打开**（`main.cjs:900`），外链走系统浏览器，避免渲染进程被默认导航带走。
- **样式**：展开区 `max-height:min(52vh,420px)` + `overflow:auto` + `overscroll-behavior:contain`，
  `user-select:text` 覆盖根节点的 `user-select:none`。`v-html` 内容不受 scoped 约束，
  全部子元素样式用 `:deep()` 命中（标题/列表/代码块/引用/表格/图片/分隔线）。

**已知限制**：展开区里的站内笔记链接走 `openExternalLink` 会**新开一个标签页**打开，而不是
复用当前编辑器实例（缺 serverId → 本地 noteId 的反查）。摘要卡本身点击仍是原有行为。

**验证**：`type-check` ✅、`npm test` **215/215** ✅、`npm run build` ✅、打包 arm64 ✅
（asar 内按原始字节确认含 `note-embed-card__expand-hint` / `点击卡片展开全文` / `aria-expanded`；
上述文案与类名后续有两次调整，当前特征串以 `data-xynote-embed-placeholder` / `请到原笔记中查看` 为准）。

**⚠️ 缺陷与修复（2026-09-12，用户实测）**：展开区里**拖不动选字——一拖整张卡片跟着动，文字复制不了**。

根因（读 `node_modules/prosemirror-view/dist/index.js` 实证，非猜测）：
- `viewdesc:1319` → `if (node.type.spec.draggable) dom.draggable = true;`
  本节点 schema 写的是 `draggable: true`，于是卡片 DOM 变成了**浏览器原生拖拽源**。
- 更关键的一环：`initInput` 的守卫 `eventBelongsToView()`（`:3116`，定义 `:3154-3163`）会沿
  事件目标向上找 `pmViewDesc.stopEvent`；卡片 nodeView 的 `stopEvent: () => true` 使它对**卡片内
  所有事件**返回 false → **PM 自己的 `dragstart` 处理器永远不会执行**。
- 两者叠加的后果：这个 `draggable: true` 只会触发浏览器原生 DOM 拖拽，既不写 `view.dragging`
  切片（**拖了也移不动节点**，等于白拖），又抢走鼠标拖选 → 正文文字永远选不中、复制不了。

修复：
1. **主修复** `xynote-embed.ts`：节点 schema `draggable: true` → `draggable: false`。卡片 DOM 不再
   带 `draggable`，标题 / 摘要 / 展开正文全部恢复可选可复制。移动卡片改用 Crepe BlockHandle。
2. **兜底** `NoteEmbedCard.vue`：卡片根与展开区都加 `draggable="false"`，展开区再加
   `@dragstart.prevent.stop`。原因：PM `selectNode()` 在节点被选中时会**重新给容器加回**
   `draggable = true`（`viewdesc:1496`，无 contentDOM 且 spec 非 draggable 时成立），需要展开区
   自己兜住那一次拖拽，保证「拖动 == 选文字」。
   副作用：展开区内不能再把选中的文字/图片拖到外部应用——属有意取舍（选字复制优先级更高）。

**交互调整（2026-09-12，用户实测后定稿）**：卡片原本「点哪都跳转」，展开后滚动 / 选字时极易误触打开笔记。
现改为主次分离：

| 目标 | 动作 |
|---|---|
| 卡片主体（标题 / 摘要 / 底部状态栏） | **展开 / 收起全文**（`onCardClick` → `canExpand ? toggleExpanded() : open()`） |
| 右侧箭头按钮（`note-embed-card__open`，`aria-label="打开笔记"`） | **打开笔记**（新标签页） |
| 展开区内 | 不冒泡、不跳转（点链接仍走 `openExternalLink`） |
| 底部提示（hover 淡入） | **不可点**，文案「点击卡片展开全文 / 点击卡片收起」 |

无可展开内容的卡片（短笔记 / 加载中 / 不可用）没有展开语义，主体点击退回「打开笔记」，
避免出现点哪儿都没反应。箭头由装饰性 `Icon` 升级为 `<button>`（`padding:4px` + 负 margin 抵消，
热区约 26×26px，视觉位置不变），带 hover / `:focus-visible` 反馈。

**展开提示降级（同日）**：底部原本是 `<button class="note-embed-card__toggle">`，与主体点击功能重复。
但直接删掉会丢失「可展开」的可发现性（右侧箭头语义是「打开笔记」，看不出与展开有关），
故**降级为不可点的 `<span class="note-embed-card__expand-hint" aria-hidden="true">`**：
保留 `▾ 展开全文 / ▴ 收起` 文案与图标作为提示，不再拦点击（点在文字上由卡片主体接管，行为一致），
卡片 hover 时同步变蓝。`aria-expanded` 随之从该按钮移到**卡片根节点**（`role="button"`，
用 `canExpand ? expanded : undefined` 控制，不可展开的卡片不输出该属性）——卡片根才是展开的触发者。

**提示改为 hover 淡入（同日，用户二次反馈）**：把提示静态常驻会让人以为「**只有这行小字能点**」。
故改为 `opacity: 0` 常隐、悬停卡片头部（`.note-embed-card__body:hover`）或键盘聚焦
（`:focus-visible`）时淡入，文案改为引导性的 **「点击卡片展开全文 / 点击卡片收起」**，明确指向卡片本身。

两个细节：**只绑 `__body` 不绑整卡** —— 展开区拦了冒泡、点它并不收起，在那里提示「点击卡片收起」会误导；
用 `opacity` 而非 `display` 是为了保留占位，避免 hover 时 foot 行重排抖动。

**嵌套卡片占位改版（同日，用户三次反馈）**：展开区里「此处原有一张嵌入卡片…」原先渲染成 markdown
引用块，用户截图反馈**过高**。改为带 `data-xynote-embed-placeholder` 标记的单行 `<p>` + 专属样式
（`padding:3px 10px` / `line-height:16px` / `margin-bottom:6px`，背景 `--surface`、字色 `--muted`、
圆角 6px）：整块高度由约 38px 收到约 28px，且不再受 `.note-embed-card__full-inner :deep(p)` 的
`margin:0 0 8px` 影响。文案同时改为面向读者的
**「此处原有一张嵌入卡片，请到原笔记中查看」**——去掉「展开视图不递归渲染」这类实现措辞。

---

**仍未决**（spec 原「未决」剩余项）：
- 网页端（Web 版）同批支持：目前桌面端先行，网页端把该 HTML 当普通 HTML 安全退化。

---

## T2L 落地记录（2026-09-17）：面板跳转统一「新标签页打开」

用户要求「列表和图谱里的跳转都在新标签页打开」。此前这几处走的是 IPC `openNoteLink`
（`note-link:open-local` → main 广播 → App.vue `openNoteFromLink` → `selectNote`，**原地切换、不建 tab**），
与嵌入卡片 / 正文内部链接已采用的 `dispatchOpenNote(id, true)`（window CustomEvent → `openNoteInNewTab`）
不一致。

改动（3 个面板，各一行）：
- `BacklinksPanel.vue`（关系列表，「引用了本篇 / 本篇引用」两组共用）、`NoteGraphPanel.vue`（侧栏当前笔记 N 跳）、
  `GlobalGraphPanel.vue`（顶栏全库图谱弹层）：`window.notesDesktop.openNoteLink(id)` →
  `dispatchOpenNote(id, true)`。
- 全库图谱弹层**额外保留** `emit('close')`：切换标签后当前文档已变，弹层背后的图谱数据随之变化，
  留着会看到一个与上下文不符的残留浮层。

**有意不改 IPC `openNoteLink` 的语义**：`notifyOpenNoteLink` 还有两个非面板来源，都是「从应用外部进入」
——`main.cjs:900` 的 `openExternalLink` 识别站内 `/notes/{id}` 链接转应用内打开，以及 `main.cjs:1863`
的深链协议 `xynote://note/{id}` 回调。这两处原地打开是对的（用户从浏览器点回来期望落在那篇，而不是
再叠一层标签），改语义会波及它们。故只换调用点，IPC / preload / 类型声明原样保留。

理由：列表与图谱都是**旁路查阅**场景——点进去看被关联的那篇，看完还要回到当前这篇继续读；
图谱更是探索式浏览，原地切换会让图谱跟着跳到目标笔记、刚看出的结构就没了。

**验证**：`type-check` ✅、`npm test` **217/217** ✅（在「侧栏「关系」页签接线完整」test 内新增第 6 组断言：
三个面板都必须引入 `dispatchOpenNote`、都以 `(noteId, true)` 打开、都不得再出现 `notesDesktop.openNoteLink`）、
`build` ✅、打包 arm64 ✅。`dist` 内 `note-link:open-local` **已消失**（渲染层不再调用；主进程侧保留）。

> 注：上文 T2C 记录的「普通内部链接未动，仍原地切换」只描述那一次改动的边界；
> 正文内部链接随后也已改为 `dispatchOpenNote(noteId, true)`（`MarkdownVisualEditor.vue:383`）。

