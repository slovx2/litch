// 对话区“回到底部”出不出（detail/Transcript.tsx 的 ToBottom）。
/** 离开底部多远（dp）出“回到底部”，回到多近收起：中间留一段，贴着底边轻轻一碰不闪 */
const TO_BOTTOM_SHOW = 48
const TO_BOTTOM_HIDE = 8

/** “回到底部”出不出。和对话区的 Guard 一样走外部订阅：滚动时只重画那个按钮，对话区不动 */
export class Away {
  private away = false
  private readonly listeners = new Set<() => void>()
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  readonly get = (): boolean => this.away
  scrolled(offset: number): void {
    const next = this.away ? offset > TO_BOTTOM_HIDE : offset > TO_BOTTOM_SHOW
    if (next === this.away) return
    this.away = next
    for (const listener of this.listeners) listener()
  }
}
