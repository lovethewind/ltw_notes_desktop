/** 将 Electron 快捷键格式转换为当前平台的展示文本。 */
export function formatShortcut(value: string): string {
  return value
    .replace('CommandOrControl', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl')
    .replaceAll('Shift', '⇧')
    .replaceAll('Alt', navigator.platform.includes('Mac') ? '⌥' : 'Alt')
    .replaceAll('+', ' ')
}

/** 将带修饰键的键盘事件转换为 Electron 全局快捷键格式。 */
export function getShortcutFromEvent(event: KeyboardEvent): string | null {
  if (new Set(['Meta', 'Control', 'Shift', 'Alt']).has(event.key)) return null
  const modifiers: string[] = []
  if (event.metaKey || event.ctrlKey) modifiers.push('CommandOrControl')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')
  if (!modifiers.length) return null
  const aliases: Record<string, string> = {
    ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right'
  }
  const key = aliases[event.key] || (event.key.length === 1 ? event.key.toUpperCase() : event.key)
  return [...modifiers, key].join('+')
}

/** 判断键盘事件是否匹配 Electron 格式的应用内快捷键。 */
export function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.split('+').map((part) => part.toLocaleLowerCase())
  const expectedCommand = parts.includes('commandorcontrol')
  const expectedShift = parts.includes('shift')
  const expectedAlt = parts.includes('alt')
  const key = parts.find((part) => !['commandorcontrol', 'shift', 'alt'].includes(part))
  if (!key) return false
  return (event.metaKey || event.ctrlKey) === expectedCommand
    && event.shiftKey === expectedShift
    && event.altKey === expectedAlt
    && event.key.toLocaleLowerCase() === key.toLocaleLowerCase()
}
