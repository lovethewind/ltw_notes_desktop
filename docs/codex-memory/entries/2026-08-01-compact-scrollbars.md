# 内部滚动条窄化

## 需求

桌面端和网页端除当前笔记正文最右侧主滚动条外，其他侧栏、列表、弹层和下拉区域的滚动条调整为原宽度的一半。

## 实现

- Chromium/Electron 内部原生滚动条使用可见的 5px，横向滚动条高度同步调整为 5px。
- 网页端 Element Plus 自定义纵向、横向滚动条也统一为 5px，并为笔记侧栏和文件夹弹层添加具体选择器，避免组件样式覆盖。
- 桌面端通过 `.editor-panel .editor-body .milkdown-editor-scroll`、网页端通过 `.note-workspace-editor .milkdown-editor-scroll` 将当前笔记正文主滚动条恢复为 6px。
- 历史预览、侧栏、选择弹层、备份列表等非主正文滚动区域使用 5px。
- Firefox 不支持像素级滚动条宽度，继续使用浏览器提供的 `thin` 档位。
- Chromium/Electron 同时支持标准 `scrollbar-width` 和 WebKit 伪元素；`thin` 会覆盖像素规则并实际显示约 11px。桌面端内部区域直接使用 `auto` 配合 5px 伪元素，避免 Electron 对 `@supports selector(...)` 支持差异；正文主滚动条单独保留 `thin`。

## 代码位置

- 桌面端：`src/style.css`
- 网页端：`src/assets/css/main.scss`、`src/assets/css/note.scss`
