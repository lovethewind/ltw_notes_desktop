const assert = require("node:assert/strict")
const { readFileSync } = require("node:fs")
const { resolve } = require("node:path")
const test = require("node:test")
const { pathToFileURL } = require("node:url")

const projectRoot = resolve(__dirname, "..")

test("合法 JSON 使用两个空格格式化并保留数据类型", async () => {
  const formatter = await import(
    pathToFileURL(resolve(projectRoot, "src/utils/json-code-formatter.js")).href
  )
  const result = formatter.formatJsonCode('{"enabled":true,"items":[1,2]}')

  assert.deepEqual(result, {
    ok: true,
    code: '{\n  "enabled": true,\n  "items": [\n    1,\n    2\n  ]\n}'
  })
})

test("非法 JSON 返回错误且不产生替换内容", async () => {
  const formatter = await import(
    pathToFileURL(resolve(projectRoot, "src/utils/json-code-formatter.js")).href
  )
  const result = formatter.formatJsonCode("{'enabled': true}")

  assert.equal(result.ok, false)
  assert.equal(result.code, "")
  assert.match(result.message, /JSON 格式错误/)
})

test("编辑器仅为 JSON 代码块接入格式化按钮", () => {
  const editorSource = readFileSync(
    resolve(projectRoot, "src/components/MarkdownVisualEditor.vue"),
    "utf8"
  )

  assert.match(editorSource, /json-code-format-button/)
  assert.match(editorSource, /formatJsonCode/)
  assert.match(editorSource, /EditorView\.findFromDOM/)
  assert.match(editorSource, /languageName === 'json'/)
  assert.match(editorSource, /codeMirrorView\.focus\(\)[\s\S]*codeMirrorView\.dispatch\(/)
})
