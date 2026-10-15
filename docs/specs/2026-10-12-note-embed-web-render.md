# 跨端：网页端渲染笔记嵌入卡片

> 状态：已拍板（2026-10-12）。涉及两个仓库：`ltw_notes_desktop`（契约方）与 `ltw_front_v3`（渲染方）。
> 2026-10-13 补：`title` 往返丢失的既有缺口已修复（见「已知边界」）。

## 问题

嵌入卡片写进正文的标识是**桌面端本机 uuid**：

```html
<div data-xynote-embed="note:<localId>" title="标题"></div>
```

而网页端只认**服务端数字主键**：`/notes/:noteId` 路由参数、`noteApi.getDetail(noteId)`、
`INote` 结构里都没有 uuid 字段，也没有任何按 uuid 查询的接口。

于是同步到网页端后只剩两种表现（见 `docs/releases/0.9.0.md`「已知限制」第 1 条）：

- 编辑态：被 `@milkdown/preset-commonmark` 的 `htmlSchema` 收成内联 html 节点，
  以 `<span data-type="html">` 显示**原始源码文本**；
- 阅读态：仓库里没有独立阅读页，笔记正文只走 Crepe 编辑器，所以看到的是同一个源码文本。

**结论：这不是渲染问题，是数据契约问题。** 光在网页端加渲染器取不到数据。

## 目标

1. 网页端能显示嵌入卡片的真实内容（标题 + 摘要），并可跳到目标笔记。
2. 桌面端行为**零回归**：仍以本地 ID 为解析键，卡片照旧可展开、右键操作照旧。
3. 存量正文（已同步出去的老卡片）也能补上跨端标识。

## 非目标

- 不改同步引擎（**同步依旧不改写正文**，沿用 `2026-09-05-note-link-online-url.md` 的保守基调）。
- 不改后端（本机没有后端仓库；「按 clientId 查询」这条路需要后端配合，本轮不走）。
- 不做网页端的嵌入卡片编辑（网页端卡片只读展示）。

## 数据契约（双属性，2026-10-14 收敛）

```html
<div data-xynote-embed="note:<localId>" data-xynote-embed-server="<serverId>" title="标题"></div>
```

| 属性 | 谁的标识 | 说明 |
|---|---|---|
| `data-xynote-embed` | 桌面端**本机 uuid** | 值形如 `note:<本机 uuid>`；**只有桌面端插入时写** |
| `data-xynote-embed-server` | **跨端**服务端主键 | 目标笔记的云端 `serverId`；**没有值则不输出该属性** |

规则（10-14 收敛后）：

- **任一属性存在即算一张嵌入卡** —— 两端同一口径（桌面端 `src/editor/xynote-embed.ts` 的
  `isEmbedHtml`、网页端 `components/editor/embed-markup.ts` 的 `isEmbedHtml`）。
  只认 `data-xynote-embed` 会让「网页端插入的卡片」在桌面端退化成源码文本。
- **各端只写自己知道的标识**：桌面端插入写本机 uuid（目标已同步时再补 `data-xynote-embed-server`）；
  网页端没有本机 uuid，插入时**只写 `data-xynote-embed-server`**、`noteId` 留空。
- 属性按需输出：**没有值时不写空属性**（不再写出 `note:` 空值），避免给存量正文制造无意义的字面差异。
- **取数一律回落 `server_id`**：桌面端 `repository.getNote` 先按本机 `id` 查、未命中再按 `server_id` 查；
  两处预览态 `resolveEmbedMeta` 按 `id` 或 `serverId` 匹配。这正是
  「网页里插入的笔记，在桌面端显示不存在」的正解。
- 桌面端**不做自动回填**：加载文档时不改写节点 attrs（否则「打开笔记即变脏、触发同步」）。
  网页端插入的卡片在桌面端保持「只有跨端标识」的形态 —— 语义正确、往返幂等。
- ⚠️ `note_links` 解析新增「`data-xynote-embed-server`」来源后，`note_links_version` 已由 `2` 升到 `3`
  （旧库启动时整表重建一次，否则网页端建立的嵌入关系会整条漏掉）。

## 改动清单

### 桌面端 `ltw_notes_desktop`

1. `src/editor/xynote-embed.ts`
   - 节点 attrs 增 `serverId`（默认 `null`）。
   - `parseDOM`：读 `data-xynote-embed-server`。
   - remark transformer：把 html 转成 embed mdast 节点时，一并取 `serverId`。
   - `parseMarkdown` runner：把 `serverId` 落进 attrs。
   - `toDOM` / `toMarkdown`：有值时输出该属性（`toMarkdown` 是契约的产出点）。
   - （10-13 补）新增 `parseEmbedTitle`，transformer 两处分支各补取 `title` ——
     否则编辑一次正文保存就会把 `title="..."` 整条抹掉。
