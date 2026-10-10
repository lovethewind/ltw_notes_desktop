/**
 * 选中气泡（Crepe 的 Toolbar，选区上方浮出的 B/I/S 工具条）——美化覆写 + 内嵌字号下拉。
 *
 * ## 为什么单独一个文件
 *
 * 气泡**不是自研组件**，是 Crepe 的 `Feature.Toolbar`：DOM 结构、图标、点击时机全在 Crepe 里，
 * 项目只能从两个窄口子进去 —— `style.css` 的样式覆写，和 `featureConfigs[Toolbar].buildToolbar`
 * 这个官方扩展点。这个文件就把这两个口子的约束钉住。
 *
 * ## 每条断言对应一个静默失效的坑
 *
 * | 坑 | 现象 | 守卫 |
 * |---|---|---|
 * | 覆写特异性不够 | 改了没生效（Crepe 的 `.milkdown .milkdown-toolbar` 同分但更靠后） | 选择器带 `.milkdown-editor-root` 前缀 |
 * | 覆写里写死颜色 | 暗色主题下气泡白底白字 | 配色只允许走 var() |
 * | 漏挂 `buildToolbar` | 气泡里根本没有「字号」按钮 | 断言接线 |
 * | 删掉标记 span | 按钮找不回来、宽度也放不开（`onRun` 拿不到事件对象） | 断言 span + `:has()` |
 * | 用 pointerdown 开后又被 click 关 | 「点了没反应」 | 断言捕获阶段守卫 |
 * | 面板没进 `toolbarMenuPanels` | 切预览/失焦后弹层赖在页面上 | 断言注册 |
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const readSource = (filePath) => readFileSync(resolve(projectRoot, filePath), 'utf8')

const EDITOR = 'src/components/MarkdownVisualEditor.vue'
const STYLE = 'src/style.css'

/** 取 `src/style.css` 里选中气泡的那一段覆写（从分节注释到 `.markdown-outline`）。 */
function readToolbarStyleBlock() {
  const css = readSource(STYLE)
  const start = css.indexOf('/* ── 选中气泡')
  const end = css.indexOf('.markdown-outline {', start)
  assert.ok(start >= 0 && end > start, '应能找到选中气泡的样式覆写段')
  return css.slice(start, end)
}

/* ------------------------------------------------------------------ *
 * 1. 样式覆写
 * ------------------------------------------------------------------ */

