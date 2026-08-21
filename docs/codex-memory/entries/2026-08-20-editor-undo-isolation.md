# 2026-08-20：编辑器撤销历史按文档隔离

## 问题

主页面为提升切换速度复用同一个 Milkdown 编辑器实例。切换笔记时使用 `replaceAll` 回填新正文，但替换事务和上一笔记的 ProseMirror history 状态仍可撤销，导致在第二篇笔记按 `Cmd/Ctrl+Z` 后恢复第一篇正文。

## 修复

- 文档 ID 变化并完成正文替换后，临时重配状态以取得空的 history 状态，再通过事务元数据仅替换 history 插件状态。
- 不调用 `view.updateState`，避免 Crepe 插件视图被重建并导致自定义中文工具栏退回默认样式。
- 清空跨文档 undo/redo；编辑器实例、DOM、其他插件状态和同一文档内的正常撤销继续复用。
- 内容相同但文档 ID 不同的场景也会清空历史，避免相同正文绕过隔离。

## 验证

- `tests/editor-performance.test.cjs` 固定文档切换时的 history 重置逻辑。
- Electron E2E 真实编辑第一篇、切到第二篇并撤销，确认不会串文档；随后确认第二篇内部撤销仍然正常。
