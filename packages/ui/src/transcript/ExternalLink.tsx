import type { MouseEvent, ReactNode } from 'react'

/**
 * 回答里的链接。只认 http 和 https，别的协议不给点。
 * 在桌面外壳里交给系统的浏览器打开：应用自己的窗口不跳转，也不开新窗口。
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
    const shell = window.litchShell
    if (!shell) return
    event.preventDefault()
    shell.openExternal(href)
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" title={href} onClick={open}>
      {children}
    </a>
  )
}
