const assert = require("node:assert/strict")
const { createHash } = require("node:crypto")
const { readFileSync } = require("node:fs")
const { resolve } = require("node:path")
const test = require("node:test")
const AdmZip = require("adm-zip")
const {
  collectMarkdownDocumentsFromZip,
  createPortableBackupArchive,
  createMarkdownDocument,
  createMarkdownZip,
  parsePortableBackupArchive,
  parseMarkdownDocument,
  sanitizeFileName
} = require("../electron/data-transfer.cjs")

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

test("Markdown导出和导入会保留标题、标签及正文", () => {
  const markdown = createMarkdownDocument({
    title: "FastAPI 使用",
    content: "# 正文\n\n内容",
    tags: [{ name: "学习" }, { name: "后端" }],
    createdAt: "2026-07-26T10:00:00.000Z",
    updatedAt: "2026-07-26T11:00:00.000Z"
  })

  assert.deepEqual(parseMarkdownDocument(markdown, "文件名"), {
    title: "FastAPI 使用",
    content: "# 正文\n\n内容",
    tagNames: ["学习", "后端"]
  })
})

test("文件名会移除路径字符并避免特殊目录名", () => {
  assert.equal(sanitizeFileName("../接口/API:*?"), "_接口_API___")
  assert.equal(sanitizeFileName(".."), "未命名")
})

test("批量Markdown压缩包会保留文件夹层级和未分类笔记", () => {
  const backup = {
    folders: [
      { id: "folder-1", parentId: null, name: "开发" },
      { id: "folder-2", parentId: "folder-1", name: "后端" }
    ],
    notes: [
      {
        id: "note-1",
        folderId: "folder-2",
        title: "FastAPI",
        content: "正文",
        isDeleted: false,
        tags: []
      },
      {
        id: "note-2",
        folderId: null,
        title: "随笔",
        content: "内容",
        isDeleted: false,
        tags: []
      },
      {
        id: "note-3",
        folderId: null,
        title: "已删除",
        content: "不导出",
        isDeleted: true,
        tags: []
      }
    ]
  }

  const zip = new AdmZip(createMarkdownZip(backup))
  assert.deepEqual(
    zip.getEntries().map((entry) => entry.entryName).sort(),
    ["开发/后端/FastAPI-note-1.md", "未分类/随笔-note-2.md"]
  )
})

test("桌面导出的Markdown压缩包可直接回读且不增加压缩包根目录", () => {
  const backup = {
    folders: [
      { id: "folder-1", parentId: null, name: "开发" },
      { id: "folder-2", parentId: "folder-1", name: "后端" }
    ],
    notes: [
      {
        id: "note-1",
        folderId: "folder-2",
        title: "FastAPI",
        content: "# 正文",
        isDeleted: false,
        tags: [{ name: "学习" }]
      },
      {
        id: "note-2",
        folderId: null,
        title: "随笔",
        content: "内容",
        isDeleted: false,
        tags: []
      }
    ]
  }

  assert.deepEqual(collectMarkdownDocumentsFromZip(createMarkdownZip(backup)), [
    { title: "FastAPI", content: "# 正文", tagNames: ["学习"], folderPath: ["开发", "后端"] },
    { title: "随笔", content: "内容", tagNames: [], folderPath: ["未分类"] }
  ])
})

test("通用Markdown压缩包使用assets目录保存原始资源并可回读", () => {
  const imageData = Buffer.from("fake-png-binary")
  const pdfData = Buffer.from("fake-pdf-binary")
  const embeddedData = Buffer.from("embedded-image")
  const backup = {
    folders: [
      { id: "folder-1", parentId: null, name: "开发" },
      { id: "folder-2", parentId: "folder-1", name: "后端" }
    ],
    assets: [
      {
        id: "asset-image",
        fileName: "架构图.png",
        mimeType: "image/png",
        localUrl: "xinyue-asset://local/asset-image",
        remoteUrl: "https://cdn.example.com/architecture.png",
        data: imageData
      },
      {
        id: "asset-pdf",
        fileName: "接口文档.pdf",
        mimeType: "application/pdf",
        localUrl: "xinyue-asset://local/asset-pdf",
        remoteUrl: "https://cdn.example.com/interface.pdf",
        data: pdfData
      }
    ],
    notes: [
      {
        id: "note-1",
        folderId: "folder-2",
        title: "FastAPI",
        content: [
          "![架构图](xinyue-asset://local/asset-image)",
          "[接口文档](https://cdn.example.com/interface.pdf)",
          `![内嵌图](data:image/png;base64,${embeddedData.toString("base64")})`
        ].join("\n\n"),
        isDeleted: false,
        tags: []
      }
    ]
  }

  const archive = createMarkdownZip(backup)
  const zip = new AdmZip(archive)
  const imagePath = `assets/${sha256(imageData)}.png`
  const pdfPath = `assets/${sha256(pdfData)}.pdf`
  const embeddedPath = `assets/${sha256(embeddedData)}.png`
  assert.deepEqual(
    zip.getEntries().map((entry) => entry.entryName).sort(),
    [embeddedPath, imagePath, pdfPath, "开发/后端/FastAPI-note-1.md"].sort()
  )

  const markdown = zip.readAsText("开发/后端/FastAPI-note-1.md")
  assert.doesNotMatch(markdown, /base64|xinyue-asset:\/\/|cdn\.example\.com/)
  assert.match(markdown, new RegExp(`\\.\\.\\/\\.\\.\\/${imagePath}`))
  assert.match(markdown, new RegExp(`\\.\\.\\/\\.\\.\\/${pdfPath}`))

  const [document] = collectMarkdownDocumentsFromZip(archive)
  assert.equal(document.resources.length, 3)
  assert.deepEqual(
    document.resources.map((resource) => resource.data).sort(Buffer.compare),
    [embeddedData, imageData, pdfData].sort(Buffer.compare)
  )
})

