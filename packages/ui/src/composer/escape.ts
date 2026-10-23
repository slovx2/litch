// 回合在跑时按两下 Esc 打断（照 Codex 桌面端：第一下只上膛，2 秒内再按一下才停）。
// 输入框里有没有字、焦点在不在输入框都一样；别处认了的 Esc（浮层、菜单、单子、请求卡片、改名框……）不算。
// 键盘只听一处（窗口上），按下时交给“这一下归它”的那个输入区：
// 事件落在某个 [data-esc-scope] 里（侧面板的子代理页），归那一块里的输入区；别处的归主区域的输入区。
// 这里只放判断和分发，上膛的状态和提示在 Composer.tsx。

/** 两下 Esc 之间最多隔多久 */
export const ESC_WINDOW = 2000

/** 上膛：在哪个回合里、什么时候按的第一下 */
export interface EscArm {
  turnId: string
  at: number
}

/** 回合在跑时又按了一下 Esc：已经在这个回合里上过膛、还没过时就停，否则（重新）上膛 */
export function escStep(arm: EscArm | null, turnId: string, now: number): 'arm' | 'stop' {
  return arm && arm.turnId === turnId && now - arm.at <= ESC_WINDOW ? 'stop' : 'arm'
}

/** 能打字的控件：这些地方的 Esc 是它们自己的（改名框、搜索框、地址栏、终端的输入区） */
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]'
/** 自己管 Esc 的一块：弹层、菜单、单子、终端、画布 */
const OWNERS =
  '[role="dialog"], [role="menu"], [role="listbox"], [role="application"], canvas, .xterm'

interface Closest {
  closest(selector: string): unknown
}

/**
 * 这一下 Esc 能不能拿来打断：别处已经认了的、输入法在组字的、带修饰键的、按住自动重复的不算；
 * 开着模态框（open 是“有没有打开的 dialog”）、焦点在弹层菜单里、在别的能打字的控件里（不是会话的输入框）也不算
 */
export function escapeFree(
  event: {
    key: string
    defaultPrevented: boolean
    isComposing: boolean
    keyCode: number
    repeat: boolean
    metaKey: boolean
    ctrlKey: boolean
    altKey: boolean
    shiftKey: boolean
    target: unknown
  },
  open: boolean,
): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented || event.repeat) return false
  if (event.isComposing || event.keyCode === 229) return false
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false
  if (open) return false
  const target = event.target as Partial<Closest> | null
  if (!target || typeof target.closest !== 'function') return true
  if (target.closest(OWNERS)) return false
  const editable = target.closest(EDITABLE) as Partial<Closest> | null
  return !editable || Boolean(editable.closest?.('textarea.cmp-text'))
}

interface Entry {
  /** 这个输入区的输入框：看它在哪一块里 */
  input: HTMLElement
  handle(event: KeyboardEvent): void
}

const entries = new Set<Entry>()

/** 这一下归谁：事件落在哪一块（[data-esc-scope]）里就归那一块里的；不在任何一块里的归不在块里的那个（主区域） */
export function ownerOf<T extends { input: Closest }>(
  entries: Iterable<T>,
  target: unknown,
): T | null {
  const node = target as Partial<Closest> | null
  const scope = node && typeof node.closest === 'function' ? node.closest('[data-esc-scope]') : null
  for (const entry of entries) {
    if ((entry.input.closest('[data-esc-scope]') ?? null) === scope) return entry
  }
  return null
}

const onKey = (event: KeyboardEvent) => {
  if (!escapeFree(event, document.querySelector('dialog[open]') !== null)) return
  ownerOf(entries, event.target)?.handle(event)
}

/** 回合在跑的输入区登记一下，返回撤销的办法。登记的都没了就不再听 */
export function listenEscape(entry: Entry): () => void {
  if (entries.size === 0) window.addEventListener('keydown', onKey)
  entries.add(entry)
  return () => {
    entries.delete(entry)
    if (entries.size === 0) window.removeEventListener('keydown', onKey)
  }
}
