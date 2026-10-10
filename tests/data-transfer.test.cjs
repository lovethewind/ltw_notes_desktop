const assert = require("node:assert/strict")
const { createHash } = require("node:crypto")
const { readFileSync } = require("node:fs")
const { resolve } = require("node:path")
const test = require("node:test")
const AdmZip = require("adm-zip")
const {
  collectMarkdownDocumentsFromZip,
  createCleanMarkdownDocument,
  createPortableBackupArchive,
  createMarkdownDocument,
  createMarkdownZip,
  extractLocalImageReferences,
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

test("单文件导入：只挑出本地相对路径图片，跳过网络图与锚点", () => {
  const content = [
    '# 标题',
    '',
    '![本地](./images/a.png)',
    '![子目录](sub/b.jpg)',
    '![带转义](images/%E4%B8%AD%E6%96%87.png)',
    '![网络图](https://example.com/c.png)',
    '![data](data:image/png;base64,AAAA)',
    '![锚点](#section)',
    '<img src="html-d.png" alt="HTML 写法">',
    '<img src="https://example.com/e.png">',
    ''
  ].join('\n')

  // 两边都排序：extractLocalImageReferences 的返回顺序取决于正则扫描次序，
  // 这里只关心「收了哪些」，不关心次序（避免把实现细节写死进断言）。
  assert.deepEqual(
    extractLocalImageReferences(content).sort(),
    ['html-d.png', 'images/a.png', 'images/中文.png', 'sub/b.jpg'].sort()
  )
})

test("单文件导入：没有图片引用时返回空数组，不误收普通链接", () => {
  const content = '[普通链接](https://example.com)\n\n正文没有图片\n'
  assert.deepEqual(extractLocalImageReferences(content), [])
})

test("单文件导入入口：独立 IPC、不建来源文件夹、并搬移本地图片", () => {
  const mainSource = readFileSync(resolve(__dirname, "../electron/main.cjs"), "utf8")
  const preloadSource = readFileSync(resolve(__dirname, "../electron/preload.cjs"), "utf8")
  const handlerSource = readFileSync(resolve(__dirname, "../electron/ipc-handlers.cjs"), "utf8")

  // 主进程：单文件走独立函数，且以空来源名调用（= 不建来源文件夹）
  assert.match(mainSource, /async function importSingleMarkdownFile\(folderId\)/)
  assert.match(mainSource, /filters:\s*\[\{\s*name:\s*"Markdown 文件",\s*extensions:\s*\["md",\s*"markdown"\]\s*\}\]/)
  assert.match(mainSource, /importSingleMarkdown:\s*importSingleMarkdownFile/)

  // 单文件收集图片并做目录穿越防护
  // 正文可被覆盖（「把当前打开的文件导入到笔记」用编辑器里的当前值），否则从磁盘读。
  assert.match(mainSource, /async function collectSingleMarkdownDocument\(filePath, contentOverride\)/)
  assert.match(mainSource, /typeof contentOverride === "string"\s*\n\s*\? contentOverride\s*\n\s*: await fs\.promises\.readFile\(filePath, "utf8"\)/)
  assert.match(mainSource, /extractLocalImageReferences\(document\.content\)/)
  assert.match(mainSource, /absolutePath\.startsWith\(rootDirectory \+ path\.sep\)/)
  // 覆盖正文的能力只该由「导入当前文件」使用：其余入口一律走磁盘原件。
  assert.match(mainSource, /const \{ document, resourceCount \} = await collectSingleMarkdownDocument\(filePath\)/)
  assert.match(mainSource, /await collectSingleMarkdownDocument\(filePath, content\)/)

  // IPC 与 preload 三处都要有，缺一处就断链
  assert.match(handlerSource, /"data:import-single-markdown"/)
  assert.match(preloadSource, /importSingleMarkdown:\s*\(folderId\)\s*=>\s*ipcRenderer\.invoke\("data:import-single-markdown",\s*folderId\)/)
})

test("导入当前文件：不弹文件框、正文取编辑器当前值、位置窗口第三模式", () => {
  const mainSource = readFileSync(resolve(__dirname, "../electron/main.cjs"), "utf8")
  const preloadSource = readFileSync(resolve(__dirname, "../electron/preload.cjs"), "utf8")
  const handlerSource = readFileSync(resolve(__dirname, "../electron/ipc-handlers.cjs"), "utf8")
  const appSource = readFileSync(resolve(__dirname, "../src/App.vue"), "utf8")

  // 主进程：参数化入口，绝不弹系统文件框（文件本来就开着）。
  const importFromPath = mainSource.match(/async function importMarkdownFromPath[\s\S]*?\n\}/)
  assert.ok(importFromPath, '应有 importMarkdownFromPath')
  assert.doesNotMatch(importFromPath[0], /showOpenDialog/)
  assert.match(mainSource, /importMarkdownPath:\s*importMarkdownFromPath/)

  // IPC 与 preload 三处都要有。
  assert.match(handlerSource, /"data:import-markdown-path"/)
  assert.match(
    preloadSource,
    /importMarkdownPath:\s*\(filePath, content, folderId\)\s*=>\s*ipcRenderer\.invoke\("data:import-markdown-path", filePath, content, folderId\)/
  )

  // 文件标签头部按钮 → 位置窗口第三模式 → 真的调到新 IPC。
  assert.match(appSource, /class="editor-header-button is-import-note"/)
  assert.match(appSource, /@click="openActiveFileImportTarget"/)
  assert.match(appSource, /markdownImportTargetMode = ref<'single' \| 'folder' \| 'current-file'>\('folder'\)/)
  assert.match(appSource, /openMarkdownImportTarget\('current-file'\)/)
  assert.match(appSource, /@click="importActiveFileNote"/)
  assert.match(appSource, /window\.notesDesktop\.importMarkdownPath\(filePath, content, targetFolderId\)/)
  // 导入的是编辑器里的当前正文，不是磁盘上那份（未保存的改动也要带上）。
  assert.match(appSource, /const \{ filePath, content \} = doc/)
})

