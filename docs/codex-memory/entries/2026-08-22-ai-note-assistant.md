# 2026-08-22：AI 笔记助手 MVP

## 实现

- AI 设置、候选召回、上下文预算和 OpenAI 兼容请求集中在 `electron/ai-assistant.cjs`。
- API Key 经 Electron `safeStorage` 加密后写入独立 `ai-settings.json`，不进入 SQLite、同步或备份。
- 当前笔记、当前文件夹和全部笔记范围复用 SQLite FTS；零召回不发送最近笔记。
- 单次最多 8 篇、每篇 4000 字符、笔记上下文总计不超过 24000 字符，并清理图片、Base64、HTTP(S) 与本地附件地址。
- 回答必须包含有效 `[Sx]`，渲染层只展示实际引用的结构化来源并复用工作区导航定位。
- 右侧面板独立懒加载，并复用全局 `--overlay-*` 尺寸变量。
- Vue `ref` 内的设置对象是响应式 Proxy，跨 Electron IPC 前必须显式提取为可结构化克隆的普通对象；真实 Electron E2E 覆盖保存按钮以锁定该边界。
- AI 回答使用项目既有 `marked + DOMPurify` 路径渲染；真实 Electron E2E 通过本地假模型同时验证 Markdown DOM 与脚本清理，避免只测静态接线。

## 验证

- `tests/ai-assistant.test.cjs` 覆盖安全设置、清洗、零召回、预算、引用和 IPC 接线。
- `tests/e2e/ai-assistant.e2e.test.cjs` 在隔离数据目录后台验证真实 Electron 面板。
- 规格见 `docs/specs/2026-08-22-ai-note-assistant-mvp.md`。
