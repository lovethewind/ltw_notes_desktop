# 便携导出与完整备份

## 需求

- 完整备份不应把附件转成 Base64；附件应以原始文件保存。
- `.xynotes` 不再兼容旧版 JSON 格式，只接受新版 ZIP 容器。
- 保留通用 Markdown ZIP，图片和其他附件放在 `assets/`，正文使用相对路径。
- 导入通用 Markdown ZIP 时，将相对资源恢复为本地附件。
- 单篇 Markdown 是单文件导出，不打包附件，也不主动进行 Base64 转换；已上传资源恢复原远端地址，本地未上传资源保留应用地址并提示。

## 实现

- `electron/data-transfer.cjs` 负责新版 `.xynotes` 容器的创建、校验与解析。容器包含 `manifest.json`、`data.json` 和按内容哈希命名的 `assets/` 原始文件。
- Markdown ZIP 导出会识别应用附件地址、远端缓存地址及已有图片 Data URL，统一写入 `assets/` 并改写为相对路径；回读时把相对资源作为二进制交给主进程恢复。
- `electron/main.cjs` 的完整备份文件入口仅接受 `.xynotes`，旧 JSON 会返回“格式过旧”错误。账号档案迁移使用的内部内存备份不属于文件格式，继续保留。
- 单篇 Markdown 调用仓储的资源地址展开逻辑，只将已有远端地址恢复出来，不生成新的 Data URL。

## 验证重点

- `.xynotes` 的 `data.json` 不包含 `dataBase64` 和本机绝对路径。
- Markdown ZIP 同时覆盖图片与非图片附件，ZIP 回读后正文引用能落到本地附件。
- 导入旧 JSON `.xynotes` 必须明确失败，避免误判为新版备份。

## 已有 Base64 正文迁移

- 使用 `scripts/migrate-base64-assets.cjs --db <notes.sqlite3>` 进行只读预览，添加 `--apply` 才会修改数据库。
- 迁移按图片二进制 SHA-256 匹配 `note_assets`。已有附件恢复为 `xinyue-asset://local/<id>`，后续导出或同步可展开其原远端地址；未匹配图片会提取到档案的 `assets/` 并创建受管附件。
- 执行模式先调用 SQLite 在线备份，在档案的 `migration-backups/` 保存迁移前数据库；笔记更新后写入同步队列，历史版本标记为待同步。
- 必须完全退出客户端后再执行 `--apply`，避免运行中的编辑内容与脚本迁移互相覆盖。
