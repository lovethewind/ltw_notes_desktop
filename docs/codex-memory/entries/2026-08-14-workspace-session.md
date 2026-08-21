# 工作区会话本地恢复

## 需求

桌面端重启后恢复上次打开的笔记标签、当前活动标签和每篇笔记的正文滚动位置，并支持标签固定与同组拖动排序。

## 实现

- `workspace_session` 保存当前活动笔记。
- `workspace_session_tabs` 保存标签顺序和固定状态。
- `note_view_states` 按笔记保存滚动位置。
- 三类数据均位于当前账号的本地 SQLite，不进入笔记正文、逻辑导出或云同步；完整 SQLite 备份会自然包含这些表。
- 固定标签排在普通标签左侧，普通打开不会覆盖固定标签；拖动仅允许在固定组或普通组内部排序。
- 在普通标签执行“关闭其他标签”时保留全部固定标签和当前标签，固定标签不受普通批量关闭影响。
- 标签和滚动状态分别防抖写入，退出前与正文草稿一起强制落盘；笔记永久删除时由外键级联清理对应状态。

## 关键文件

- `electron/database-schema.cjs`
- `electron/database.cjs`
- `electron/ipc-handlers.cjs`
- `src/composables/useWorkspaceSession.ts`
- `src/utils/note-tabs.ts`
- `src/components/MarkdownVisualEditor.vue`
- `src/App.vue`
- `tests/workspace-session.test.cjs`
- `tests/note-tabs.test.cjs`
