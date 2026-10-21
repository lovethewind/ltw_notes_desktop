# 选区问 AI（选中气泡 → 面板 chip → S1 资料）

> 2026-10-21。前置：`2026-10-21-ai-assistant-conversation.md`（多轮 / 流式 / 停止 / 重新生成）、
> `2026-10-21-ai-conversation-history.md`（历史对话）。

## 问题

选中气泡里只有格式化动作（B / I / S / 代码 / 公式 / 链接 / 字号），
想「就这一段」问 AI 只能：① 整篇问（模型不知道你指的是哪段）；② 复制粘贴进输入框（丢上下文）。

## 目标

选中正文 → 气泡多一项「问 AI」→ 面板带上「选中片段」chip → 提问时这段作为**最高优先级资料**发给模型。

**只做「问」，不做「写回正文」** —— 改写正文要走编辑器事务（选区映射、历史栈、撤销粒度），
是另一件事，风险量级不同。

## 交互

```
编辑器选中一段  → 气泡末尾（功能组）多一个 ✦ 按钮
点 ✦            → 面板从右侧滑出，输入框上方出现 chip：
                   [❞ 选中片段 · 30 字  线程池适合 IO 密集任务，核心线程数按 CPU …  ×]
输入问题发送     → 这段编成 [S1] 送模型；召回结果排在它后面（[S2]…）
点 chip 的 ×     → 移除片段，后续提问回到按范围召回
「＋」新对话 / 打开历史 → 自动清掉 chip（那是另一条上下文）
顶栏 ✦ 打开面板  → 同样清掉 chip（全新提问）
```

- chip 只露前 48 个字符，完整内容仍在请求里。
- 面板已配置模型时，从气泡进来**不会**弹设置覆盖层。

## 数据流

```
MarkdownVisualEditor：buildToolbar 的 function 组加 xynote-ask-ai
  → onRun 读 PM 的 state.selection（不是 window.getSelection）
  → emit('ask-ai', text)
App.vue：aiSelectionText ← text → flushSave() → 打开面板
AiAssistantPanel：prop selectionText → chip + 请求参数 selection
electron/ai-assistant.cjs：selection 编成 { id: noteId, title: '选中片段', isSelection: true }
  并 prepend 到候选笔记最前 → buildContext 给 S1
```

### 为什么选区要读 ProseMirror 而不是 `window.getSelection()`

气泡是挂在 `body` 上的 portal，按钮被按下那一瞬间浏览器原生选区可能已经抖动/塌陷，
而 PM 的 `state.selection` 仍稳稳锚在原文上。

### 预算

| 资料 | 上限 |
|---|---|
| 选区（`isSelection`） | **8000 字**，超出标 `truncated`（界面会提示「只把前面一段送给了模型」） |
| 当前笔记 | 16000 字 |
| 其它召回笔记 | 4000 字 / 篇 |
| 总预算 | 24000 字 |

选区有独立档位，不跟 folder / all 的 4000 字一起被截 —— 用户亲手框出来的那段优先级最高。

## 不做

- 不回写正文（改写、润色、替换都算写回）。
- 不把选区固定成「常驻上下文」：chip 灭掉即回到整篇召回。
- 不做多段选区合并（一次只带当前这一处选区）。

## 验收

1. 选中一段 → 气泡出现 ✦ → 点击后面板打开，chip 显示字数与开头摘要。
2. 请求体里资料**以 `[S1] 选中片段` 开头**，召回笔记排在后面（`[S2]`…），选区原文完整。
3. 超过 8000 字的选区只送前 8000 字，来源标 `truncated`。
4. chip 的 × 能移除；`＋` 与打开历史会清掉 chip。
5. `[S1]` chip 可点，跳回这篇笔记（`noteId` 沿用当前笔记）。
6. 长按/拖选、键盘方向键选区都能触发（e2e 用方向键，因为 Meta+A 是 AllSelection，气泡不显示）。
