/**
 * 将标准 JSON 文本格式化为两个空格缩进。
 *
 * @param {string} code JSON 原文。
 * @returns {{ ok: true, code: string } | { ok: false, code: "", message: string }} 格式化结果。
 */
export function formatJsonCode(code) {
  try {
    return {
      ok: true,
      code: JSON.stringify(JSON.parse(code), null, 2)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "无法解析 JSON"
    return {
      ok: false,
      code: "",
      message: `JSON 格式错误：${reason}`
    }
  }
}
