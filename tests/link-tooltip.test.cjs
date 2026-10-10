/**
 * 链接气泡（Crepe 的 `Feature.LinkTooltip`）—— 行为接线 + 美化覆写 + 编辑浮层接管。
 *
 * ## 为什么单独一个文件
 *
 * 气泡**不是自研组件**：DOM（`.milkdown-link-preview > .link-preview > 图标 / URL / 图标`）、
 * 图标、以及**左侧槽位点下去就是复制**这件事，全在 Crepe 里。项目只能从三个窄口子进去：
 * `style.css` 的样式覆写、`featureConfigs[LinkTooltip]` 那几个配置项、以及把
 * `linkTooltipAPI`（addLink / editLink）覆写成自研的编辑浮层。这个文件把三边都钉住。
 *
 * ## 每条断言对应一个静默失效的坑
 *
 * | 坑 | 现象 | 守卫 |
 * |---|---|---|
 * | 气泡内的链接被 `handleEditorLinkClick` 当正文链接吞掉 | 点 URL 什么都不发生（默认行为也没了） | 断言 `insideLinkTooltip` 进 `shouldOpenLink` |
 * | 抢「打开」时挂在**冒泡**阶段 | 复制先跑完 → 链接进了剪贴板却没跳转 | 断言 `addEventListener(..., true)` 捕获阶段 |
 * | 抢的时候忘了 `stopPropagation` | 打开 + 复制同时发生（静默覆盖用户剪贴板） | 断言先掐传播再触发 |
 * | 删掉标记 span | 「打开 / 复制」再也分不开（两个按钮变成一个槽位的复制） | 断言两个标记类名 |
 * | 把 URL 节点从 DOM 里删掉 | 「打开」按钮点空（它靠 `a.link-display.click()` 复用分流） | 断言只 `display: none` + 处理器仍点它 |
 * | 覆写特异性不够 | 改了没生效（Crepe 自带同款规则是 4 个类） | 断言选择器带整条 `> .link-preview >` 链 |
 * | 覆写里写死颜色 | 暗色主题下气泡白底白字 | 配色只允许走 var() |
 * | 忘了抬 z-index | 链接贴顶栏时气泡被顶栏吃掉（顶栏 20 > 气泡 10） | 断言 z-index: 30 |
 * | 忘了覆写 `linkTooltipAPI` | 「编辑」点开还是 Crepe 那条光秃秃输入框（两套 UI 并存） | 断言 addLink / editLink 都转给 `openLinkEditor` |
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const readSource = (filePath) => readFileSync(resolve(projectRoot, filePath), 'utf8')

const EDITOR = 'src/components/MarkdownVisualEditor.vue'
const POPOVER = 'src/components/LinkEditPopover.vue'
const STYLE = 'src/style.css'

/**
 * 取 `src/style.css` 里链接气泡的那一段覆写（从分节注释到 `.markdown-outline`）。
 *
 * ⚠️ 返回前**剥掉注释**：这段开头的说明文字里会引用 `.milkdown-link-edit` / 十六进制色
 * 这类「已废弃」的名字来交代来历，不剥的话 `doesNotMatch` 会被自己的注释绊倒。
 */
function readLinkTooltipStyleBlock() {
  const css = readSource(STYLE)
  const start = css.indexOf('/* ── 链接气泡')
  const end = css.indexOf('.markdown-outline {', start)
  assert.ok(start >= 0 && end > start, '应能找到链接气泡的样式覆写段')
  return css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '')
}

test('链接气泡左槽位换成「打开（带文字）/ 复制」两个按钮', () => {
  const source = readSource(EDITOR)

  assert.match(
    source,
    /const LINK_TOOLTIP_ACTIONS_ICON = `[\s\S]*?xynote-link-tooltip-open[\s\S]*?xynote-link-tooltip-copy[\s\S]*?`/,
    '图标常量里应同时有「打开」与「复制」两个标记 span（它们是分流唯一锚点）'
  )
  // URL 文本已经拿掉，只剩图标就看不出哪个是主操作，所以「打开」必须带文字标签。
  assert.match(
    source,
    /xynote-link-tooltip-open[\s\S]{0,400}?xynote-link-tooltip-open-label">打开</,
    '「打开」按钮里应有「打开」文字标签（在图标右侧）'
  )
  assert.match(
    source,
    /\[Crepe\.Feature\.LinkTooltip\]: \{[\s\S]*?linkIcon: LINK_TOOLTIP_ACTIONS_ICON[\s\S]*?\}/,
    '图标常量必须真的接进 LinkTooltip 配置（否则气泡里还是 Crepe 默认的单复制按钮）'
  )
  assert.match(
    source,
    /onCopyLink: \(\) => showFeedback\('链接已复制'\)/,
    '复制要给反馈 —— Crepe 默认的 onCopyLink 是空函数，点了没有任何提示'
  )
})

