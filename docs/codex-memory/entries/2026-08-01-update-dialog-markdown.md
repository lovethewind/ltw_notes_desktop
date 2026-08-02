# 新版本弹窗支持 Markdown

## 需求

新版本提示弹窗需要更大，以便阅读较长的发布说明；GitHub Release 返回的更新内容需要按 Markdown 格式展示。

## 实现

- 弹窗宽度由 480px 增至 640px，更新内容区提高最大可视高度并保持小窗口自适应。
- 使用项目已有的 `marked` 渲染发布说明，再通过 `DOMPurify` 净化 HTML 后交给 Vue 展示。
- 为标题、列表、链接、代码、引用、表格和图片补充浅色及深色模式样式。

## 相关文件

- `src/App.vue`
- `src/style.css`
