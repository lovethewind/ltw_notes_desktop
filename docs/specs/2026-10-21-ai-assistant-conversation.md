# AI 助手：多轮对话 + 引用可点 + 流式吐字 + 对话式界面

- 日期：2026-10-21
- 前置：`2026-08-22-ai-note-assistant-mvp.md`（召回、上下文预算、设置加密）
- 范围：仅桌面端；不改数据库结构、不改同步链路

## 背景

MVP 的 AI 助手只能「问一次」：每次请求只有 `system + user` 两条消息，面板也只是一张表单
（范围卡片 → 输入框 → 回答卡片 → 设置折叠）。三个具体问题：

| 问题 | 现状 |
|---|---|
| 不能追问 | `electron/ai-assistant.cjs` 的 `messages` 固定为两条，问「那第二条呢」模型不知道上文 |
| `[S1]` 是死文本 | 正文按 Markdown 渲染，`[S1]` 只是字符；只有底部来源列表能点 |
| 漏标来源就报错 | `if (!citedSources.length) throw` → 用户等几十秒只拿到「请重试」 |
| 发出去毫无反馈 | 提问后整屏只有三点转圈，自己说的话都不显示；回答要等全生成完才一次性出现 |

## 设计

### 多轮上下文

- 渲染层维护 `turns`（本地内存，不持久化），追问时把最近 **6 轮** 的 `{ question, answer }`
  随 `askAiAssistant` 一起发给主进程。
- 主进程 `buildHistoryMessages(history)`：先剥掉历史回答里的 `[Sn]`（那是上一轮自己的编号，
  带进来会让模型误引当前资料），再从最近一轮往前收，超过 **6000 字**就丢弃更早的轮次。
- 消息顺序：`system` → 历史 user/assistant 交替 → 当前 `user`（问题 + 本轮检索到的资料）。
- 资料每轮重新注入（按当前问题召回）；追问常是「那第二条呢」这类无主题词的说法，
  检索词会并上**上一轮问题**再走 FTS。

### 引用可点

- 不在 HTML 层做正则替换：先 `marked` + DOMPurify 渲染，再 `TreeWalker` 遍历文本节点，
  把 `[Sn]` 换成 `<a href="#ai-source-Sn">Sn</a>`。
- 跳过 `pre` / `code` / 已在 `a` 内的文本 —— 代码块里的 `[S1]` 是字面量，不能改。
- 只替换 `sources` 里真实存在的编号；模型编出来的 `[S9]` 保持原文。
- 点击由 `handleAnswerClick` 委托接管，转成 `openSource` → 复用 App 既有跳转。

### 漏标来源

- 主进程不再抛错：返回 `{ answer, sources, citationMissing: true }`，
  `sources` 退回本轮检索到的全部笔记。
- 界面在回答下方给一条黄色提示「本条回答没有标注来源，下面是这次检索到的笔记」。

### 消息先上屏 + 流式吐字

两件事必须同时成立：自己发的话**立刻**上屏，回答**边收边写**。

**发送端（渲染层）**

- `ask()` 里先 `turns.value.push(turn)`（`status: 'pending'`）再发请求 —— 气泡不等回答。
- 每轮生成一个 `requestId`（`crypto.randomUUID()`），随请求发给主进程；增量推送靠它回填到对应轮次，
  多轮并发时不会串台。
- 历史只取 `status === 'done'` 的轮次（`pending` / `streaming` / `error` 不进上下文）。

**主进程（`askStream`）**

- 走 `net.fetch` 而不是一次性 `request(...).json()`，只为拿到 `response.body` 这个 `ReadableStream`。
- `stream: true` 只在流式调用里加，`ask()` 的请求体形态不变。
- 解析规则：按 `\n` 切行 → 空行 = 一帧结束 → 把该帧所有 `data:` 行拼起来 `JSON.parse`
  → 取 `choices[0].delta.content` 累加并 `onDelta(delta)`。
- 半帧保护：`buffer` 里留着没有换行结尾的残片，跨 chunk 拼回来再切；`\r\n` 去掉尾 `\r`。
- `[DONE]` 只是终止标记，不当错误；`event:` / `id:` / `retry:` / 注释行忽略。
- 兜底两条：`content-type` 不含 `text/event-stream`（接口不认 `stream`，或代理改成普通 JSON）
  → 读完整个 body 后**只调一次** `onDelta`，返回结构与非流式完全一致；
  HTTP 非 2xx → 先解析出服务端 `error.message` 再抛，不让界面只看到状态码。
- 返回值仍然是 `finalizeAnswer(...)`，所以「引用过滤 / 漏标来源」逻辑两条路径共用。

**IPC**

```js
ipcMain.handle('ai-assistant:ask-stream', (event, input) => {
  const { requestId } = input || {}
  return domain.askStream(input, (delta) => {
    if (!requestId || event.sender.isDestroyed()) return
    event.sender.send('ai-assistant:delta', { requestId, delta })
  })
})
```

preload 暴露 `askAiAssistantStream(input)` 与 `onAiAssistantDelta(callback)`（后者返回取消订阅函数）。

**渲染节流**

