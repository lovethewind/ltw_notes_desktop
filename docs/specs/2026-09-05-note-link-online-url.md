# 笔记链接采用线上真实地址（插入/复制）+ 本地回落识别

> 状态：已按用户确认方案实施（2026-09-05），待手测
> 日期：2026-09-05
> 关联：`docs/specs/2026-09-03-note-embed-card.md`（"网页端同批支持"列为未决项，本方案补上）

## 背景与问题

用户记忆："以前桌面版同步后，笔记链接会变成真实线上地址，网页版可点击跳转。现在不行了。"

代码查证结论（桌面端）：
- **复制链路**（笔记右键「复制链接」→ `copyNoteLink`，`src/App.vue:2656`）：生成 `https://{webUrl}/notes/{serverId}` **真实线上地址**，功能完好。
- **插入链路**（编辑器搜索插入 → `insertNoteLink` / `insertNoteLinkFromPos`，`src/components/MarkdownVisualEditor.vue:1036/1274`）：写死生成 `https://xinyue-note.local/{本地uuid}` **假域名**。同步时原样上传（`performSync`），网页端拿到假域名 + 本地 uuid → 无法解析 → 点不了。
- 双链功能（`171724f`）之前，编辑器没有"搜索插入"入口，用户当时主要靠复制链路，产物本就是真实线上地址 → 网页可点。双链重构新增的快捷插入入口用了假域名，这是"现在不行了"的根因。
- 网页端 `ltw_front_v3`：`handleEditorLinkClick` 只认**同源 + `/notes/{id}`** 才交路由跳转，其余当外链。→ 若桌面端落库就是 `https://webUrl/notes/{serverId}`，网页端**零改动**即可点。

## 目标

让"插入笔记链接"与"复制链接"产出**一致的真实线上地址** `https://{webUrl}/notes/{serverId}` 落库，从而：
- 同步到网页端 → 网页版天然可点（同源 `/notes/{id}` 命中）。
- 本地跳转/反向链接/图谱 → 仍能识别并回落本地笔记。

## 现状：本地识别能力已具备大半

| 识别环节 | 现状 | 是否需改 |
|---|---|---|
| 反向链接 / 图谱（主进程 `database.cjs resolveNoteLinkTargetIds`） | 正则 `/\/(?:notes|articles)\/(\d+)/g` 直接扫正文，`server_id` 回落本地（`electron/database.cjs:1018-1022`），**与 host 无关** | ✅ 已支持，无需改（前提：serverId 为数字） |
| 点击拦截（`MarkdownVisualEditor.vue:282`） | 仅 `hostname === 'xinyue-note.local'`，pathname 当 uuid | ⚠️ 需扩展识别 `{webUrl host}/notes/{serverId}` |
| App.vue 打开笔记 | `openNoteInNewTab` / `openNoteFromLink` 已按 `id === noteId || serverId === noteId` 匹配 | ✅ 已支持 |

## 方案

### 1. href 生成：插入也用线上真实地址

改 `MarkdownVisualEditor.vue` 的 `insertNoteLink` / `insertNoteLinkFromPos`，把写死假域名改为：

