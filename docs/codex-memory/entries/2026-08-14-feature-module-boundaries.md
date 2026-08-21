# 2026-08-14：桌面端按功能模块拆分

## 背景

`App.vue`、`electron/main.cjs` 与 `electron/database.cjs` 长期同时承载多个功能域，附件、备份、更新、IPC 与数据库迁移互相交织，新增功能时回归范围不断扩大。

## 约定

- 渲染层业务状态优先放入 `src/composables/`，页面负责工作区编排和模板绑定。
- 更新检查、附件管理、数据库备份分别由 `useAppUpdate`、`useAttachmentManager`、`useDatabaseBackups` 管理。
- 快速打开、历史记录与通用设置分别由 `QuickOpenDialog`、`NoteHistoryDialog`、`GeneralSettingsDialog` 自己管理查询、加载、交互和持久化；`App.vue` 只负责打开入口与结果编排。
- 快捷键格式化、录入与匹配集中在 `src/utils/keyboard-shortcuts.ts`，避免多个设置入口各自实现。
- 文件夹、标签、时间筛选和右键菜单共享 `--overlay-*` 尺寸变量，新增弹层不得另写一套字号、行高和视口上限。
- IPC channel 集中在 `electron/ipc-handlers.cjs`，按工作区、附件、笔记、目录标签、快速记录、数据传输、备份、同步和应用域注册；`main.cjs` 只装配依赖。
- 数据库建表、兼容迁移和 FTS 初始化放在 `electron/database-schema.cjs`；摘要与全文搜索放在 `electron/database-search.cjs`。
- 重构不得修改已有 IPC 名称、仓储返回结构、同步协议和界面行为。

## 验证

- `tests/module-boundaries.test.cjs` 固定模块边界，防止功能再次回流到总入口。
- `tests/ui-polish.test.cjs` 固定弹层控件的共享尺寸变量和文件夹树复用关系。
- 行为仍由原数据库、编辑器、同步、附件和备份测试覆盖。