test('「打开」按钮必须走捕获阶段抢在 Crepe 的复制之前', () => {
  const source = readSource(EDITOR)

  assert.match(
    source,
    /addEventListener\('pointerdown', handleLinkTooltipPointerDown, true\)/,
    '⚠️ 必须挂在捕获阶段：Crepe 给 .link-icon 挂的是它自己的 onPointerdown（复制），' +
      '两者同节点、冒泡阶段才动手复制已经跑完了'
  )
  assert.match(
    source,
    /removeEventListener\('pointerdown', handleLinkTooltipPointerDown, true\)/,
    '卸载时要连同 capture 参数一起摘掉（否则监听会残留）'
  )
  // 先掐传播再触发：反过来就是「打开 + 静默复制」两份副作用。
  assert.match(
    source,
    /function handleLinkTooltipPointerDown\(event: PointerEvent\): void \{[\s\S]*?closest\('\.xynote-link-tooltip-open'\)[\s\S]*?event\.preventDefault\(\)[\s\S]*?event\.stopPropagation\(\)[\s\S]*?a\.link-display'\)\s*\n?\s*\?\.click\(\)/
  )
})

test('气泡内的链接点击一律视为打开（不要求修饰键）', () => {
  const source = readSource(EDITOR)

  assert.match(
    source,
    /const insideLinkTooltip = Boolean\(anchor\?\.closest\('\.milkdown-link-preview'\)\)/,
    '要按「是否在链接气泡里」分流'
  )
  assert.match(
    source,
    /const shouldOpenLink = insideLinkTooltip\s*\n\s*\|\| previewMode\.value/,
    '气泡内的链接必须进 shouldOpenLink —— 否则点击被吞、什么都不发生'
  )
  assert.match(
    source,
    /event\.target\.closest<HTMLAnchorElement>\('a\[href\]'\)/,
    '判据必须是 `closest(\'a[href]\')`：气泡里的编辑 / 删除按钮不是 <a>，天然不受影响'
  )
})

test('URL 文本只隐藏、不删节点（「打开」按钮靠它复用正文链接的分流）', () => {
  const block = readLinkTooltipStyleBlock()

  assert.match(
    block,
    /\.link-preview > \.link-display \{ display: none; \}/,
    'URL 文本应整条收起（地址改由编辑浮层的「地址」一行承担）'
  )
  assert.doesNotMatch(
    block,
    /\.link-display \{[\s\S]{0,120}?width: 220px;/,
    '旧的 220px URL 显示宽度已废弃，不许回来'
  )
  assert.match(
    readSource(EDITOR),
    /\?\.querySelector<HTMLAnchorElement>\('a\.link-display'\)/,
    '⚠️ 隐藏 URL **不能**顺手把节点删掉：「打开」按钮点击的就是这个 <a>'
  )
})

test('链接气泡的美化覆写：只走变量、特异性够、层级兜底', () => {
  const block = readLinkTooltipStyleBlock()

  // 层级兜底：顶栏被项目抬到 20，Crepe 只给气泡 10。
  assert.match(
    block,
    /\.milkdown-link-preview \{ z-index: 30; \}/,
    '气泡要抬到 30 —— 链接贴顶栏时不许被吃掉'
  )
  // 与选中气泡同一套语系。
  assert.match(block, /border-radius: 12px;/)
  assert.match(block, /border: 1px solid var\(--milkdown-toolbar-divider\);/)
  assert.match(block, /background: var\(--crepe-color-surface\);/)
  // 特异性：Crepe 自带的同款规则是 4 个类，必须靠整条链多一层。
  assert.match(
    block,
    /\.milkdown-editor-root \.milkdown \.milkdown-link-preview > \.link-preview > \.link-display \{/,
    '覆写要带完整 `> .link-preview >` 链，否则和 Crepe 同分、靠声明顺序决胜（顺序不受控）'
  )
  // 左槽位退化成透明容器：hover 底色只落在里面两个按钮上。
  assert.match(
    block,
    /\.link-preview > \.link-icon \{ width: auto; padding: 0; gap: 2px; background: transparent; \}/
  )
  assert.match(block, /\.link-preview > \.link-icon:hover \{ background: transparent; \}/)
  // 方块按钮 30px、图标 19px。
  assert.match(block, /width: 30px;/)
  assert.match(block, /height: 30px;/)
  assert.match(block, /width: 19px; height: 19px;/)
  // 「打开」宽度自适应 + 标签样式；「复制 / 编辑 / 删除」仍是方块。
  assert.match(
    block,
    /\.xynote-link-tooltip-open \{ width: auto; gap: 5px; padding: 0 9px; color: var\(--milkdown-toolbar-icon\); \}/
  )
  assert.match(block, /\.xynote-link-tooltip-open-label \{ font-size: 13px; font-style: normal;/)
  // 配色只允许走 var()（正文不写裸 hex）。
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, '覆写段内不得出现裸十六进制颜色（暗色主题会白底白字）')
  // Crepe 自带编辑气泡已被接管 → 它的覆写规则属于死代码，不许回来。
  assert.doesNotMatch(block, /\.milkdown-link-edit/, 'Crepe 自带编辑气泡的覆写已是死代码，应已删除')
  assert.doesNotMatch(block, /\.link-edit > \.input-area/, '「一行光秃秃输入框」的样式已废弃')
  assert.doesNotMatch(block, /\.confirm/, '已接管的编辑气泡不渲染确认按钮，样式一并清掉')
})

test('链接气泡的暗色主题只需要投影分支', () => {
  const css = readSource(STYLE)
  const darkStart = css.indexOf('@scope (html[data-theme="dark"])')
  assert.ok(darkStart > 0, '应能找到暗色主题块')
  const dark = css.slice(darkStart)

  assert.match(
    dark,
    /\.milkdown-link-preview > \.link-preview \{ box-shadow:/,
    '暗色下只重写投影（其余配色由 --crepe-color-* 自动跟随）'
  )
  assert.doesNotMatch(dark, /\.milkdown-link-edit/, '已接管的编辑气泡不该再有暗色分支')
  for (const variable of [
    '--crepe-color-surface:',
    '--crepe-color-on-surface:',
    '--crepe-color-primary:',
    '--crepe-color-hover:',
    '--milkdown-toolbar-divider:',
    '--milkdown-toolbar-icon:'
  ]) {
    assert.ok(
      dark.includes(variable),
      `暗色块里应重新赋值过 ${variable}（链接气泡覆写依赖它）`
    )
  }
})

test('Crepe 的链接编辑气泡被接管：addLink / editLink 都转给自研浮层', () => {
  const source = readSource(EDITOR)

  assert.match(
    source,
    /context\.update\(linkTooltipAPI\.key, \(api\) => \(\{[\s\S]*?addLink: \(from, to\) => openLinkEditor\(null, from, to\)[\s\S]*?editLink: \(mark, from, to\) => openLinkEditor\(mark, from, to\)[\s\S]*?\}\)\)/,
    '⚠️ 「编辑」按钮与选中气泡里的「链接」按钮走的是同一个 API，必须一起覆写，' +
      '否则两条入口会退化成两套长相不同的编辑界面'
  )
  assert.match(
    source,
    /setLinkTooltipMode = \(mode\) => \{\s*\n\s*context\.update\(linkTooltipState\.key, \(state\) => \(\{ \.\.\.state, mode \}\)\)\s*\n\s*\}/,
    "要用 Crepe 自己的 mode='edit' 机制：它会顺手隐藏预览气泡并禁止悬停再弹回来"
  )
  // 覆写必须在 create() 之后，否则会被插件安装时写入的实现盖掉。
  const createAt = source.indexOf('await crepe.create()')
  const overrideAt = source.indexOf('context.update(linkTooltipAPI.key')
  assert.ok(createAt > 0 && overrideAt > createAt, '覆写必须发生在 crepe.create() 之后')
})

test('保存 / 取消链接的口径写死在源码里', () => {
  const source = readSource(EDITOR)

  // 标题改写链接文字；地址清空 = 摘链接。
  assert.match(source, /const href = payload\.href\.trim\(\)/)
  assert.match(source, /if \(!href\) \{\s*\n\s*removeLinkEdit\(\)\s*\n\s*return\s*\n\s*\}/, '地址清空应等同「取消链接」')
  // ⚠️ 附件链接的 mime / 大小存在 mark.title 里，重建 mark 时必须带上。
  assert.match(
    source,
    /const keptTitle = typeof state\.mark\?\.attrs\.title === 'string' \? state\.mark\.attrs\.title : null/,
    '附件链接的 title 属性要原样沿用（丢了附件就退化成普通外链）'
  )
  assert.match(source, /title: keptTitle \}\)/, '重建链接 mark 时要把 title 带回去')
  // 反馈
  assert.match(source, /showFeedback\('链接已更新'\)/)
  assert.match(source, /showFeedback\('已取消链接'\)/)
})

test('编辑浮层接进模板并挂上三个出口', () => {
  const source = readSource(EDITOR)

  assert.match(
    source,
    /<LinkEditPopover\s*\n\s*v-if="linkEditState"[\s\S]*?@save="saveLinkEdit"[\s\S]*?@remove="removeLinkEdit"[\s\S]*?@close="closeLinkEditor"[\s\S]*?\/>/,
    '浮层要随 linkEditState 装卸，并把 保存 / 取消链接 / 关闭 三个出口接上'
  )
  assert.match(
    source,
    /:can-remove="Boolean\(linkEditState\.mark\)"/,
    '新建链接时没有可取消的链接，按钮要隐藏'
  )
  assert.match(
    source,
    /unbindLinkEditTracking\(\)\s*\n\s*linkEditState\.value = null\s*\n\s*linkEditEditorView = null\s*\n\s*setLinkTooltipMode = null/,
    '卸载编辑器时要一并收走浮层状态与滚动/缩放监听'
  )
  assert.ok(readSource(POPOVER).length > 0)
})
