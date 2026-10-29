# 让 .md 拖到应用图标能打开

> 2026-10-29 · 桌面端

## 问题

把 `.md` 拖到 Dock 图标（或在 Finder 里双击、右键「打开方式」）没有任何反应。
窗口内拖放却正常 —— 两者不是同一条链路。

## 根因（两处断点，缺一都表现为「毫无反应」）

| 层 | 断在哪 | 证据 |
|---|---|---|
| 系统声明 | 打包后的 `Info.plist` **没有 `CFBundleDocumentTypes`** | `PlistBuddy -c "Print :CFBundleDocumentTypes"` → Does Not Exist；`package.json` 的 `build` 里只有 `protocols`，没有 `fileAssociations` |
| 主进程 | 只注册了 `app.on("open-url")`（自定义 scheme），**没有 `open-file`**，也没有 argv 解析与单实例锁 | `grep open-file electron/main.cjs` 无结果 |

实测：`open -a "/Applications/心悦笔记.app" /tmp/x.md` →
`_LSOpenURLsWithCompletionHandler() failed ... error -10820`；而同一命令不带文件时 exit 0。
说明应用本身能被 LaunchServices 启动，问题只出在「带文件」这一调用。

窗口内拖放走的是 HTML5 drop + `getDroppedFilePath`，完全绕开 LaunchServices，所以一直可用。

## 方案

### 1. 打包声明（`package.json` → `build.fileAssociations`）

```json
{
  "ext": ["md", "markdown", "mdown"],
  "name": "Markdown Document",
  "description": "Markdown 文档",
  "mimeType": "text/markdown",
  "role": "Editor",
  "rank": "Alternate"
}
```

- **`rank: "Alternate"` 是必须的**：不写时 electron-builder 默认生成 `LSHandlerRank = Default`，
  等于宣称自己是 Markdown 的**默认**程序，会抢走用户已经设好的默认打开方式（Typora / Obsidian / VS Code）。
  `Alternate` 表示「可以打开、但不是首选」，只进「打开方式」列表。
- 不含 `txt`：`.txt` 是通用纯文本，注册进去会让「打开方式」里多一项容易被误选。
  窗口内拖放仍然接受 `.txt`，两者口径不同是有意的。

### 2. 主进程（`electron/main.cjs`）

- `app.on("open-file")` **必须在 `app.whenReady()` 之前注册**：冷启动时该事件可能早于 ready，
  注册晚了直接丢。
- 处理函数里 `event.preventDefault()`，并把路径推进 `pendingOpenFilePaths`。
- `flushPendingOpenFiles()`：窗口不存在、已销毁、或 `webContents.isLoading()` 时**不发送**，
  先攒着；`did-finish-load` 回调里补投一次。页面没加载完就 send，IPC 会石沉大海。
- 窗口被关掉（macOS 关窗不退进程）时收到 open-file，顺手 `createWindow()` 把窗口叫回来。
- Windows / Linux 没有 `open-file`，冷启动路径靠 `collectOpenablePathsFromArgv(process.argv)`。
- `requestSingleInstanceLock()` + `second-instance`：第二个实例带着文件参数启动时，把路径交给
  已运行的窗口，并 restore / show / focus。拿不到锁的实例 `app.quit()`，且 `whenReady` 里
  第一行 `if (!hasSingleInstanceLock) return`，避免它照样建一遍窗口再退出。
- **E2E 下跳过加锁**（`e2eRuntime ? true : app.requestSingleInstanceLock()`）：每个用例用自己的
  userData，但锁是按 userData 目录算的，并行/重启类用例会互相顶掉。

### 3. 渲染层（`preload` + `types.ts` + `App.vue`）

- 新通道 `local-file:open-paths`，`onOpenLocalFilePaths(callback)` 返回取消函数。
  与菜单的 `local-file:open-request` 分开：那条不带路径、作用是弹文件选择框。
- `App.vue`：`openLocalFilesFromSystem(filePaths)` 把每个路径 `.then` 串到
  `openLocalFileChain` 上，逐个 `await openMarkdownFileByPath(filePath)`。
  - **串行不是洁癖**：多个文件拖进来时系统逐个派发 open-file，并发读盘会让标签顺序跟着
    IO 完成时间乱跳，也会让「已打开则聚焦」的判断在同一个文件上抢跑。
  - 链上每个任务都 `.catch(() => {})`：单个文件失败不能断链，否则之后拖什么都打不开。
- 白名单统一成 `OPENABLE_FILE_PATTERN`（`App.vue` 内唯一一处），窗口内拖放与系统请求共用。

## 验证

- 单测 **568/568**（新增 `tests/local-file-open-from-system.test.cjs` 7 条，逐段守卫上面三处接线，
  含「open-file 必须在 whenReady 之前」「did-finish-load 里补投」「正则只定义一处」）。
- 新增 e2e **3/3**（`tests/e2e/local-file-open-from-system.e2e.test.cjs`）：
  主进程 `app.emit("open-file", …)` 模拟 LaunchServices 派发 → 建出文件标签并显示正文；
  连续投递两个文件时标签顺序稳定；投递 `.png` 时不建标签。
- 回归：外部文件 e2e 13/13、标签栏 5/5、AI 10/10、查找替换 2/2。
- 打包产物 `Info.plist` 实测：`CFBundleTypeExtensions = [md, markdown, mdown]`、
  `CFBundleTypeRole = Editor`、`LSHandlerRank = Alternate`。
- `open -a "<新包>" /tmp/x.md` 从 `error -10820` 变为 **exit 0**。

## 已知限制

- **必须重新打包并覆盖安装才生效**。`Info.plist` 是打包产物，`npm run dev` 下系统不会派发
  `open-file`；开发时只能通过 e2e 里 emit 事件或非 mac 平台的 argv 分支验证。
- 已安装的旧版本（含 0.11.0 首版）都没有这个声明，升级前拖图标依然不会有反应，这是预期。
- 没装 `duti`，无法用命令行确认系统默认 `.md` 程序是否保持原样；`Alternate` 的语义保证不抢默认，
  但如需核实要用「显示简介 → 打开方式」人工看一眼。
