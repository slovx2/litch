import { type MouseEvent, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../../app/appearance.ts'
import { showToast } from '../../app/toasts.tsx'
import { runFileAction } from '../../files/actions.ts'
import { ContextMenu } from '../../files/ContextMenu.tsx'
import { revealLabel } from '../../files/destination.ts'
import { useFileDestination } from '../../files/FileDestination.tsx'
import { saveToLocal } from '../../files/save.ts'
import { openInFiles } from '../../files/state.ts'
import { clickLink, openSystemLink } from '../../side/browser/links.ts'
import {
  copyImage,
  downloadImage,
  type MediaAction,
  type MediaSubject,
  mediaActionKey,
  mediaActions,
} from './actions.ts'

export function useMediaMenu(
  subject: MediaSubject,
  enlarge?: () => void,
  openedFiles?: () => void,
) {
  const t = useT()
  const file = subject.source.kind === 'file' ? subject.source.file : null
  const destination = useFileDestination(file ? { ...file, relative: file.path } : null)
  const [menu, setMenu] = useState<{
    x: number
    y: number
    trigger: HTMLElement
    host: HTMLElement
  } | null>(null)
  const actions = mediaActions(subject, {
    copy: !!navigator.clipboard?.write && typeof ClipboardItem !== 'undefined',
    text: !!navigator.clipboard?.writeText,
    destination,
    enlarge: !!enlarge,
  })
  const toastHost = menu?.host.tagName === 'DIALOG' ? menu.host : undefined
  const fail = (action: MediaAction, reason: unknown) =>
    showToast({
      id: 'media-action',
      host: toastHost,
      tone: 'err',
      lifeMs: 5000,
      text: (tr) =>
        tr(action === 'copy' ? 'message.copy.failed' : 'media.menu.failed', {
          reason: String(reason),
        }),
    })
  const run = async (action: MediaAction) => {
    try {
      if (action === 'enlarge') return enlarge?.()
      if (action === 'revealLocal' && file)
        return runFileAction('revealLocal', { ...file, relative: file.path }, toastHost)
      if (action === 'save' && file) return saveToLocal(file, toastHost)
      if (action === 'files' && file) {
        openInFiles({ ...file, workspaceId: null, alt: null, line: null })
        openedFiles?.()
        return
      }
      if (action === 'copyPath') {
        const source = subject.source
        if (source.kind !== 'tool')
          await navigator.clipboard.writeText(
            source.kind === 'file' ? source.file.path : source.href,
          )
        return
      }
      if (action === 'browser' && subject.source.kind === 'url') {
        if (!clickLink(subject.source.href, { button: 0, metaKey: false, ctrlKey: false }))
          openSystemLink(subject.source.href)
        return
      }
      const lease = subject.load ? await subject.load() : null
      try {
        const image = lease?.image ?? subject.image
        if (!image) throw new Error(t('files.view.failed'))
        if (action === 'copy') await copyImage(image)
        else if (action === 'save')
          await downloadImage(
            image,
            subject.source.kind === 'url' ? subject.source.href : 'image.png',
          )
      } finally {
        lease?.release()
      }
    } catch (error) {
      fail(action, error)
    }
  }
  return {
    onContextMenu(event: MouseEvent<HTMLElement>) {
      if (!actions.length) return
      event.preventDefault()
      event.stopPropagation()
      const rect = event.currentTarget.getBoundingClientRect()
      setMenu({
        x: event.clientX || rect.left,
        y: event.clientY || rect.bottom,
        trigger:
          event.target instanceof Element
            ? (event.target.closest<HTMLElement>('button, a, [tabindex]') ?? event.currentTarget)
            : event.currentTarget,
        host: event.currentTarget.closest<HTMLElement>('dialog[open]') ?? document.body,
      })
    },
    menu: menu
      ? createPortal(
          <ContextMenu
            x={menu.x}
            y={menu.y}
            label={t('media.menu.title')}
            items={actions.map((id) => ({
              id,
              title: t(
                id === 'revealLocal'
                  ? revealLabel(window.litchShell?.platform)
                  : mediaActionKey(id, subject.source),
              ),
            }))}
            onPick={(id) => void run(id as MediaAction)}
            onClose={(refocus) => {
              setMenu(null)
              if (refocus) menu.trigger.focus({ preventScroll: true })
            }}
          />,
          menu.host,
        )
      : null,
  }
}