```ts
function buildNoteHref(noteId: string, serverId: string | null): string {
  // 有云端 serverId 且已配置 webUrl → 真实线上地址；否则本地兜底
  if (serverId && webBaseUrl) {
    return `${webBaseUrl.replace(/\/+$/, '')}/notes/${encodeURIComponent(serverId)}`
  }
  return `https://xinyue-note.local/${encodeURIComponent(noteId)}`
}
```

- `serverId` 来源：选择器 `NoteLinkPicker` / `LinkSuggestPopover` 的 `select` 事件目前只传 `(noteId, title)`，目标笔记对象本身含 `serverId` —— 需把 `serverId` 一并传出（两处 `emit('select', ...)`：`NoteLinkPicker.vue:178`、`LinkSuggestPopover.vue:135`）。
- `webBaseUrl` 来源：`MarkdownVisualEditor` 新增 prop `webBaseUrl?: string`（由 `App.vue` 把 `syncSettings.webUrl` 传入）。未同步/未配置时为空 → 自动退回假域名（云端本无此笔记，网页端也点不了，属合理兜底）。

### 2. 点击拦截：识别线上地址并回落本地

`MarkdownVisualEditor.vue:282` 增加一个分支：当 `hostname === new URL(webBaseUrl).hostname` 且 `pathname` 匹配 `/^\/notes\/(\d+)\/?$/` 时，同样 `preventDefault`，取出 serverId，`dispatchOpenNote(serverId, true)`（App.vue 侧按 serverId 回落本地）。

保留原 `xinyue-note.local` 分支（兼容存量与未同步兜底链接）。

### 3. 兼容与边界

- **存量数据**：本地已有大量 `xinyue-note.local/{uuid}` 链接。**不清扫、不迁移**——本地识别分支全保留，旧链接继续可点；仅新插入/复制走新格式。
- **未同步笔记**（无 serverId）：退回假域名，功能与现状一致。
- **serverId 格式**：回落正则要求数字。当前网页端笔记 ApiId 为数字（`/notes/{数字}`），若未来非数字需同步调整 `database.cjs:1018` 与前端识别正则。
- **反向链接是否计入 web 格式**：主进程扫描已含 `/notes/`，反向/图谱自动统计新格式链接；仅需对已切换后的正文重新触发一次链接刷新（随保存/同步自然发生）。

### 4. 不改动

- 后端、网页端（`ltw_front_v3`）：零改动，天然可点。
- 同步引擎：仍原样上传，无需改写。
- embed 卡片（`note:{id}`）不在本方案范围（那是另一种表达，网页端退化 HTML，另行评估）。

## 验收标准

1. 编辑器里搜索插入笔记链接，生成的 markdown href 为 `https://{webUrl}/notes/{serverId}`（配置同步时）；未同步笔记仍为 `https://xinyue-note.local/{uuid}`。
2. 本地点击该链接 → 新标签打开对应本地笔记（回落成功），且不触发浏览器外链。
3. 该笔记的反向链接/关系图谱能统计到（serverId 回落）。
4. 复制链路不变、仍为真实地址。
5. 存量 `xinyue-note.local` 旧链接仍可点。
6. 同步到网页版后，网页端点击跳转正常（需网页版实测验证）。
7. typecheck / `npm test` / build / 打包 arm64 通过。

## 开放问题（已确认，2026-09-05）

1. serverId 为纯数字 ✅（回落正则适用）
2. webUrl 由 App.vue 传 prop `web-base-url` ✅（接受推荐方案）
3. 本轮直接实施 ✅

## 实施记录（2026-09-05）

已改四处（均在桌面端前端，后端/网页端零改动）：
1. `src/components/NoteLinkPicker.vue`：emit `select` 增加 serverId（第2参），`choose` 传 `note.serverId ?? null`。
2. `src/components/LinkSuggestPopover.vue`：同上传 serverId。
3. `src/components/MarkdownVisualEditor.vue`：
   - Props 新增 `webBaseUrl`（默认 ''）。
   - 新增 `buildNoteHref(noteId, serverId)`：有 serverId+webUrl → `{webUrl}/notes/{serverId}`；否则退回 `https://xinyue-note.local/{noteId}`。
   - `insertNoteLink` / `insertNoteLinkFromPos` 改接 (noteId, serverId, title)，href 用 buildNoteHref；`commitLinkSuggest` 补传 serverId。
   - `insertNoteEmbed` 改接 (noteId, _serverId, title) 以对齐 select 载荷（embed 仍用 note:<id>，serverId 不用）。
   - `handleEditorLinkClick` 新增 web 分支：`hostname === {webUrl host}` 且 pathname `/^\/notes\/(\d+)\/?$/` → 取 serverId `dispatchOpenNote(serverId, true)` 回落本地；保留 xinyue-note.local / xinyue-asset.local 分支。
4. `src/App.vue`：主编辑器 `<MarkdownVisualEditor>` 加 `:web-base-url="syncSettings.webUrl"`。

链路：插入落库真实地址 → 本地点击经 web 分支回落 serverId 打开（handleOpenNoteEvent 已按 serverId 匹配）；反向链接/图谱 database.cjs resolveNoteLinkTargetIds 已支持 `/notes/{数字}` 回落，零改动；同步原样上传后网页端同源 `/notes/{id}` 天然可点。

验证：vue-tsc ✅、npm test 213/213 ✅、build/打包待跑。手测要点见上方「验收标准」。