test("导入导出面板提供「单个 Markdown 文件」入口，且位置窗口按入口切换动作", () => {
  const appSource = readFileSync(resolve(__dirname, "../src/App.vue"), "utf8")

  // 面板里两个入口都要在，且各自带上正确的模式
  assert.match(appSource, /导入 Markdown 文件夹或 ZIP/)
  assert.match(appSource, /导入单个 Markdown 文件/)
  assert.match(appSource, /openMarkdownImportTarget\('single'\)/)
  assert.match(appSource, /openMarkdownImportTarget\('folder'\)/)

  // 位置窗口按模式切换提示文案与确认按钮，避免点「单个文件」却看到文件夹的说法
  assert.match(appSource, /markdownImportTargetMode === 'folder' \? 'tabler:folder-down' : 'tabler:file-import'/)
  assert.match(appSource, /@click="importSingleMarkdownNote"/)

  // 渲染层必须真的调到新 IPC，否则 UI 是死的
  assert.match(appSource, /window\.notesDesktop\.importSingleMarkdown\(targetFolderId\)/)
})

test("纯净Markdown导出：不写front matter，标题改用一级标题承载", () => {
  const document = createCleanMarkdownDocument({ title: "测试", content: "正文" })

  assert.equal(document, "# 测试\n\n正文\n")
  // front matter 是「导回来不丢元数据」用的，纯净导出不该带。
  assert.doesNotMatch(document, /^---/)
  assert.doesNotMatch(document, /createdAt/)
})

test("纯净Markdown导出：正文首行已是同名一级标题时不重复添加", () => {
  const document = createCleanMarkdownDocument({ title: "测试", content: "# 测试\n\n正文" })

  assert.equal(document, "# 测试\n\n正文\n")
})

test("纯净Markdown导出：嵌入卡片降级成一行引用，能解析到网页地址时带链接", () => {
  const content = ["开头", "", '<div data-xynote-embed="note:abc"></div>', "", "结尾"].join("\n")
  const document = createCleanMarkdownDocument(
    { title: "含嵌入", content },
    {
      resolveEmbed: (noteId) => (
        noteId === "abc"
          ? { title: "被嵌入的笔记", url: "https://lovethewind.cn/notes/123" }
          : null
      )
    }
  )

  assert.match(document, /> 嵌入的笔记：\[被嵌入的笔记\]\(https:\/\/lovethewind\.cn\/notes\/123\)/)
  assert.doesNotMatch(document, /data-xynote-embed/)
})

test("纯净Markdown导出：解析不到目标时退回纯文本引用，不留空div", () => {
  const document = createCleanMarkdownDocument(
    { title: "T", content: '<div data-xynote-embed="note:gone"></div>' }
  )

  assert.match(document, /> 嵌入的笔记：未命名笔记/)
  assert.doesNotMatch(document, /data-xynote-embed/)
})

test("纯净Markdown导出：行内字号与保真硬换行降级成通用写法", () => {
  const document = createCleanMarkdownDocument({
    title: "T",
    content: [
      '[<span style="font-size:16px">环境信息</span>](https://a.example)',
      "",
      "<br />",
      "",
      "<br />",
      "",
      "666000"
    ].join("\n")
  })

  assert.match(document, /\[环境信息\]\(https:\/\/a\.example\)/)
  assert.doesNotMatch(document, /font-size/)
  assert.doesNotMatch(document, /<br/)
  // 多个 <br /> 撑出来的长串空行要收敛成一个空行。
  assert.match(document, /\n\n666000/)
  assert.doesNotMatch(document, /\n{3,}/)
})

test("纯净Markdown导出：围栏代码块里的同款标签原样保留", () => {
  const content = [
    "看这段 HTML：",
    "",
    "```html",
    '<div data-xynote-embed="note:abc"></div>',
    "第一行<br />第二行",
    "```",
    "",
    "结束"
  ].join("\n")
  const document = createCleanMarkdownDocument({ title: "T", content })

  // 代码块是用户要看的原文，降级替换绝不能伸进去。
  assert.match(document, /<div data-xynote-embed="note:abc"><\/div>/)
  assert.match(document, /第一行<br \/>第二行/)
})

test("纯净Markdown导出：围栏没闭合时按代码块处理，不擅自改写", () => {
  const document = createCleanMarkdownDocument({
    title: "T",
    content: ["```", "第一行<br />第二行"].join("\n")
  })

  assert.match(document, /第一行<br \/>第二行/)
})

test("纯净Markdown导出接线：IPC、preload、类型与面板入口齐全", () => {
  const projectRoot = resolve(__dirname, "..")
  const read = (relative) => readFileSync(resolve(projectRoot, relative), "utf8")

  assert.match(read("electron/ipc-handlers.cjs"), /data:export-note-markdown-clean/)
  assert.match(read("electron/preload.cjs"), /exportNoteMarkdownClean: \(noteId\) => ipcRenderer\.invoke\("data:export-note-markdown-clean", noteId\)/)
  assert.match(read("electron/main.cjs"), /exportNoteClean: exportNoteMarkdownClean/)
  assert.match(read("src/types.ts"), /exportNoteMarkdownClean\(noteId: string\): Promise<DataTransferResult>/)
  // 面板入口与渲染层调用都要真的接上，否则按钮是死的。
  assert.match(read("src/App.vue"), /导出为纯净 Markdown/)
  assert.match(read("src/App.vue"), /window\.notesDesktop\.exportNoteMarkdownClean\(activeNoteId\.value as string\)/)
})
