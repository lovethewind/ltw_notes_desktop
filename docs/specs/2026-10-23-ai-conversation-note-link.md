# AI 会话关联笔记

- 日期：2026-10-23
- 涉及：`electron/database-schema.cjs`、`electron/database.cjs`、`electron/ipc-handlers.cjs`、
  `electron/main.cjs`、`electron/preload.cjs`、`src/types.ts`、`src/components/AiAssistantPanel.vue`
- 测试：`tests/ai-conversation.test.cjs`（+5）、`tests/ai-assistant.test.cjs`（接线守卫）、
  `tests/e2e/ai-assistant.e2e.test.cjs`（+1）

## 问题

历史对话里只有标题和时间。同一天在几篇不同笔记下问过之后，
「新对话」这类重名标题堆在一起分不清哪条对应哪篇；
反问「上次关于这台的结论在哪」时只能一条条点开试。

会话本身也不知道自己属于哪篇笔记 —— 落库时没记。

## 目标

1. 每条会话记住「在哪篇笔记下开始问的」。
2. 历史列表把归属笔记显示出来，且能点击跳过去。
3. 打开某篇笔记的 AI 面板时，自动接上这篇上次的对话。

## 非目标

- **不做轮次级归属**。一条对话跨笔记追问时，仍记在开始时那篇。
  理由：会话是一段连续上下文的边界，`scope: current` 的召回对象也是开始时的笔记；
  中途切笔记追问属于换了上下文，真要分开应该开新对话。
- **不做「按笔记分组」的列表**。历史列表保持单一时间序（置顶优先），
  只是多一个来源标签。分组会让「最近问的」淹没在分组层级里。
- 不改同步：会话数据本来就不参与同步，新增列同样不上行。

## 数据模型

`ai_conversations` 新增一列：

```sql
note_id TEXT        -- 可空；不设外键
```

两个决定：

- **不设外键**。笔记删了，对话还留在历史里 —— 用户问过的东西不该因为删了一篇笔记
  被偷偷抹掉；列表里显示「笔记已删除」，不可点。
- **标题不存快照**。列表 `LEFT JOIN notes` 现取 `title`，笔记改名后历史里跟着变；
  软删除（`is_deleted = 1`）的笔记按「已删除」处理 —— 跳过去只会打开回收站里的条目。

老库通过 `PRAGMA table_info` + `ALTER TABLE` 补列，已有会话 `note_id` 为 NULL，
列表不显示来源标签，其余功能不变（有真实老库迁移测试覆盖）。

## 写入时机

只在**新建会话**时写 `noteId`（`appendAiConversationTurn` 的 `!existing` 分支）。
已有 `conversationId` 的追问即使传了 `noteId` 也会被忽略 —— 否则一条对话的归属会随
「用户中途切了笔记」漂移，历史里那条标签就成了最后一次追问的笔记，语义错乱。

## 自动续接

触发点两个：

1. `props.visible` false → true（打开面板）。
2. `props.currentNoteId` 变化（笔记 ID 晚于面板就绪，或用户切了笔记）。

第二个是必需的：应用刚启动就点 AI 按钮时，笔记还在加载，`currentNoteId` 为 null，
只看第一个触发点会永远续不上（这条是 e2e 实测踩出来的）。

续接前必须同时满足：

- `conversationId` 为空、`turns` 为空、`loading` 为 false —— 正在进行的对话不打断。
- `props.selectionText` 为空 —— 从选中气泡「问 AI」进来的，用户是拿一段话要问，
  续接会顺手把选段清掉。
- `resumeSkippedNoteId !== 当前笔记` —— 刚点过「开始新对话」的笔记不再自动载回，
  否则关掉面板再打开，看起来「新对话没生效」。
- 查到的会话 `turnCount > 0`。

界面提示：面板顶部一条 26px 高的淡蓝提示条「已载入《XX》的对话 ＋ 开始新对话」，
放在滚动容器**外面**（跟着对话滚走就失去提示意义）。

## 历史列表

- 副行改为 `来源笔记 · 时间 · N 轮`，来源是带文件图标的小标签，点击 `emit openSource`
  跳到那篇笔记（复用回答里 `[S1]` 的同一条链路），跳之前先收起历史层。
- 列表项从 `<button>` 换成 `<div role="button" tabindex="0">`：
  里面要嵌「来源笔记」这个按钮，button 套 button 不合规范。键盘入口由
  `@keydown.enter` / `@keydown.space` 补齐，焦点环自己画。
- 来源标签 `max-width: 96px` + 省略号；`.ai-history-meta` 用 `min-width: 0` 收溢出，
  否则 grid 子项会把整行撑破。

## 接口变化

`listAiConversations` 从「收一个 keyword 字符串」改成「收一个 options 对象」：

```ts
listAiConversations(options?: { keyword?: string, noteId?: string }): Promise<AiConversationSummary[]>
```

`AiConversationSummary` 新增 `noteId: string | null`、`noteTitle: string | null`。
`AiConversationTurnInput` 新增 `noteId?: string | null`。

没有保留字符串兼容分支：静默失效（`'关键词'.keyword` 是 undefined → 变成不过滤）
比编译错误危险得多。改签名后 `tests/ai-conversation.test.cjs` 里那条搜索用例
立刻转红，正好证明这个取舍是对的。

## 验收

- 单测 **552/552**（+5：归属写入与改名跟随、追问不漂移、按 noteId 过滤、
  软删/硬删后标题置空但会话保留、老库迁移补列）。
- AI e2e **10/10**（+1：两篇笔记各问一轮 → 历史各自标出来源 → 点标签跳转 →
  重启后自动续接 → 开始新对话后不再续接 → 换笔记续接那一篇的对话）。
- 实拍：`/tmp/scope-1-resumed.png`（续接横幅）、`scope-2-history.png`（来源标签）、
  `scope-3-hover.png`（悬停动作）。