每个 chunk 都跑一遍 `marked` + DOMPurify 太重，实测会卡住输入框；改成 **60ms 节流**重渲染，
最后一个 chunk 到达时立刻补一帧。轮次状态机：`pending → streaming → done | error`。

### 界面结构

```
header   图标 + 标题 + 模型名 ··· + 新对话 / 模型设置 / 关闭
transcript（唯一滚动容器）
  空态：图标 + 一句话 + 3 条示例问题（点即问）
  用户气泡（右对齐、蓝底）—— 发送即出现，不等回答
  助手气泡（左对齐、卡片底）：模型名 + 复制 + 正文 + 来源折叠
  等待态：三点跳动 + 阶段文案（检索 → 阅读 → 整理）
  流式中：正文边收边渲染 + 末尾呼吸光标（`.ai-answer-text.is-streaming::after`）
  失败态：本轮的红色错误条，其它轮次不受影响
composer（固定底部）
  范围 chips（当前笔记 / 当前文件夹 / 全部笔记）+ 提示
  圆角输入框（自适应高度，⌘Enter 发送）+ 发送按钮（生成中换成「停止生成」）
  隐私口径：只发送检索命中的有限文本片段
设置：覆盖层铺满 header 以下区域（一次性配置，不占对话流）
```

## 停止生成 / 重新生成 / 长笔记预算（同日追加）

### 停止生成

- 主进程 `createAiAssistant` 里维护 `activeStreams: Map<requestId, AbortController>`；
  `askStream` 用 `input.requestId` 登记，并把 `controller.signal` 一路传给 `net.fetch`。
  `abortStream(requestId)` 摘表 + `abort()`，重复调用只返回 `false`。
- IPC `ai-assistant:abort` → preload `abortAiAssistantStream`。
- 界面 `stopGenerating()` 把该 `requestId` 记进 `stoppedRequests` 再调中止。**必须记**：
  中止后 promise 也会 reject，只有靠这个集合才能把「用户停的」和「真的出错」分开。
- 停下的那一轮：`status = 'done'` + `stopped = true`，保留已长出来的半截，**不落库**，
  也不当上下文（`buildHistory` 过滤 `stopped`）。界面给一行「已停止生成，这一轮不会存进历史」。
- 不因为关面板自动中止：关面板只是隐藏，回答继续跑完仍会落库（维持「重开还在」的既有行为）。

### 重新生成

- 只对**最后一轮**开放（`isLastTurn`）：中间轮次重答会和后面的追问互相矛盾。
- 复用 `runTurn(turn, history)`；提问气泡不新增，轮次对象原地重置（新 `requestId`）。
- 落库走 `replaceAiConversationTurn`（`UPDATE ... WHERE id = ?` + 刷新会话 `updated_at`），
  不在历史里多出一条同样的提问。`ChatTurn.dbTurnId` 由 `persistTurn` 或恢复历史时回填，
  为空（停止的半截、落库失败）才退回 `append`。

### 长笔记预算

- `MAX_SOURCE_CHARACTERS = 4000`（多篇召回）不变；新增 `MAX_SINGLE_NOTE_CHARACTERS = 16000`，
  **只在 `scope === 'current'` 生效**（那时只有一篇，4000 字会让「总结全文」只看开头）。
- 每篇来源带 `truncated`（`cleaned.length > excerpt.length`），随 `sources_json` 落库，
  恢复历史后仍能提示：「『标题』较长，只把前面一段送给了模型，回答可能有遗漏。」

## 验收

1. 同一会话第二次提问的请求体里，`messages` 含上一轮的 user/assistant，且历史回答不带 `[Sn]`。
2. 历史超过 6 轮时只保留最近 6 轮。
3. 回答里的 `[S1]` 渲染成可点 chip，点击切到对应笔记；`pre/code` 里的 `[S1]` 不动。
4. 模型漏标来源时仍展示答案，并出现「没有标注来源」提示。
5. 空态、多轮气泡、输入框、范围切换、设置覆盖层在窄窗口（410px 面板）内不重叠。
6. 点发送后**先**出现自己的气泡（3 秒内），此时助手气泡仍在等待态。
7. 回答是长出来的：中途能抓到 `.ai-answer-text.is-streaming` 且已有正文；结束后该 class 消失。
8. SSE 帧被 chunk 边界切断时，拼回来的正文与整段返回一字不差（单测覆盖）。
9. 接口回普通 JSON（不支持 `stream`）时功能不降级：只回调一次 `onDelta`，结果与非流式一致。
10. 生成中发送按钮变成「停止生成」；点下去半截保留、无错误条、`is-streaming` 消失，历史里没有这条。
11. 同一问题点「重新生成」后正文换成新答案，提问气泡不增多，历史仍是 1 轮。
12. `scope = current` 时一万字笔记整篇进上下文（`truncated = false`）；
    两万字只送 16000 字并标 `truncated = true`，界面出现「只把前面一段送给模型」提示。

## 不改动

- 召回策略的**多篇**预算（FTS + 停用词 + 8 篇 / 4000 字 / 24000 字）不变。
- 不做「边流边重新检索」：资料一次性注入，流式只影响回答的呈现节奏。
- 不在关闭面板时中止请求（见「停止生成」最后一节）。
