import type { MouseEvent, ReactNode } from 'react'
import { clickLink } from '../side/browser/links.ts'

/**
 * 回答里的链接。只认 http 和 https，别的协议不给点。
 * 在桌面外壳里默认用内置浏览器打开（眼前这个会话的用户标签，见 side/browser/links.ts）；
 * 中键、Cmd/Ctrl 点或设置里关掉了，交给系统的浏览器。应用自己的窗口不跳转，也不开新窗口。
 */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  if (!/^https?:\/\//i.test(href)) {
    return (
      <span className="md-dead" title={href}>
        {children}
      </span>
    )
  }
  const open = (event: MouseEvent) => {
    // 右键这类不管；中键在 auxclick 里来
    if (event.button !== 0 && event.button !== 1) return
    if (clickLink(href, event)) event.preventDefault()
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" title={href} onClick={open} onAuxClick={open}>
      {children}
    </a>
  )
}