test('选中气泡：覆写必须比 Crepe 自带规则更具体，否则改了不生效', () => {
  const css = readSource(STYLE)

  // Crepe 自带的是 `.milkdown .milkdown-toolbar`（2 类）。同为 2 类时靠声明顺序决胜，
  // 而 Crepe 的主题 CSS 由组件库注入，顺序不受控 —— 必须靠多一级类名稳赢。
  // ⚠️ 这里只钉「选择器 + 有 padding」，不钉属性顺序：块的第一个属性会随功能增删而变。
  assert.match(
    css,
    /\.milkdown-editor-root \.milkdown \.milkdown-toolbar \{[^}]*padding:/,
    '气泡覆写应带 .milkdown-editor-root 前缀提升特异性'
  )
  assert.match(
    css,
    /\.milkdown-editor-root \.milkdown \.milkdown-toolbar \.toolbar-item \{/,
    '按钮尺寸/圆角也要覆写（默认 32px 方块 + 4px 圆角）'
  )
  assert.match(
    css,
    /\.milkdown-editor-root \.milkdown \.milkdown-toolbar \.divider \{/,
    '分隔线也要覆写（默认 24px 高 + 10px 外边距，撑得整条很松）'
  )
})

test('选中气泡：配色一律走主题变量（写死颜色会让暗色主题崩掉）', () => {
  const block = readToolbarStyleBlock()

  // 只有投影允许写字面量 rgba（暗色下需单独降亮度，已由暗色块接管）。
  // 其余全部必须走变量 —— --crepe-color-* 与 --milkdown-toolbar-divider 在暗色块里
  // 已各自重新赋过值，这样一份规则同时服务两套主题。
  const hexColors = block.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
  assert.deepEqual(hexColors, [], `气泡覆写里不应出现写死的十六进制颜色：${hexColors.join(', ')}`)

  for (const token of [
    'var(--crepe-color-surface)',
    'var(--crepe-color-hover)',
    'var(--crepe-color-selected)',
    'var(--crepe-color-primary)',
    'var(--milkdown-toolbar-divider)'
  ]) {
    assert.ok(block.includes(token), `气泡覆写应使用 ${token}`)
  }
})

test('选中气泡：暗色主题只需补投影，其余靠变量自动跟随', () => {
  const css = readSource(STYLE)

  // 若哪天有人给气泡加暗色分支，说明有颜色没走变量 —— 这条会提醒回头补第一条守卫。
  assert.match(
    css,
    /选中气泡只有投影需要暗色分支[\s\S]{0,200}?\.milkdown-toolbar \{ box-shadow: 0 14px 38px rgba\(0,0,0/,
    '暗色块应只覆写气泡投影'
  )
})

test('选中气泡：「字号」触发器靠 :has() 放宽宽度（按钮属性写死，挂不了 class）', () => {
  const block = readToolbarStyleBlock()

  assert.match(block, /\.toolbar-item:has\(\.xynote-fs-trigger\) \{/, '应用 :has() 反选到按钮本身')
  assert.match(block, /\.toolbar-item:has\(\.xynote-fs-trigger\) \{[^}]*width: auto/, '应把固定 30px 宽度放开')
  assert.match(block, /svg\.xynote-fs-caret \{ width: 13px/, '小箭头要单独缩小（默认被 .toolbar-item svg 拉到 19px）')
})

/* ------------------------------------------------------------------ *
 * 2. 图标里的标记 span：DOM 反查与 CSS 定位的唯一锚点
 * ------------------------------------------------------------------ */

test('选中气泡：「字号」图标必须带 xynote-fs-trigger 标记（删了按钮就找不回来）', () => {
  const source = readSource(EDITOR)

  // Crepe 的 Toolbar 组件渲染的是属性写死的 `button.toolbar-item`
  //（只有 class / type，挂不了自定义 class 或 data-*），`onRun(ctx)` 也拿不到事件对象。
  // 所以只能靠 `item.icon` 这段 HTML 里的标记 span 当锚点。
  assert.match(source, /<span class="xynote-fs-trigger">/, '图标里应有标记 span')
  assert.match(
    source,
    /querySelector<HTMLElement>\('\.milkdown-toolbar \.xynote-fs-trigger'\)[\s\S]{0,120}?closest<HTMLElement>\('\.toolbar-item'\)/,
    '应由标记 span 反查回按钮'
  )
  assert.match(source, /item\?\.querySelector\('\.xynote-fs-trigger'\)/, '点击守卫也要认这个标记')
})

/* ------------------------------------------------------------------ *
 * 3. buildToolbar 接线
 * ------------------------------------------------------------------ */

test('选中气泡：经官方 buildToolbar 扩展点把「字号」挂进 formatting 组', () => {
  const source = readSource(EDITOR)

  assert.match(source, /\[Crepe\.Feature\.Toolbar\]: \{/, '应配置 Toolbar 特性')
  assert.match(source, /buildToolbar: \(builder\) => \{/, '应使用 buildToolbar（往气泡里加项的唯一正规入口）')
  assert.match(
    source,
    /builder\.getGroup\('formatting'\)\.addItem\('xynote-font-size', \{/,
    '字号应落在 formatting 组（与 B/I/S 同组，不额外插分隔线）'
  )
  assert.match(source, /icon: FONT_SIZE_TRIGGER_ICON,/, '应使用专用图标常量')
  // 气泡只在有选区时出现，所以 onRun 一定在 pointerdown 上下文里被调用 ——
  // 用 click 反而会因失焦丢掉 storedMarks。
  assert.match(source, /onRun: \(\) => toggleBubbleFontSizePanel\(\)/, 'onRun 应开合气泡字号面板')
  assert.match(
    source,
    /isInSet\(activeCtx\.get\(editorViewCtx\)\.state\.selection\.\$from\.marks\(\)\)/,
    '点亮态应与 B/I/S 同口径（看选区起点处的标记）'
  )
})

/* ------------------------------------------------------------------ *
 * 4. 面板复用与关闭路径
 * ------------------------------------------------------------------ */

test('选中气泡：字号面板与顶栏下拉共用同一份实现', () => {
  const source = readSource(EDITOR)

  // 两份实现迟早会漂移（一边补了 pointerdown 另一边忘了）。抽成 createFontSizePanel() 后
  // 全项目只应剩一处渲染 FONT_SCALE_STEPS。
  assert.match(source, /function createFontSizePanel\(\): HTMLDivElement \{/, '应有共用的面板工厂')
  const renders = source.match(/FONT_SCALE_STEPS\.forEach/g) ?? []
  assert.equal(renders.length, 1, `FONT_SCALE_STEPS 的渲染只应有一份，实际 ${renders.length} 份`)
  assert.match(source, /const panel = createFontSizePanel\(\)/, '顶栏下拉应复用面板工厂')
  assert.match(source, /toolbarMenuPanels\.set\(bubbleFontSizeHost, createFontSizePanel\(\)\)/, '气泡面板应复用同一工厂')
})

test('选中气泡：面板要进 toolbarMenuPanels，才能被既有路径一并收掉', () => {
  const source = readSource(EDITOR)

  // Crepe 的 Toolbar 每次选区变化都重渲染，自己往气泡里插的 DOM 会被 Vue 清掉，
  // 所以面板挂到 document.body；但收起逻辑（滚动、切预览、点空白、失焦）都跑在
  // closeToolbarMenus() 上，它按「宿主 → 面板」映射驱动 —— 必须注册进去，否则弹层会赖着不走。
  assert.match(source, /let bubbleFontSizeHost: HTMLDivElement \| null = null/, '应有宿主占位节点')
  assert.match(source, /bubbleFontSizeHost\.hidden = true/, '宿主必须不可见（面板本体是 portal 到 body 的）')
  assert.match(source, /document\.body\.append\(panel\)/, '面板应 portal 到 body')
  assert.match(source, /panel\.classList\.add\('is-portal-open'\)/, '应走既有的 portal 定位类')
  assert.match(source, /bubbleFontSizeHost = null/, '卸载时应释放宿主引用')
})

test('选中气泡：必须按「按下」的落点判定，不能按 click 的落点', () => {
  const source = readSource(EDITOR)

  // 展开动作在 pointerdown（Crepe 的 Toolbar 只监听 pointerdown），收起动作在 document 上
  // 常驻的 closeToolbarMenus（监听 click）。浏览器在 pointerdown 被 preventDefault 后仍会补
  // 一次 click —— 它冒泡到 document 就把刚打开的面板关掉了。
  // 该按钮由 Crepe 创建、挂不了监听，只能从 document 的**捕获阶段**拦（冒泡阶段太晚）。
  assert.match(
    source,
    /document\.addEventListener\('pointerdown', trackBubbleFontSizePointerDown, true\)/,
    '必须在捕获阶段记下按下的落点（要早于 Crepe 自己的按钮处理）'
  )
  assert.match(
    source,
    /document\.addEventListener\('click', guardBubbleFontSizeClick, true\)/,
    'click 守卫必须注册在 document 的捕获阶段'
  )
  assert.match(
    source,
    /document\.removeEventListener\('pointerdown', trackBubbleFontSizePointerDown, true\)/,
    '卸载时应摘掉按下跟踪（capture 标志要一致，否则摘不掉）'
  )
  assert.match(
    source,
    /document\.removeEventListener\('click', guardBubbleFontSizeClick, true\)/,
    '卸载时应摘掉 click 守卫'
  )
  assert.doesNotMatch(
    source,
    /document\.addEventListener\('click', guardBubbleFontSizeClick\)/,
    '不得注册成冒泡阶段（比 closeToolbarMenus 更晚，拦不住）'
  )

  // ⚠️⚠️ 本功能最贵的一条教训：判定只能看**按下**的落点。
  // `click` 的 target 是 mousedown 与 mouseup 的**最近公共祖先**，而面板就贴在按钮下方 8px ——
  // 真人松开时只要比按下时低 8px 以上，mouseup 就落进面板，target 从 BUTTON 直接变成 BODY，
  // 落点判定全部落空、面板当场被关（现象：「必须按住才在，一松手就没」）。
  assert.match(
    source,
    /function guardBubbleFontSizeClick\(event: MouseEvent\): void \{\s*if \(!bubbleFontSizeArmed\) return/,
    'click 守卫必须只看按下时打的标记'
  )
  assert.doesNotMatch(
    source,
    /function guardBubbleFontSizeClick[\s\S]{0,400}?event\.target/,
    'click 守卫里不得再读 event.target —— 一读落点就会在「松开时手抖」的场景静默失效'
  )

  // 按下时的判定仍必须落在「整个按钮」上：标记 span 只有 33px，按钮被 :has() 放宽到 43px，
  // 落在留白上时 event.target 是 button 本身，closest('.xynote-fs-trigger') 会落空
  // （span 是它的后代而非祖先）。
  assert.match(
    source,
    /function trackBubbleFontSizePointerDown[\s\S]{0,700}?closest\?\.<HTMLElement>\('\.milkdown-toolbar \.toolbar-item'\)/,
    '按下判定应先回到工具条按钮，不能只认图标里的标记 span（落点会在按钮留白上）'
  )
  assert.match(
    source,
    /bubbleFontSizeArmed = Boolean\(item\?\.querySelector\('\.xynote-fs-trigger'\)\)/,
    '只应认「字号」按钮，不能无差别吞掉所有 click'
  )
})

test('选中气泡：面板不许盖住触发按钮（盖住就点不回去，且松开必落在面板里）', () => {
  const block = readSource(EDITOR)

  // 面板 17 档、最高 320px（档位一多则面板内滚动，高度上限不变）；原来的「贴下方 + clamp 进窗口」在按钮位于窗口下半部时会把面板
  // 顶回去盖住按钮 —— 用户既没法再点按钮收起，松开鼠标时落点也注定落在面板里。
  assert.match(block, /const fitsBelow = rect\.bottom \+ gap \+ panelHeight <= window\.innerHeight - 12/, '应判断下方是否放得下')
  assert.match(block, /const fitsAbove = rect\.top - gap - panelHeight >= 12/, '应判断上方是否放得下')
  assert.match(
    block,
    /const top = fitsBelow \|\| !fitsAbove \? rect\.bottom \+ gap : rect\.top - gap - panelHeight/,
    '放不下时应翻到按钮上方，而不是把面板顶回来盖住按钮'
  )
})

/* ------------------------------------------------------------------ *
 * 5. 顶栏避让：气泡不许被 sticky 顶栏吃掉上半截
 * ------------------------------------------------------------------ */

test('选中气泡：层级必须高于顶栏（否则气泡被 sticky 顶栏画在下面）', () => {
  const css = readSource(STYLE)

  // 顶栏是 `position: sticky` 且在**滚动容器内部**，floating-ui 的 `flip()` 只按裁剪祖先
  // 算空间 → 它占的那 48px 照样算「上方有空间」，气泡不会被翻转、直接插进顶栏里
  // （实测 1020×700 首行选区：顶栏 bottom=242、气泡 top=226.5，被盖 15.5px）。
  // 层级这一层是**兜底**：真正合理的落点由 startBubbleTopBarAvoidance() 给。
  const bubbleZ = Number(/\.milkdown-editor-root \.milkdown \.milkdown-toolbar \{[^}]*z-index: (\d+)/.exec(css)?.[1])
  const topBarZ = Number(/\.milkdown-editor-root \.milkdown \.milkdown-top-bar \{[^}]*z-index: (\d+)/.exec(css)?.[1])
  assert.ok(Number.isFinite(bubbleZ), '气泡覆写里应显式声明 z-index（Crepe 默认 10，会被顶栏的 20 压住）')
  assert.ok(Number.isFinite(topBarZ), '顶栏覆写里应有 z-index')
  assert.ok(
    bubbleZ > topBarZ,
    `气泡 z-index(${bubbleZ}) 必须大于顶栏(${topBarZ})，否则气泡仍会被顶栏画在下面`
  )
})

test('选中气泡：撞上顶栏要翻到选区下方，且不允许自激', () => {
  const source = readSource(EDITOR)

  // 接线：创建编辑器之后启动；卸载时两个观察器都要断开。
  assert.match(source, /startBubbleTopBarAvoidance\(\)/, '创建编辑器后应启动顶栏避让')
  assert.match(
    source,
    /\{ attributes: true, attributeFilter: \['style'\] \}/,
    '必须盯气泡的 style 属性 —— floating-ui 每写一次坐标就是唯一可靠的时机'
  )
  assert.match(source, /bubbleAvoidObserver\?\.disconnect\(\)/, '卸载应断开避让观察器')
  assert.match(source, /bubbleAppearObserver\?\.disconnect\(\)/, '卸载应断开「等气泡出现」的观察器')

  // 只有**确实压住顶栏**才动手，其余原样放行（不能把 floating-ui 的原生落点全改掉）。
  assert.match(
    source,
    /if \(rect\.top >= barRect\.bottom - 0\.5\) return/,
    '没压住顶栏必须原样放行'
  )
  // 首选：翻到选区下方 10px（与 floating-ui 的 offset 同量级）；拿不到选区时贴顶栏下沿兜底。
  assert.match(source, /selectionRect\.bottom \+ 10/, '应优先翻到选区下方')
  assert.match(source, /barRect\.bottom \+ gap/, '选区拿不到时应退化成贴顶栏下沿')
  assert.match(source, /targetTop = Math\.min\(targetTop, window\.innerHeight - gap - rect\.height\)/, '不许掉出视口下沿')
  // ⚠️ 必须用增量算位移：内联 top 是相对气泡 offsetParent（实测是 `.milkdown`）的，
  // 自己拼绝对坐标要处理它的边框 / 滚动偏移，增量法天然免疫。
  assert.match(source, /const nextTop = currentTop \+ \(targetTop - rect\.top\)/, '位移要用增量算')
  // ⚠️ 小于 0.5px 不许写：自己写的 top 会再触发一次观察器回调，阈值是唯一的止血点。
  assert.match(
    source,
    /if \(Math\.abs\(nextTop - currentTop\) < 0\.5\) return/,
    '小于 0.5px 不许写，否则会与观察器自激'
  )
})
