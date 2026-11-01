/** 前台状态只由平台提供；停留阈值、清零和只记一次都在核心，手机可用相同接口。 */
export interface ForegroundSource {
  visible(): boolean
  focused(): boolean
  listen(
    event: 'focus' | 'blur' | 'visibilitychange' | 'pagehide' | 'pageshow',
    changed: () => void,
  ): () => void
  /** 桌面以整个原生窗口为准，内置网页获得输入焦点不算切到其他窗口。 */
  native?: (changed: (foreground: boolean) => void) => () => void
}

export function watchForeground(
  source: ForegroundSource,
  update: (foreground: boolean) => void,
): () => void {
  let pageActive = true
  let nativeForeground = false
  const refresh = () =>
    update(pageActive && source.visible() && (source.native ? nativeForeground : source.focused()))
  const stops = [
    source.listen('focus', refresh),
    source.listen('blur', refresh),
    source.listen('visibilitychange', refresh),
    source.listen('pagehide', () => {
      pageActive = false
      refresh()
    }),
    source.listen('pageshow', () => {
      pageActive = true
      refresh()
    }),
  ]
  if (source.native)
    stops.push(
      source.native((value) => {
        nativeForeground = value
        refresh()
      }),
    )
  refresh()
  return () => {
    for (const stop of stops) stop()
    update(false)
  }
}
