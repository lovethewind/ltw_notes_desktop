# 2026-08-20：渲染进程首包拆分

## 背景

主页面静态导入 Milkdown/Crepe 编辑器和低频弹窗，导致应用启动时必须解析完整编辑器实现。优化前主 JS 为 1,608,633 B，主 CSS 约 203 KB。

## 约定

- `App.vue` 通过 `defineAsyncComponent` 按需加载 `MarkdownVisualEditor`、快速打开、历史记录和通用设置。
- 历史记录内部的只读编辑器也必须异步加载，避免历史弹窗重新把编辑器拉回首包。
- 组件对外事件和类型继续使用 type-only import，保存、历史及同步接口不变。
- Crepe 已将代码语言拆为动态 chunk，不额外维护一套语言加载映射。

## 结果与验证

- 主 JS 降至 197,495 B，下降约 87.7%；编辑器成为独立约 1.04 MB chunk。
- 主 CSS 降至约 124 KB，编辑器样式成为独立约 80 KB chunk。
- `tests/bundle-splitting.test.cjs` 固定异步 seam，防止低频模块重新静态进入首包。
- 类型检查、全量测试、Electron 端到端测试和 ARM64 打包均需通过。
