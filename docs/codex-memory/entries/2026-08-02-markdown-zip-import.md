# Markdown ZIP 直接导入

## 需求

桌面端导出的 Markdown ZIP 应能直接重新导入，避免用户手动解压；导入内容不包含压缩包文件名对应的额外根目录。

## 实现

- Markdown 导入选择器同时支持文件夹和 `.zip` 文件。
- ZIP 在内存中直接读取，不创建临时解压目录。
- ZIP 内部文件夹层级直接映射到所选目标位置，不额外创建压缩包名称目录。
- 继续保留原有文件夹导入行为：所选文件夹本身仍作为来源根目录。
- 仅导入 `.md` 和 `.markdown`，忽略 `__MACOSX`、`.DS_Store` 与 AppleDouble 文件。
- 拒绝绝对路径、盘符路径和包含 `..` 的 ZIP 条目。

## 代码位置

- `electron/data-transfer.cjs`
- `electron/main.cjs`
- `src/App.vue`
- `tests/data-transfer.test.cjs`
