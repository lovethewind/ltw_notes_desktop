#!/usr/bin/env node

const { createHash, randomUUID } = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")
const Database = require("better-sqlite3")
const {
  collectEmbeddedBase64Images,
  replaceEmbeddedBase64Images
} = require("../electron/base64-asset-migration.cjs")

const EXTENSIONS = new Map([
  ["image/avif", ".avif"],
  ["image/bmp", ".bmp"],
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/svg+xml", ".svg"],
  ["image/webp", ".webp"]
])

function nowIso() {
  return new Date().toISOString()
}

function getAssetPath(databasePath, image) {
  const extension = EXTENSIONS.get(image.mimeType) || ".bin"
  return path.join(path.dirname(databasePath), "assets", image.sha256.slice(0, 2), `${image.sha256}${extension}`)
}

function verifyFileHash(filePath, expectedHash) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex") === expectedHash
}

function ensureAssetFile(filePath, image) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  if (fs.existsSync(filePath)) {
    if (!verifyFileHash(filePath, image.sha256)) {
      throw new Error(`附件文件哈希不一致，已停止迁移：${filePath}`)
    }
    return
  }
  fs.writeFileSync(filePath, image.data, { flag: "wx" })
}

function loadMigrationState(database) {
  const records = [
    ...database.prepare(`
      SELECT 'notes' AS tableName, id, title AS label, content
      FROM notes WHERE instr(content, ';base64,') > 0
    `).all(),
    ...database.prepare(`
      SELECT 'note_history' AS tableName, id, '历史版本' AS label, content
      FROM note_history WHERE instr(content, ';base64,') > 0
    `).all()
  ]
  const assets = database.prepare(`
    SELECT id, file_name AS fileName, mime_type AS mimeType, sha256,
           local_path AS localPath, remote_url AS remoteUrl
    FROM note_assets
  `).all()
  const uniqueImages = new Map()
  let base64Occurrences = 0
  for (const record of records) {
    const images = collectEmbeddedBase64Images(record.content)
    base64Occurrences += images.length
    for (const image of images) {
      if (!uniqueImages.has(image.sha256)) uniqueImages.set(image.sha256, image)
    }
  }
  const assetsByHash = new Map(assets.map((asset) => [asset.sha256, asset]))
  return { records, uniqueImages, assetsByHash, base64Occurrences }
}

/**
 * 预览或执行单个档案的 Base64 图片迁移。
 *
 * @param {string} databasePath notes.sqlite3 绝对路径。
 * @param {{ apply?: boolean }} options 是否写入迁移结果。
 * @returns {Promise<Record<string, any>>} 迁移统计和备份路径。
 */
