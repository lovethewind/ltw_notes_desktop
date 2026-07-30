# 心悦笔记

心悦笔记是一款基于 Electron、Vue 3 和 SQLite 构建的桌面笔记应用。应用以本地优先为核心：笔记、文件夹、标签、历史版本和附件均可保存在本机，也可以连接心悦心享服务，在多端之间同步数据。

当前桌面端主要面向 macOS Apple Silicon（arm64）。

## 功能特性

- Markdown 可视化编辑，支持标题、列表、代码块、表格、公式、引用和图片等常用内容
- 文件夹、嵌套目录、标签、置顶和回收站管理
- 标题与正文全文搜索，展示命中摘要并自动展开所在文件夹
- 笔记内查找、结果切换、自动定位和关键词高亮
- 图片及任意格式附件上传、粘贴、打开和同步
- 笔记历史版本查看、恢复和同步
- Markdown、目录和完整备份的导入导出
- SQLite 与本地附件的自动备份、手动备份和安全恢复
- 可复制网页版笔记链接，并在网页端或桌面端定位对应笔记
- 编辑模式下使用 `Command/Ctrl + 鼠标左键` 打开链接
- 深色模式、专注模式和文档大纲
- 检查新版本

## 本地优先与数据隔离

应用数据默认保存在本地 SQLite 数据库中。不同后端域名、不同登录用户以及未登录状态分别使用独立的数据档案，避免数据相互混用。

macOS 下的数据位于“心悦笔记”的应用数据目录中，主要结构如下：

```text
心悦笔记/
├── profiles/
│   └── <后端标识>/
│       └── <用户标识>/
│           ├── notes.sqlite3
│           ├── assets/
│           └── backups/
└── sync-settings.json
```

后端和用户目录使用哈希标识，不会直接暴露域名或用户 ID。请不要在应用运行时手动修改 SQLite、WAL 或附件文件；迁移数据前建议先通过应用创建完整备份。

## 同步服务

同步并非本地使用的前置条件。未登录时可以正常创建和编辑笔记；连接账号后，应用会将当前档案与服务端同步。

默认配置：

| 配置 | 默认地址 | 用途 |
| --- | --- | --- |
| 后端请求地址 | `https://lovethewind.cn` | 登录、同步和附件上传 |
| Web 前端地址 | `https://lovethewind.cn` | 生成及识别网页版笔记链接 |

两个地址可以分别配置，以支持前后端部署在不同域名的环境。

## 技术栈

- Electron 43
- Vue 3 + TypeScript
- Vite 8
- Milkdown / Crepe
- SQLite（better-sqlite3）
- CodeMirror
- electron-builder

## 开发环境

需要安装 Node.js 和 npm。克隆项目后执行：

```bash
npm install
```

启动桌面开发环境：

```bash
npm run desktop:dev
```

仅启动 Vite Web 界面：

```bash
npm run dev
```

## 测试与检查

运行全部自动化测试：

```bash
npm test
```

运行数据库与数据迁移相关测试：

```bash
npm run test:database
```

执行 TypeScript 类型检查：

```bash
npm run type-check
```

构建前端资源：

```bash
npm run build
```

## macOS 打包

生成可直接双击运行的 arm64 应用：

```bash
npm run desktop:pack:mac
```

输出位置：

```text
release/mac-arm64/心悦笔记.app
```

生成 arm64 DMG 安装包：

```bash
npm run desktop:build:mac
```

输出位置：

```text
release/心悦笔记-<版本号>-arm64.dmg
```

当前构建未配置 Apple Developer 签名和公证。首次打开时如被 macOS 拦截，可前往“系统设置 → 隐私与安全性”允许打开。正式分发前建议补充签名、公证和自动更新安装能力。

## 常用快捷键

| 操作 | macOS | Windows / Linux |
| --- | --- | --- |
| 新建笔记 | `Command + N` | `Ctrl + N` |
| 保存笔记 | `Command + S` | `Ctrl + S` |
| 笔记内查找 | `Command + F` | `Ctrl + F` |
| 打开编辑区链接 | `Command + 鼠标左键` | `Ctrl + 鼠标左键` |

## 项目结构

```text
.
├── electron/       # Electron 主进程、SQLite、同步、附件和备份
├── src/            # Vue 渲染进程与编辑器界面
├── tests/          # Node.js 自动化测试
├── build/          # 应用图标等打包资源
├── dist/           # Vite 构建产物
└── release/        # macOS 应用和安装包
```

## 数据与附件限制

- 单篇笔记正文最大 15 MiB（按 UTF-8 字节数计算）
- 单张图片最大 20 MiB
- 单个其他附件最大 100 MiB
- 每篇笔记在本地保留最近 50 条历史版本

## 安全说明

- 外部网页链接交由系统默认浏览器打开，不会替换桌面应用页面
- 本地附件通过应用内部协议访问
- 备份恢复前会自动创建保护快照，恢复失败时尝试回滚
- 同步 Token 使用 Electron `safeStorage` 加密后保存

## 开源仓库

[GitHub：lovethewind/ltw_notes_desktop](https://github.com/lovethewind/ltw_notes_desktop)

