import { type AnchorHTMLAttributes, type MouseEvent, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../app/appearance.ts'
import { showToast } from '../app/toasts.tsx'
import { ContextMenu } from '../files/ContextMenu.tsx'
import {
  appLinkBlocked,
  clickLink,
  openAppLink,
  openSystemLink,
  useLinksInBrowser,
} from '../side/browser/links.ts'

type Props = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  'href' | 'onClick' | 'onAuxClick' | 'onContextMenu'
> & {
  href: string
  /** 安装文档、登录验证等原本固定交给系统浏览器的入口，保持直接点击的行为。 */
  openInSystem?: boolean
}
interface Menu {
  x: number
  y: number
  href: string
  host: HTMLElement
}

function LinkMenu({ menu, onClose }: { menu: Menu; onClose(refocus: boolean): void }) {
  const t = useT()
  useLinksInBrowser()
  const blocked = appLinkBlocked()
  const fail = () =>
    showToast({
      id: 'link-copy',
      tone: 'err',
      lifeMs: 4000,
      text: (t) => t('link.menu.copyFailed'),
    })
  return (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      label={t('link.menu.title')}
      onClose={onClose}
      items={[
        { id: 'copyLink', title: t('link.menu.copy') },
        { id: 'openSystem', title: t('link.menu.system') },
        { id: 'openApp', title: t('link.menu.app'), disabled: blocked ? t(blocked) : undefined },
      ]}
      onPick={(id) => {
        if (id === 'copyLink') {
          if (!navigator.clipboard) return fail()
          void navigator.clipboard.writeText(menu.href).catch(fail)
        } else if (id === 'openSystem') openSystemLink(menu.href)
        else if (id === 'openApp') openAppLink(menu.href)
      }}
    />
  )
}

/** http/https 链接统一的点击路由与右键菜单。文件链接仍由 FileLinks 处理。 */
export function ExternalLink({ href, children, openInSystem, ...props }: Props) {
  const anchor = useRef<HTMLAnchorElement>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  if (!/^https?:\/\//i.test(href))
    return (
      <span className="md-dead" title={href}>
        {children}
      </span>
    )
  const open = (event: MouseEvent) => {
    if (event.button !== 0 && event.button !== 1) return
    if (openInSystem) {
      event.preventDefault()
      openSystemLink(href)
    } else if (clickLink(href, event)) event.preventDefault()
  }
  const close = (refocus: boolean) => {
    setMenu(null)
    if (refocus) anchor.current?.focus({ preventScroll: true })
  }
  return (
    <>
      <a
        {...props}
        ref={anchor}
        href={href}
        target="_blank"
        rel="noreferrer"
        title={props.title ?? href}
        onClick={open}
        onAuxClick={open}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          const rect = event.currentTarget.getBoundingClientRect()
          setMenu({
            x: event.clientX || rect.left,
            y: event.clientY || rect.bottom,
            href,
            host: event.currentTarget.closest<HTMLElement>('dialog[open]') ?? document.body,
          })
        }}
      >
        {children}
      </a>
      {menu ? createPortal(<LinkMenu menu={menu} onClose={close} />, menu.host) : null}
    </>
  )
}