2. `src/components/MarkdownVisualEditor.vue`
   - `insertNoteEmbed(noteId, _serverId, title)`：把**被丢弃的 `serverId` 用起来**
     （选择器本来就把它传进来了）。
   - 卡片右键「复制嵌入引用」(`embedCopyRef`) 同步带上该属性：`embedContextTarget` 需携带 `serverId`。
3. `electron/local-note-links.cjs`
   - 新增纯函数 `fillEmbedServerIdsInContent(content, options)`：
     给正文里**没有** `data-xynote-embed-server` 的嵌入卡补上该属性。
     - 跳过围栏代码块（复用 `splitFencedCodeSegments`）；
     - **不覆盖已有属性**（幂等）；
     - **不改** `data-xynote-embed` 的值；
     - 目标查不到 / 未同步 → 原样保留并计入 `missing` / `unsynced`；
     - 无改动时返回的 `content` 与入参**逐字节一致**。
   - 与既有的 `rewriteLocalNoteLinksInContent` **并列独立**：那条函数明确不碰嵌入卡，不要合并。
4. 执行入口：走数据管理面板的既有「先预览后确认」流（沿用 `updateNote` 逐篇落库，
   **不能直接 `UPDATE notes`** —— 只有 `updateNote` 会刷关系表、置 `dirty` 并入同步队列）。
   - 现状（已落地）：数据面板「工具」组新增「嵌入卡片补线上标识」按钮 →
     `previewEmbedServerIdFill` → 确认区 → `fillEmbedServerIds`。
     与「本机地址转为线上地址」**并列独立**（两条通道各自一个按钮 + 各自一块确认区），
     共用 `link-rewrite-confirm` 的样式，不新造视觉。
   - 仓库层：`collectEmbedServerIdFill`（共用扫描）/ `previewEmbedServerIdFill` /
     `fillEmbedServerIds`。
   - 无需网页地址配置：嵌入卡补的是服务端主键，与 `webBaseUrl` 无关
     （这点与链接改写不同，所以没有 `noWebBase` 这一档）。

### 网页端 `ltw_front_v3`

5. 新增 `src/components/editor/xynote-embed.ts`：移植桌面端扩展（同属 milkdown/crepe，
   依赖已在 `package.json`）。差异点：
   - 只解析 `data-xynote-embed-server`，取不到就渲染占位；
   - 卡片只读，不提供编辑/右键菜单。
6. 新增只读卡片组件（标题 + 摘要 + 「打开笔记」）：取数走 `noteApi.getDetail(serverId)`，
   跳转走 `/notes/<serverId>`（与仓库既有路由一致）。
7. `src/components/editor/MdEditor.vue` 的 `createEditor()` 注册该 feature（含样式）。
8. 遵守该仓库 `AGENTS.md` 的 GitNexus 规则：改符号前跑 `impact`，提交前跑 `detect_changes`。

### 2026-10-14 收敛：任一属性成卡 + serverId 取数回落

桌面端 `ltw_notes_desktop`：

9. `electron/database.cjs`
   - `getNote(noteId)`：按 `id` 未命中时**再按 `server_id` 查一次**；空键直接返回 `null`。
     一处改动即让所有取数入口（编辑态卡片、两处预览、右键「转换为链接」、纯净导出）同时受益。
   - `resolveNoteLinkTargetIds`：嵌入卡解析新增 `data-xynote-embed-server` 来源；
     `note_links_version` 2 → 3（旧库整表重建一次）。
10. `src/editor/xynote-embed.ts`
    - 新增 `isEmbedHtml`（两属性任一即算卡）；remark transformer 两处分支与 `parseDOM` 的
      `tag` 一起放宽到「任一属性」。
    - `toDOM` / `toMarkdown`：`noteId` 为空时不输出 `data-xynote-embed`（不写 `note:` 空值）。
    - nodeView 把 `serverId` 传进卡片组件。
11. `src/components/NoteEmbedCard.vue`：新增 `serverId` prop；取数 / 打开键 = `noteId || serverId`。
12. `src/utils/markdown-preview.ts`：占位匹配式放宽；目标键改为「本机 ID 优先、退回跨端标识」。
13. `src/components/MarkdownVisualEditor.vue` / `MarkdownSourceEditor.vue`：
    `resolveEmbedMeta` 按 `id` 或 `serverId` 匹配；卡片右键 `embedOpen` / `embedUnwrap` 用回落键；
    `embedCopyRef` 不写空 `data-xynote-embed`。
14. `electron/data-transfer.cjs`：纯净导出的占位匹配式同步放宽，否则这类卡片降级不掉、原样留在文件里。

网页端 `ltw_front_v3`：

