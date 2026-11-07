import { type ForegroundSource, watchForeground } from '../app/foreground.ts'

/** 可见时保留监听和低频对账；从别的窗口回来补读一次，原生网页焦点不影响窗口判断。 */
export function watchFilePanel(
  source: ForegroundSource,
  visible: (shown: boolean) => void,
  refresh: () => void,
): () => void {
  let foreground = false
  const visibility = () => visible(source.visible())
  const stopVisibility = source.listen('visibilitychange', visibility)
  visibility()
  const stopForeground = watchForeground(source, (next) => {
    if (next && !foreground) refresh()
    foreground = next
  })
  return () => {
    stopVisibility()
    stopForeground()
  }
}
