# Electron 标签会话端到端测试

## 需求

为桌面端关键工作区行为增加真实 Electron 窗口测试，避免仅靠纯函数单测遗漏主进程、渲染进程与 SQLite 会话持久化之间的集成回归。

## 实现

- 使用 Playwright Electron 驱动启动生产构建后的主窗口。
- 测试数据写入 `mkdtemp` 创建的独立目录，结束后删除，不读取或修改正式笔记库。
- 仅当 `NODE_ENV=test` 且显式提供 `XINYUE_NOTES_E2E_USER_DATA` 时允许覆盖 `userData`。
- E2E 主窗口默认保持隐藏，避免自动化测试闪窗和抢焦点；需要观察界面时设置 `XINYUE_NOTES_E2E_SHOW_WINDOW=1`。
- E2E 运行态不注册系统协议、全局快捷键，也不创建每日备份，避免污染开发机系统状态。
- 回归路径覆盖：打开多个标签、固定标签、执行“关闭其他标签”、退出应用、复用同一临时库重启并验证标签和活动页恢复。

## 验证

- `npm run test:e2e`
- `npm test`
- `npm run desktop:pack:mac`
