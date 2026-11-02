import { useEffect } from 'react'
import { useT } from './appearance.ts'
import { Back, Forward } from './icons.tsx'
import { leaveThen } from './leave-guard.tsx'
import { navigationKey } from './navigation-key.ts'
import { currentPlatform } from './platform.ts'

export function NavigationBar({
  back,
  forward,
  go,
}: {
  back: boolean
  forward: boolean
  go(direction: -1 | 1): void
}) {
  const t = useT()
  useEffect(() => {
    let composing = false
    const editing = () =>
      document.activeElement instanceof Element &&
      !!document.activeElement.closest(
        'input, textarea, select, [contenteditable="true"], [role="textbox"]',
      )
    const start = () => {
      composing = true
    }
    const end = () => {
      composing = false
    }
    const key = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return
      const direction = navigationKey(event, currentPlatform(), composing || editing())
      if (direction === null || event.defaultPrevented) return
      event.preventDefault()
      leaveThen(() => go(direction))
    }
    const mouse = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return
      // 无论是否导航都阻止 Chromium 自己返回 app:// 页面的历史。
      event.preventDefault()
      if (
        event.type === 'mouseup' &&
        !composing &&
        !editing() &&
        !document.querySelector('dialog[open]')
      )
        leaveThen(() => go(event.button === 3 ? -1 : 1))
    }
    document.addEventListener('keydown', key)
    document.addEventListener('compositionstart', start)
    document.addEventListener('compositionend', end)
    document.addEventListener('mousedown', mouse)
    document.addEventListener('mouseup', mouse)
    document.addEventListener('auxclick', mouse)
    const offMenu = window.litchShell?.onMenu?.((action) => {
      if (composing || editing() || document.querySelector('dialog[open]')) return
      if (action === 'navigation.back') leaveThen(() => go(-1))
      if (action === 'navigation.forward') leaveThen(() => go(1))
    })
    return () => {
      offMenu?.()
      document.removeEventListener('keydown', key)
      document.removeEventListener('compositionstart', start)
      document.removeEventListener('compositionend', end)
      document.removeEventListener('mousedown', mouse)
      document.removeEventListener('mouseup', mouse)
      document.removeEventListener('auxclick', mouse)
    }
  }, [go])
  const mac = currentPlatform() === 'mac'
  return (
    <nav className="window-navigation" aria-label={t('navigation.label')}>
      <button
        type="button"
        className="ibtn"
        data-navigation="back"
        disabled={!back}
        aria-label={t('navigation.back')}
        title={`${t('navigation.back')} (${mac ? '⌘[' : 'Alt+←'})`}
        onClick={() => leaveThen(() => go(-1))}
      >
        <Back />
      </button>
      <button
        type="button"
        className="ibtn"
        data-navigation="forward"
        disabled={!forward}
        aria-label={t('navigation.forward')}
        title={`${t('navigation.forward')} (${mac ? '⌘]' : 'Alt+→'})`}
        onClick={() => leaveThen(() => go(1))}
      >
        <Forward />
      </button>
    </nav>
  )
}
