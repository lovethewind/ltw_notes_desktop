# AI 笔记助手 MVP 实施票据

对应规格：`docs/specs/2026-08-22-ai-note-assistant-mvp.md`

## 任务

- [x] 为 AI 助手纯逻辑和 Electron 集成建立失败测试。
- [x] 实现主进程 AI 助手模块：安全设置、候选召回、上下文预算和 OpenAI 兼容请求。
- [x] 注册 IPC、preload 和 TypeScript 接口。
- [x] 实现独立右侧面板，并在工作区接入来源定位。
- [x] 完成目标测试、完整回归、代码审查和 ARM64 免安装包。
- [x] 将 AI 入口移到应用顶部，并验证无活动笔记时默认使用全部笔记范围。
- [x] 修复 Vue 响应式设置对象无法通过 Electron IPC 保存，并锁定真实界面回归测试。
- [x] 安全渲染 AI 回答 Markdown，并修复提问按钮快捷键键帽显示。

## 依赖与顺序

主进程模块接口先于 IPC；IPC 先于渲染面板。验证和打包依赖全部实现完成。

## 完成条件

规格中的六条验收标准全部有可复查证据，且未提交或推送 Git 变更。

## 验证证据

- `npm test`：通过。
- `npm run test:e2e`：9 项通过，包含有活动笔记和空工作区的 AI 顶部入口场景。
- `npm run desktop:pack:mac`：通过，产物为 `release/mac-arm64/心悦笔记.app`，内部版本 `0.6.0`。
- 双轴代码审查：规格无偏差；本轮改动无未处理的标准硬问题。
- AI 设置克隆错误复现与回归：`npm run test:e2e` 在修复前保存配置场景失败，改为普通 IPC 对象后通过。
- Markdown 与键帽回归：修复前 E2E 同时失败于 `⌘↵` 和缺失 `<strong>`；修复后 10 项 E2E、完整 `npm test` 与 ARM64 打包通过。
