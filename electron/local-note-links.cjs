"use strict"

const { splitFencedCodeSegments } = require("./data-transfer.cjs")

/**
 * 桌面端本机笔记地址的两种写法：
 * - 新格式 `https://xinyue-note.local/{noteId}`（`buildNoteHref` 在目标未同步时的兜底产物）
 * - 旧格式 `xinyue-notes://note/{noteId}`（更早版本写入，`resolveNoteLinkTargetIds` 至今兼容）
 *
 * ID 段的字符集与 `database.cjs` 的 `resolveNoteLinkTargetIds` **必须一致**（排除引号、尖括号、
 * 空白与右括号），否则 Markdown 的 `](…)` 与 HTML 的 `href="…"` 两种承载形式会截断不一致，
 * 出现「关系表认得出、重写却漏掉」的错位。
 */
const LOCAL_NOTE_LINK_PATTERN =
  /(?:https:\/\/xinyue-note\.local\/|xinyue-notes:\/\/note\/)([^"'<>\s)]+)/g

/**
 * 解码地址里的笔记 ID，转义非法时原样返回。
 *
 * @param {string} raw 地址中的原始 ID 片段。
 * @returns {string} 解码后的笔记 ID。
 */
function decodeLinkId(raw) {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * 把正文里的本机笔记地址重写成网页版地址。
 *
 * 与「同步时改写」无关：这里是用户主动触发的存量清理。规则：
 * - 目标笔记存在且有 `serverId`，且配置了网页地址 → 换成 `{webBaseUrl}/notes/{serverId}`；
 * - 目标笔记不存在（已删除/已彻底删除）→ 保持原样并计入 `missing`；
 * - 目标笔记存在但没同步到云端（无 `serverId`）→ 保持原样并计入 `unsynced`；
 * - 没有配置网页地址 → 保持原样并计入 `noWebBase`。
 *
 * 🔴 **围栏代码块内的内容原样跳过**：那里可能是用户写的示例、文档或配置片段，
 * 一起替换就等于把用户的正文改坏。未闭合的围栏同样按代码块处理（宁可少改）。
 *
 * ⚠️ 只处理 URL 形式的链接，**不碰嵌入卡片** `data-xynote-embed="note:{id}"`
 * —— 卡片用的是本地 ID，换掉反而会让卡片失去目标。
 *
 * @param {string} content 笔记正文（Markdown 原文）。
 * @param {{ resolveTarget?: (noteId: string) => { id: string, serverId: string | null } | null, webBaseUrl?: string }} [options] 解析与配置。
 * @returns {{
 *   content: string,
 *   total: number,
 *   changed: number,
 *   missing: number,
 *   unsynced: number,
 *   noWebBase: number,
 *   changedTargets: string[]
 * }} 重写结果；`changed` 为 0 时 `content` 与传入值完全一致。
 */
function rewriteLocalNoteLinksInContent(content, options = {}) {
  const source = String(content || "")
  const webBaseUrl = String(options.webBaseUrl || "").replace(/\/+$/, "")
  const resolveTarget = options.resolveTarget
  const result = {
    content: source,
    total: 0,
    changed: 0,
    missing: 0,
    unsynced: 0,
    noWebBase: 0,
    changedTargets: []
  }
  // 一次快速预筛：绝大多数正文不含本机地址，省掉整篇切分与重建。
  if (!source.includes("xinyue-note.local") && !source.includes("xinyue-notes://note/")) {
    return result
  }

  const changedTargets = new Set()
  const rewritten = splitFencedCodeSegments(source)
    .map((segment) => {
      if (segment.code) return segment.text
      return segment.text.replace(LOCAL_NOTE_LINK_PATTERN, (match, rawId) => {
        result.total += 1
        const targetId = decodeLinkId(rawId)
        const target = typeof resolveTarget === "function" ? resolveTarget(targetId) : null
        if (!target) {
          result.missing += 1
          return match
        }
        if (!target.serverId) {
          result.unsynced += 1
          return match
        }
        if (!webBaseUrl) {
          result.noWebBase += 1
          return match
        }
        result.changed += 1
        changedTargets.add(targetId)
        return `${webBaseUrl}/notes/${encodeURIComponent(String(target.serverId))}`
      })
    })
    .join("\n")

  // 没有可替换的地址时保留原文，避免「原样重建」引入不可见的空白差异。
  if (result.changed === 0) return result
  result.content = rewritten
  result.changedTargets = [...changedTargets]
  return result
}

/**
 * 嵌入卡的开标签形态（捕获组：1=到 data-xynote-embed 为止的前缀、2=引号、3=本机 ID、4=其余属性）。
 *
 * 与 `data-transfer.cjs` / `MarkdownVisualEditor.vue` 里识别嵌入卡的正则同口径：
 * `<div … data-xynote-embed="note:<id>" …>`。属性值内含 `>` 的极端写法不支持
 * （既有各处正则同样不支持），属已知边界。
 */
const EMBED_OPEN_TAG_PATTERN =
  /<div\b((?:[^>]*?\s)?data-xynote-embed=(["'])note:([^"']+)\2)([^>]*)>/gi

/** 判断一段开标签里是否已经有跨端标识属性。 */
const EMBED_SERVER_ATTR_PATTERN = /\bdata-xynote-embed-server=/i

/**
 * 给正文里的嵌入卡片补上**跨端标识** `data-xynote-embed-server="{serverId}"`。
 *
 * 为什么需要它：嵌入卡以本机 uuid 承载（`data-xynote-embed="note:{localId}"`），网页端只认
 * 服务端数字主键。新插入的卡片会直接带上跨端标识，而**存量卡片**没有，需要用户主动跑一次回填，
 * 网页端才能渲染（否则只能降级成占位）。设计见
 * docs/specs/2026-10-12-note-embed-web-render.md。
 *
 * 规则：
 * - **只在缺失时补**：已有 `data-xynote-embed-server` 的卡片原样跳过（幂等，重复跑 changed=0）；
 * - **不改** `data-xynote-embed` 的值（本地 ID 是桌面端的解析键，换掉卡片就失去目标）；
 * - 目标查不到（已删除）→ 计入 `missing`；查得到但没同步 → 计入 `unsynced`；两者都原样保留；
 * - **围栏代码块内原样跳过**（与链接改写同口径，宁可少改）；
 * - 一条都没补上时，返回的 `content` 与入参**逐字节一致**。
 *
 * @param {string} content 笔记正文（Markdown 原文）。
 * @param {{ resolveTarget?: (noteId: string) => { id: string, serverId: string | null } | null }} [options] 解析器。
 * @returns {{
 *   content: string,
 *   total: number,
 *   changed: number,
 *   missing: number,
 *   unsynced: number,
 *   alreadyFilled: number,
 *   changedTargets: string[]
 * }} 回填结果。
 */
function fillEmbedServerIdsInContent(content, options = {}) {
  const source = String(content || "")
  const resolveTarget = options.resolveTarget
  const result = {
    content: source,
    total: 0,
    changed: 0,
    missing: 0,
    unsynced: 0,
    alreadyFilled: 0,
    changedTargets: []
  }
  // 快速预筛：绝大多数正文不含嵌入卡。
  if (!source.includes("data-xynote-embed=")) return result

  const changedTargets = new Set()
  const filled = splitFencedCodeSegments(source)
    .map((segment) => {
      if (segment.code) return segment.text
      return segment.text.replace(EMBED_OPEN_TAG_PATTERN, (match, prefix, quote, rawId, rest) => {
        result.total += 1
        if (EMBED_SERVER_ATTR_PATTERN.test(match)) {
          result.alreadyFilled += 1
          return match
        }
        const targetId = decodeLinkId(rawId)
        const target = typeof resolveTarget === "function" ? resolveTarget(targetId) : null
        if (!target) {
          result.missing += 1
          return match
        }
        if (!target.serverId) {
          result.unsynced += 1
          return match
        }
        result.changed += 1
        changedTargets.add(targetId)
        // 紧跟在 data-xynote-embed 之后插入，其余属性（title 等）原样保留；
        // 引号沿用卡片原本的写法（单双引号都能被两端解析）。
        return `<div${prefix} data-xynote-embed-server=${quote}${String(target.serverId)}${quote}${rest}>`
      })
    })
    .join("\n")

  if (result.changed === 0) return result
  result.content = filled
  result.changedTargets = [...changedTargets]
  return result
}

module.exports = {
  LOCAL_NOTE_LINK_PATTERN,
  rewriteLocalNoteLinksInContent,
  fillEmbedServerIdsInContent
}