test("新版xynotes以ZIP保存备份元数据和原始附件", () => {
  const imageData = Buffer.from("original-image-binary")
  const pdfData = Buffer.from("original-pdf-binary")
  const backup = {
    version: 2,
    exportedAt: "2026-08-13T10:00:00.000Z",
    folders: [],
    tags: [],
    notes: [],
    histories: [],
    assets: [
      { id: "image-1", fileName: "图片.png", mimeType: "image/png", localPath: "/tmp/image.png" },
      { id: "pdf-1", fileName: "文档.pdf", mimeType: "application/pdf", localPath: "/tmp/document.pdf" }
    ]
  }

  const archive = createPortableBackupArchive(backup, new Map([
    ["image-1", imageData],
    ["pdf-1", pdfData]
  ]))
  const zip = new AdmZip(archive)
  assert.ok(zip.getEntry("manifest.json"))
  assert.ok(zip.getEntry("data.json"))
  assert.ok(zip.getEntry(`assets/${sha256(imageData)}.png`))
  assert.ok(zip.getEntry(`assets/${sha256(pdfData)}.pdf`))
  assert.doesNotMatch(zip.readAsText("data.json"), /dataBase64|\/tmp\/image\.png/)

  const restored = parsePortableBackupArchive(archive)
  assert.deepEqual(restored.assets.map((asset) => asset.data), [imageData, pdfData])
})

test("新版xynotes不再兼容旧JSON备份", () => {
  assert.throws(
    () => parsePortableBackupArchive(Buffer.from(JSON.stringify({ version: 2, notes: [] }))),
    /格式过旧/
  )
})

test("Markdown压缩包会忽略系统文件并拒绝路径穿越", () => {
  const safeZip = new AdmZip()
  safeZip.addFile("__MACOSX/._笔记.md", Buffer.from("无效"))
  safeZip.addFile("资料/.DS_Store", Buffer.from("无效"))
  safeZip.addFile("资料/笔记.md", Buffer.from("正文"))

  assert.deepEqual(collectMarkdownDocumentsFromZip(safeZip.toBuffer()), [
    { title: "笔记", content: "正文", tagNames: [], folderPath: ["资料"] }
  ])

  const unsafeZip = new AdmZip()
  unsafeZip.addFile("安全.md", Buffer.from("正文"))
  unsafeZip.getEntries()[0].entryName = "../越界.md"
  assert.throws(
    () => collectMarkdownDocumentsFromZip(unsafeZip.toBuffer()),
    /不安全路径/
  )
})

test("Markdown导入入口同时支持文件夹和ZIP且ZIP不创建来源根目录", () => {
  const mainSource = readFileSync(resolve(__dirname, "../electron/main.cjs"), "utf8")

  assert.match(mainSource, /collectMarkdownDocumentsFromZip/)
  assert.match(mainSource, /properties:\s*\["openFile",\s*"openDirectory",\s*"createDirectory"\]/)
  assert.match(mainSource, /extensions:\s*\["zip"\]/)
  assert.match(mainSource, /isZipSource\s*\?\s*""\s*:\s*path\.basename\(sourcePath\)/)
})

test("单篇Markdown导出不再内嵌Base64资源", () => {
  const mainSource = readFileSync(resolve(__dirname, "../electron/main.cjs"), "utf8")
  const functionSource = mainSource.slice(
    mainSource.indexOf("async function exportNoteMarkdown"),
    mainSource.indexOf("async function exportAllMarkdown")
  )

  assert.match(functionSource, /expandAssetReferences/)
  assert.doesNotMatch(functionSource, /embedLocalImageData/)
})
