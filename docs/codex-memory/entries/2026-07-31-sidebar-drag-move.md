# 侧边栏拖拽移动

## 需求

侧边栏支持直接拖动笔记和文件夹，减少通过菜单反复选择目标目录的操作。

## 实现约束

- 笔记拖到文件夹时修改 `folderId`，拖到“未分类”时清空 `folderId`。
- 文件夹支持拖入另一文件夹，也支持拖到目标文件夹的上方或下方调整同级顺序。
- SQLite 事务统一重排来源与目标层级的 `sort_order`，并为变更文件夹生成同步 outbox。
- 禁止文件夹移动到自身或任意后代，避免形成循环树。
- 搜索、置顶、标签和回收站等非完整树视图不开放拖拽，防止筛选结果造成误判。
- 文件夹中心区域悬停 550ms 后自动展开；上、下边缘显示排序插入线。

## 相关文件

- `electron/database.cjs`
- `electron/main.cjs`
- `electron/preload.cjs`
- `src/App.vue`
- `src/components/FolderTreeItem.vue`
- `src/style.css`
- `tests/database.test.cjs`
