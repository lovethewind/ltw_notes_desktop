# 本机笔记地址的跨端收口：网页端不再跳走 + 同步后主动提示

> 状态：待实施（方案已确认：A + B；C 明确不做）
> 日期：2026-10-16
> 关联：`docs/specs/2026-09-05-note-link-online-url.md`（本方案**不改**它的结论，只补两端的行为缺口）
> 关联：`docs/specs/2026-10-12-note-embed-web-render.md`（嵌入卡走的是另一条通道，不在本方案范围）

## 背景与问题

0.9.0 起，桌面端插入笔记链接时会**优先写网页真实地址** `{webUrl}/notes/{serverId}`，目标笔记还没同步到云端时才落本机兜底地址 `https://xinyue-note.local/{本地uuid}`（`buildNoteHref`）。

这条「插入那一刻的快照」留下了两个缺口：

1. **网页端会跳到不存在的域名**。网页端只认同源 `/notes/<id>`（`resolveNoteIdFromHref`），本机地址匹配不上 → 不 `preventDefault` → 落到浏览器默认行为。而预览链路渲染出的 `<a>` **没有 `target`**（`marked` 不加、项目里也没有后处理），所以点击是在**当前标签页**导航到 `xinyue-note.local` → DNS 失败页，**读者那篇笔记就此丢掉**。编辑态同理（按住 ⌘ 点击时）。
2. **链接不会随目标笔记的同步自动升级**。同步引擎原样上传正文（`2026-09-05` spec 的明确决策），只有用户自己翻「数据管理 → 本机地址转为线上地址」才会改写。等于把「什么时候该转」这件事完全交给用户记忆。

## 与 2026-09-05 决策的关系（先说清楚，避免误读）

那份 spec 把两件事写进了「不改动」：

- **存量数据不清扫、不迁移** —— 本方案**继续遵守**：不自动批量改写任何用户正文。
- **同步引擎仍原样上传，无需改写** —— 本方案**继续遵守**：`performSync` 依然不改正文。

因此**不做**「同步时自动改写」（方案 C）：它与上述决策直接冲突，且「改正文 = 产生本地修改」会反复 `dirty` + 入队，有同步环风险。要做得先推翻那份 spec。

本方案只做两件不碰存量数据的事：

- **A**：网页端**识别**这类地址，拦住默认行为并说明原因（纯前端、零数据风险）。
- **B**：桌面端在**发现时机**上主动一步 —— 同步完成后告诉你「现在有 N 条可以转」，点一下仍走既有的「先给清单再确认」流程。

## 方案 A：网页端不再跳走

`ltw_front_v3`（仓库 `~/Data/WebstormProjects/ltw_front_v3`，分支 `master`）。

### A1 识别函数

`src/utils/note-open-events.ts` 新增 `isLocalNoteHref(href)`，与桌面端 `electron/local-note-links.cjs` 的 `LOCAL_NOTE_LINK_PATTERN` **同口径**：

- 新格式 `https://xinyue-note.local/{本地 uuid}`
- 旧格式 `xinyue-notes://note/{本地 uuid}`

> 补充事实：网页端的清洗（DOMPurify 默认 URI 白名单）**不含 `xinyue-notes:` 这类自定义协议**，所以旧格式的 `href` 在网页端本来就会被剥掉、`a[href]` 匹配不到；保留这条分支是防御性写法，真正需要处理的是新格式。

### A2 两处点击兜底

| 位置 | 现状 | 改法 |
|---|---|---|
| `src/components/note/NoteMarkdownPreview.vue` `handlePreviewClick` | 认不出 → 默认导航 | 在 `resolveNoteIdFromHref` **之前**判 `isLocalNoteHref`：命中就 `preventDefault()` + 一次轻提示，不导航 |
| `src/components/editor/MdEditor.vue` `handleEditorLinkClick` | 同上（需 ⌘ 才走到） | 同上，插在 `resolveNoteIdFromHref` 之前 |