15. `components/editor/embed-markup.ts`：新增 `isEmbedHtml`；`buildEmbedHtml` 在 `noteId` 为空时
    不输出 `data-xynote-embed`。
16. `components/editor/xynote-embed.ts`：remark / `parseDOM` 放宽到「任一属性」；`toDOM` 不写空属性。
17. `components/editor/MdEditor.vue`：插入嵌入卡改为 `attrs: { noteId: '', title, serverId: noteId }`。
18. `utils/note-embed-preview.ts` / `utils/note-markdown-export.ts`：占位匹配式同步放宽。

## 验收标准

- 桌面端：新插入的嵌入卡，若目标已同步，正文里**同时**有 `data-xynote-embed` 与
  `data-xynote-embed-server`；未同步的目标只有前者。
- 桌面端：正文往返（解析 → 序列化）不丢 `serverId`，且老正文（无新属性）行为不变。
- 桌面端：回填函数对已带属性的卡片**幂等**（再跑一次 `changed === 0`）。
- 网页端：带 `serverId` 的卡片渲染成卡片（标题 + 摘要 + 打开）；无 `serverId`、
  或目标已删/取数失败 → 渲染占位提示，**不显示源码文本**。
- 桌面端：`getNote('<雪花主键>')` 能命中本机笔记（回落 `server_id`）⇒ 网页端插入的卡片
  在编辑态渲染成**真卡片**，而不是「此笔记不存在」。
- 两端：只有 `data-xynote-embed-server` 的卡片在**编辑态 / 预览态 / 纯净导出**三处都被识别，
  且桌面端保存后形态不变（不写出 `note:` 空值，往返幂等）。
- 两端类型检查与测试全绿（桌面端 `npm test`；网页端 `vitest` + `npm run type-check` + `build`）。

## 验证计划

- 桌面端单测（`node:test`，真行为断言）：回填纯函数的四类分支（补齐 / 幂等 / 未同步 / 围栏代码块）；
  序列化往返（`toMarkdown` 带属性、无值不写）用源码守卫断言（该文件是 `.ts`，沿用既有正则守卫范式）。
  仓库层另验「补完关系表不漂」与「幂等后 `alreadyFilledEmbeds` 计数」。
- 桌面端 e2e（`tests/e2e/note-embed-server-fill.e2e.test.cjs`，两组用例）：
  1. 回填链路：真渠道 + 真落库（借第二个 sqlite 连接造 `server_id`）；
  2. **编辑态往返**：卡片渲染成卡片（不是源码文本）→ 在别处改字 → 自动保存 →
     两个属性原样写回。这条是单测拦不住的关键回归面。
- 网页端 `vitest`：嵌入属性解析（有 serverId / 无 serverId / 脏值）→ 卡片 props 的纯函数。
- 手测（需登录态与已同步笔记，由用户执行）：
  1. 桌面端新建一篇笔记 B 并同步；2. 在笔记 A 里插入 B 的嵌入并同步；
  3. 网页端打开 A → 应看到卡片并能跳到 B。
- Crepe 内的实际渲染无法在我这边自动验证（需要登录态与后端数据），属已知验证边界。

## 已知边界

- **未同步的目标**在网页端只能是占位卡片（没有可用的跨端标识）。
- **存量卡片**依赖用户主动跑一次回填；不跑就仍是占位。
- ✅ **`title` 往返已修（2026-10-13）**：此前 `embedRemarkTransformer` 只从 html 里取 `noteId`
  （本 spec 又加了 `serverId`），**从未取过 `title`**，而 `toMarkdown` 只在 `title` 有值时才写
  该属性 → 用户编辑一次正文保存，`title="..."` 就被整条抹掉。
  桌面端卡片靠目标笔记实时取标题、界面上看不出问题；受损的是**网页端取数失败时的兜底标题**
  （网页端表现为标题显示「未命名笔记」；且网页端保存是整篇重新序列化，同样会抹掉该属性）。
  修法：两端 transformer 各补 `title` 解析 —— 桌面端 `parseEmbedTitle` + 两处分支；
  网页端 `embed-markup.ts` 的 `parseEmbedTitle` + 两处分支。
  e2e 由「钉住丢失」反转为「必须保留」。本文件头部注释写的「往返无损」自此次修复起才成立。
- 网页端卡片**只读**；在网页端编辑笔记时不应破坏该 HTML（沿用桌面端「原样往返」的收发规则）。
- 网页端此前无任何 `xynote` 相关代码与私有协议替换先例，本 spec 是首例；
  后续若要处理 `xinyue-note.local` 链接，应复用同一套解析入口而非另写一份。
- ⚠️ e2e 全量并行跑时 `link-tooltip` 偶发失败（单跑连绿 3/3、全量两跑一绿一红），
  属并行 Electron 争抢资源的 flaky，与本次改动无关。
