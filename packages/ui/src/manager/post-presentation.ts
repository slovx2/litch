// 桌面和手机共用：开合只记在当前客户端进程，按设备、经理和帖子隔离，不写设备数据。
export function postViewKey(deviceId: string, managerId: string, id: string): string {
  return JSON.stringify([deviceId, managerId, id])
}
const folds = new Map<string, boolean>()
export function postCollapsed(key: string, fallback: boolean): boolean {
  return folds.get(key) ?? fallback
}
export function rememberPostCollapsed(key: string, collapsed: boolean): void {
  folds.set(key, collapsed)
}
export function postSummary(text: string): string {
  return (text.split('\n').find((line) => line.trim()) ?? '')
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .trim()
    .slice(0, 240)
}
export function hasTemporaryQuestions(messages: readonly { mode?: string }[]): boolean {
  // 未标模式的记录是原有临时追问；经理追问会显式标 manager。
  return messages.some((message) => message.mode !== 'manager')
}
export function questionMode(
  selected: 'manager' | 'temporary' | null,
  messages: readonly { mode?: string }[],
): 'manager' | 'temporary' {
  return selected ?? (hasTemporaryQuestions(messages) ? 'temporary' : 'manager')
}
export function submitQuestionOnEnter(event: {
  key: string
  shiftKey: boolean
  isComposing: boolean
  keyCode: number
}): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229
}