提示文案统一为「该链接指向桌面端本机笔记，网页端无法打开」。⚠️ 取原始属性用 `anchor.getAttribute('href')`（`anchor.href` 会被浏览器归一，自定义协议下不可靠）。

### A3 预览态的观感

预览正文是 `v-html` 的死 HTML，**不改 HTML**，改用 CSS 属性选择器让这类链接看起来就不可点（`a[href^='https://xinyue-note.local/']` 等）—— 弱化颜色 + 虚线下划线 + `cursor: default`。

**不做**：编辑态（`MdEditor`）不加观感处理 —— 那里的 `<a>` 是 ProseMirror 的文本标记，弱化它会让作者误以为链接坏了。

## 方案 B：桌面端同步后主动提示

### B1 拿到「本轮新同步上去的笔记」

`applySyncResult` 的入参 `result.mappings = [{ entityType, serverId, clientId, updatedAt }]` 本身就是「本地 clientId → 服务器主键」的映射。

改法：进映射循环前先取一次「已经有 `server_id` 的笔记 id 集合」，循环中把 `notes` 表里**从空变为非空**的 clientId 收集起来，随 `{ conflictCount, newlySyncedNoteIds }` 一起返回。

（用一次集合查询替代「每条映射一个 SELECT」，避免首次全量同步时的 N 次查询。）

### B2 只在值得算的时候才算

新增 `repository.previewLocalNoteLinkHint(webBaseUrl)`：

1. 用 SQL `LIKE` 把候选缩到「正文里还含本机地址的笔记」（`xinyue-note.local` / `xinyue-notes://note/`）—— 绝大多数笔记正文不含这类地址，先把它们挡在门外；
2. 候选为空 → 直接返回 `null`；
3. 否则复用 `collectLocalNoteLinkRewrite`（新增可选 `rows` 参数，默认仍是全库）算可转数量，未配置 `webBaseUrl` 或可转为 0 时同样返回 `null`。

`performSync` 的挂载点：**仅在 `applied.newlySyncedNoteIds` 非空时**调用它，结果挂到 `lastResult.localLinkHint`（`createSyncResultSummary` 之后附加，随同步历史一起持久化）。

### B3 入口

App.vue「同步完成」面板（`.sync-result-summary` 之后）新增一块提示：

> 有链接可以换成线上地址了 · {convertibleNotes} 篇笔记里的 {convertibleLinks} 条本机链接，对应的笔记已经同步到云端，换掉后网页端就能直接打开。 ［去转换］

「去转换」的动作 = 关闭同步窗口 → `openDataTransfer()` → `previewLocalNoteLinkRewrite()`，**直接落到既有的二次确认块**。

⚠️ **入口唯一**：不复制一份确认 UI 到同步面板里。「先给清单再确认」的形态、以及「确认后走 `updateNote` 以刷新关系表」的路径都保持不变。

## 验收标准

1. 网页端**预览态**点击 `xinyue-note.local` 链接：不导航（URL 不变、页面还在），出现一次说明提示。
2. 网页端**编辑态**按住 ⌘ 点击同类链接：同样不导航。
3. 网页端正常链接（同源 `/notes/<id>`、外链）行为**不变**：站内跳转照旧，外链照旧。
4. 桌面端：正常情况下同步（没有新笔记拿到 serverId，或正文里没有本机地址）**不显示**提示，也不额外扫描。
5. 桌面端：一篇笔记首次同步成功、且有别的笔记以本机地址引用它 → 同步完成后出现提示，条数与「数据管理 → 本机地址转为线上地址」的预览一致。
6. 点「去转换」→ 打开数据管理窗口并停在确认块；取消则不改任何数据。
7. 未配置 `webUrl` 时不出现提示（此时本来就转不了）。
8. typecheck / 两端测试 / build 通过。

## 不改动

- 存量正文：不自动清扫、不迁移（遵守 `2026-09-05`）。
- 同步引擎：仍原样上传正文。
- 嵌入卡片：走自己的通道（`fillEmbedServerIdsInContent` / 0.10.0 的「补线上标识」），本方案不碰。
- 桌面端正文里的本机地址识别与点击回落：本来就能用，不动。
