// 受控页面在代理输入后自己打开新标签或弹窗（target=_blank、window.open）时，Chrome 会显示并激活
// 该窗口；在 macOS 上这会把 Chrome 变成前台应用。CDP 合成输入带用户激活，扩展 API 无法让这次打开
// 改为后台，而改写页面的 window.open / 链接又会破坏 opener 等语义（OAuth 弹窗依赖它）。
// 这里只识别“Chrome 原本不在前台，因受控标签刚打开的新页面而获得焦点”，交给宿主把前台还回去。

/** 代理输入后页面仍可凭用户激活打开新页面的时长，与 Chrome 的瞬时激活时长一致。 */
export const INPUT_ACTIVATION_MS = 5_000
/** 新页面创建到 Chrome 激活窗口的间隔上限；超出时视为用户自己切到 Chrome。 */
export const OPENED_FOCUS_MS = 2_000

export interface CreatedTab {
  id?: number
  openerTabId?: number
  windowId?: number
}
export interface LeasedTab {
  tabId: number
  leaseId: string
  windowId: number
}
interface Opened {
  at: number
  opener: number
  windowId: number | undefined
}

export class ForegroundWatch {
  /** 受控标签 → 最近一次代理输入的派发时间。 */
  private inputs = new Map<number, number>()
  /** 代理输入后不久由页面打开（有 opener）的新标签。 */
  private opened = new Map<number, Opened>()
  /** Chrome 是否持有系统焦点；未知时为 null，此时不报告，避免误抢用户的焦点。 */
  focused: boolean | null = null
  private now: () => number
  constructor(now: () => number = Date.now) {
    this.now = now
  }

  input(tabId: number): void {
    this.inputs.set(tabId, this.now())
  }

  private recent(tabId: number): number | undefined {
    const at = this.inputs.get(tabId)
    return at !== undefined && this.now() - at <= INPUT_ACTIVATION_MS ? at : undefined
  }

  /** 新标签：没有 opener 的是外部或用户自己打开的，不记。 */
  tabCreated(tab: CreatedTab): void {
    if (typeof tab.id !== 'number' || typeof tab.openerTabId !== 'number') return
    if (![...this.inputs.keys()].some((id) => this.recent(id) !== undefined)) return
    this.opened.set(tab.id, { at: this.now(), opener: tab.openerTabId, windowId: tab.windowId })
  }

  openerOf(tabId: number): number | undefined {
    return this.opened.get(tabId)?.opener
  }

  forget(tabId: number): void {
    this.inputs.delete(tabId)
    this.opened.delete(tabId)
  }

  /** 同步记录焦点变化；返回是否为“Chrome 从确知不在前台变为获得焦点”。 */
  focus(windowId: number): boolean {
    const before = this.focused
    this.focused = windowId >= 0
    return windowId >= 0 && before === false
  }

  /**
   * Chrome 刚获得焦点时，活动标签若是受控标签刚打开的新页面，返回该受控标签的租约。
   * 受控标签是所在窗口的后台标签时，Chrome 记的 opener 是该窗口当时的活动标签，
   * 所以 opener 不是受控标签时，按 opener 或新标签所在窗口找刚收到代理输入的受控标签。
   */
  stolen(
    active: CreatedTab | undefined,
    leased: readonly LeasedTab[],
    openerWindowId?: number,
  ): { tabId: number; leaseId: string } | null {
    if (typeof active?.id !== 'number') return null
    const record = this.opened.get(active.id)
    if (!record || this.now() - record.at > OPENED_FOCUS_MS) return null
    const candidates = leased
      .filter((tab) => this.recent(tab.tabId) !== undefined)
      .sort((a, b) => (this.recent(b.tabId) ?? 0) - (this.recent(a.tabId) ?? 0))
    const source =
      candidates.find((tab) => tab.tabId === record.opener) ??
      candidates.find(
        (tab) =>
          (openerWindowId !== undefined && tab.windowId === openerWindowId) ||
          (record.windowId !== undefined && tab.windowId === record.windowId),
      )
    if (!source) return null
    // 一次打开只交还一次；之后用户再切到 Chrome 不受影响。
    this.opened.delete(active.id)
    return { tabId: source.tabId, leaseId: source.leaseId }
  }
}