async function migrateDatabase(databasePath, options = {}) {
  const resolvedDatabasePath = path.resolve(String(databasePath || ""))
  const apply = Boolean(options.apply)
  if (!fs.existsSync(resolvedDatabasePath)) throw new Error(`数据库不存在：${resolvedDatabasePath}`)

  const database = new Database(resolvedDatabasePath, {
    readonly: !apply,
    fileMustExist: true
  })
  database.pragma("busy_timeout = 5000")
  let backupPath = null
  try {
    const state = loadMigrationState(database)
    const matchedAssets = [...state.uniqueImages.keys()]
      .filter((sha256) => state.assetsByHash.has(sha256)).length
    const matchedRemoteAssets = [...state.uniqueImages.keys()]
      .filter((sha256) => state.assetsByHash.get(sha256)?.remoteUrl).length
    const report = {
      databasePath: resolvedDatabasePath,
      mode: apply ? "apply" : "preview",
      scannedRecords: state.records.length,
      base64Occurrences: state.base64Occurrences,
      uniqueImages: state.uniqueImages.size,
      matchedAssets,
      matchedRemoteAssets,
      matchedLocalAssets: matchedAssets - matchedRemoteAssets,
      newAssets: state.uniqueImages.size - matchedAssets,
      changedNotes: 0,
      changedHistories: 0,
      backupPath
    }
    if (!apply || !state.base64Occurrences) return report

    const backupDirectory = path.join(path.dirname(resolvedDatabasePath), "migration-backups")
    fs.mkdirSync(backupDirectory, { recursive: true })
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    backupPath = path.join(backupDirectory, `notes-before-base64-migration-${timestamp}.sqlite3`)
    await database.backup(backupPath)

    const resolvedAssets = new Map(state.assetsByHash)
    const migrate = database.transaction(() => {
      const resolveAsset = (image) => {
        let asset = resolvedAssets.get(image.sha256)
        if (asset) {
          let localPath = String(asset.localPath || "")
          if (!localPath || !fs.existsSync(localPath)) {
            localPath = getAssetPath(resolvedDatabasePath, image)
            ensureAssetFile(localPath, image)
            database.prepare("UPDATE note_assets SET local_path = ?, updated_at = ? WHERE id = ?")
              .run(localPath, nowIso(), asset.id)
            asset = { ...asset, localPath }
            resolvedAssets.set(image.sha256, asset)
          } else if (!verifyFileHash(localPath, image.sha256)) {
            throw new Error(`附件表中的文件内容与哈希不一致：${localPath}`)
          }
          return `xinyue-asset://local/${asset.id}`
        }

        const id = randomUUID()
        const localPath = getAssetPath(resolvedDatabasePath, image)
        const extension = path.extname(localPath)
        const timestamp = nowIso()
        ensureAssetFile(localPath, image)
        database.prepare(`
          INSERT INTO note_assets(
            id, file_name, mime_type, byte_size, sha256, local_path,
            remote_url, server_source_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
        `).run(
          id,
          `迁移图片-${image.sha256.slice(0, 12)}${extension}`,
          image.mimeType,
          image.data.length,
          image.sha256,
          localPath,
          timestamp,
          timestamp
        )
        asset = { id, localPath, sha256: image.sha256 }
        resolvedAssets.set(image.sha256, asset)
        return `xinyue-asset://local/${id}`
      }

      for (const record of state.records) {
        const result = replaceEmbeddedBase64Images(record.content, resolveAsset)
        if (!result.replacedCount || result.content === record.content) continue
        if (record.tableName === "notes") {
          const timestamp = nowIso()
          database.prepare("UPDATE notes SET content = ?, updated_at = ?, dirty = 1 WHERE id = ?")
            .run(result.content, timestamp, record.id)
          database.prepare("DELETE FROM outbox WHERE entity_type = 'note' AND entity_id = ?")
            .run(record.id)
          database.prepare(`
            INSERT INTO outbox(entity_type, entity_id, operation, payload, created_at, attempt_count)
            VALUES ('note', ?, 'upsert', '{}', ?, 0)
          `).run(record.id, timestamp)
          report.changedNotes += 1
        } else {
          database.prepare("UPDATE note_history SET content = ?, dirty = 1 WHERE id = ?")
            .run(result.content, record.id)
          report.changedHistories += 1
        }
      }
    })
    migrate()
    report.backupPath = backupPath
    return report
  } finally {
    database.close()
  }
}

function printHelp() {
  process.stdout.write(`用法：\n  node scripts/migrate-base64-assets.cjs --db /绝对路径/notes.sqlite3\n  node scripts/migrate-base64-assets.cjs --db /绝对路径/notes.sqlite3 --apply\n\n默认仅预览，不修改数据。执行 --apply 前请完全退出心悦笔记；脚本会先在档案目录的 migration-backups 中创建 SQLite 备份。\n`)
}

function parseArguments(argv) {
  const options = { apply: false, databasePath: "" }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--apply") options.apply = true
    else if (argument === "--db") options.databasePath = argv[++index] || ""
    else if (argument === "--help" || argument === "-h") options.help = true
    else throw new Error(`未知参数：${argument}`)
  }
  return options
}

function printReport(report) {
  process.stdout.write([
    `模式：${report.mode === "apply" ? "已执行" : "只读预览"}`,
    `数据库：${report.databasePath}`,
    `含 Base64 的记录：${report.scannedRecords}`,
    `Base64 图片引用：${report.base64Occurrences}`,
    `唯一图片：${report.uniqueImages}`,
    `匹配已有附件：${report.matchedAssets}`,
    `其中保留原网络地址：${report.matchedRemoteAssets}`,
    `仅有本地附件记录：${report.matchedLocalAssets}`,
    `需要新建附件：${report.newAssets}`,
    ...(report.mode === "apply" ? [
      `已更新笔记：${report.changedNotes}`,
      `已更新历史：${report.changedHistories}`,
      `安全备份：${report.backupPath || "无需迁移，未创建"}`
    ] : ["确认无误后添加 --apply 执行迁移。"])
  ].join("\n") + "\n")
}

if (require.main === module) {
  Promise.resolve().then(async () => {
    const options = parseArguments(process.argv.slice(2))
    if (options.help) {
      printHelp()
      return
    }
    if (!options.databasePath) throw new Error("缺少 --db 数据库路径；使用 --help 查看示例")
    printReport(await migrateDatabase(options.databasePath, { apply: options.apply }))
  }).catch((error) => {
    process.stderr.write(`迁移失败：${error.message}\n`)
    process.exitCode = 1
  })
}

module.exports = { migrateDatabase }
