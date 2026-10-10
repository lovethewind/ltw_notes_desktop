import DOMPurify from 'dompurify'

/**
 * 预览正文的清洗入口。
 *
 * 三个渲染入口共用同一份配置：笔记预览（MarkdownVisualEditor）、
 * 外部文件预览（MarkdownSourceEditor）、嵌入卡片展开区（NoteEmbedCard）。
 * 分开各写一遍 `DOMPurify.sanitize`，协议白名单的口径就会散 —— 本次的图片断链就是这么来的。
 *
 * 刻意不放进 `markdown-preview.ts`：那个模块是纯字符串逻辑（单测在 node 里直接跑），
 * DOMPurify 依赖 DOM，混进去会把这个边界弄坏。
 */

/**
 * 放行本应用私有资产协议 `xinyue-asset:`。
 *
 * DOMPurify 的默认 URI 白名单（`IS_ALLOWED_URI`）不含它，于是正文里的本地图片
 * `![图](xinyue-asset://local/<id>)` 会被判定为「不可信地址」而**整条剥掉 `src`**
 * （走的是 `_removeAttribute` 分支，元素留下、属性没了）——预览里就只剩一个断图。
 * 编辑器不经这条清洗链路，同一篇笔记在编辑模式下完全正常，切到预览才全断。
 *
 * 该协议由主进程 `registerLocalAssetProtocol()` 独家服务，只读附件目录，放行是安全的。
 *
 * ⚠️ 正则抄自 DOMPurify 默认值（`dist/purify.es.mjs` 的 `IS_ALLOWED_URI`），
 * 仅追加 `xinyue-asset` 一个协议。升级 dompurify 时需复核一次，
 * 免得漏掉上游新增的安全修正。
 */
export const PREVIEW_ALLOWED_URI_REGEXP =
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|xinyue-asset):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i

/**
 * 清洗预览正文 HTML。
 *
 * :param html: 渲染后的 HTML（未清洗）。
 * :return: 可安全交给 `v-html` 的 HTML。
 */
export function sanitizePreviewHtml(html: string): string {
  return DOMPurify.sanitize(html, { ALLOWED_URI_REGEXP: PREVIEW_ALLOWED_URI_REGEXP })
}
