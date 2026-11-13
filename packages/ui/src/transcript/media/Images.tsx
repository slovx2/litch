import { type FilePreview, transcriptImageTarget } from '@litch/core'
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { useServices } from '../../app/services.tsx'
import type { PreviewScope } from '../../files/preview/contract.ts'
import { PreviewResources } from '../../files/preview/resources.ts'
import { usePreviewImage } from '../../files/preview/use-image.ts'
import { saveToLocal } from '../../files/save.ts'
import { openInFiles } from '../../files/state.ts'
import type { MessageKey } from '../../i18n/index.ts'
import { ExternalLink } from '../ExternalLink.tsx'
import { Link, useFileLinks } from '../FileLinks.tsx'
import { MarkdownPolicyContext } from '../markdown-policy.ts'
import { type GalleryImage, Lightbox } from './Lightbox.tsx'
import { useMediaMenu } from './MediaMenu.tsx'
import './images.css'

interface Gallery {
  resources: PreviewResources
  entries: Map<string, GalleryImage>
  open(id: string): void
}
const Context = createContext<Gallery | null>(null)

export function MessageImages({
  children,
  streaming,
}: {
  children: ReactNode
  streaming: boolean
}) {
  const links = useFileLinks()
  const policy = useContext(MarkdownPolicyContext)
  // 文件内 Markdown 有自己的文档相对路径策略。
  if (policy || !links?.deviceId) return children
  return (
    <GalleryProvider
      key={`${links.deviceId}:${links.scope.cwd}:${links.connection}`}
      streaming={streaming}
    >
      {children}
    </GalleryProvider>
  )
}

function GalleryProvider({ children, streaming }: { children: ReactNode; streaming: boolean }) {
  const { channel } = useServices()
  const [selected, select] = useState<string | null>(null)
  const [gallery, setGallery] = useState<Gallery | null>(null)
  useEffect(() => {
    const next: Gallery = {
      resources: new PreviewResources((scope, _format, signal) =>
        channel.command(
          'media.image',
          { deviceId: scope.deviceId, source: scope.path },
          { signal },
        ),
      ),
      entries: new Map(),
      open: select,
    }
    setGallery(next)
    return () => next.resources.dispose()
  }, [channel])
  return (
    <Context.Provider value={streaming ? null : gallery}>
      {children}
      {selected && gallery ? (
        <Lightbox
          entries={[...gallery.entries.values()]}
          selected={selected}
          close={() => select(null)}
        />
      ) : null}
    </Context.Provider>
  )
}

function note(content: FilePreview | null): MessageKey {
  switch (content?.kind) {
    case undefined:
    case 'ready':
      return 'files.view.loading'
    case 'tooLarge':
      return 'preview.imageTooLarge'
    case 'missing':
      return 'files.view.missing'
    case 'unsupported':
    case 'changed':
    case 'busy':
      return `preview.${content.kind}`
    default:
      return 'preview.imageInvalid'
  }
}

export function TranscriptImage({ href, alt }: { href: string; alt: string }) {
  const links = useFileLinks()
  const gallery = useContext(Context)
  const target = transcriptImageTarget(href, links?.scope ?? null)
  const deviceId = links?.deviceId
  if (!gallery || !deviceId || target.kind === 'blocked')
    return <Link href={href}>{alt || href}</Link>
  const path = target.kind === 'file' ? target.path : target.href
  return (
    <LoadedImage
      key={path}
      href={href}
      alt={alt}
      gallery={gallery}
      scope={{ deviceId, path, root: target.kind === 'file' ? target.root : '' }}
    />
  )
}

function LoadedImage({
  href,
  alt,
  gallery,
  scope,
}: {
  href: string
  alt: string
  gallery: Gallery
  scope: PreviewScope
}) {
  const t = useT()
  const host = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const [content, setContent] = useState<FilePreview | null>(null)
  const [readFailed, setReadFailed] = useState(false)
  const id = JSON.stringify([scope.deviceId, scope.path])
  const { image, failure, fail } = usePreviewImage(content, gallery.resources, id)
  const external = /^https?:\/\//i.test(href)
  const { deviceId, root, path } = scope
  const source = external ? { kind: 'url' as const, href } : { kind: 'file' as const, file: scope }
  const mediaMenu = useMediaMenu(
    {
      kind: 'image',
      source,
      label: alt || href,
      image: failure ? undefined : (image ?? undefined),
    },
    image && !failure ? () => gallery.open(id) : undefined,
  )
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true)
      },
      { rootMargin: '200px' },
    )
    if (host.current) observer.observe(host.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!visible) return
    let live = true
    gallery.resources.load({ deviceId, root, path }, 'image', true).then(
      (result) => {
        if (live) setContent(result)
      },
      () => {
        if (live) setReadFailed(true)
      },
    )
    return () => {
      live = false
    }
  }, [visible, gallery, deviceId, root, path])
  useEffect(() => {
    if (!image || failure) return
    const entry: GalleryImage = {
      id,
      ...image,
      label: alt || href,
      ...(external
        ? {}
        : {
            reveal: () =>
              openInFiles({ deviceId, root, path, workspaceId: null, alt: null, line: null }),
            save: window.litchShell?.saveFile
              ? (host?: HTMLElement) => saveToLocal({ deviceId, root, path }, host)
              : undefined,
          }),
      href,
      source: external ? { kind: 'url', href } : { kind: 'file', file: { deviceId, root, path } },
    }
    gallery.entries.set(id, entry)
    return () => {
      if (gallery.entries.get(id) === entry) gallery.entries.delete(id)
    }
  }, [image, failure, gallery, id, alt, href, external, deviceId, root, path])
  const shown = image && !failure
  return (
    <span
      ref={host}
      className="transcript-image"
      data-media-state={
        shown ? 'ready' : failure || readFailed ? 'failed' : (content?.kind ?? 'loading')
      }
    >
      {shown ? (
        <button
          type="button"
          className="transcript-image-open"
          onContextMenu={mediaMenu.onContextMenu}
          aria-label={t('media.enlarge', { name: alt || href })}
          onClick={(event) => {
            event.currentTarget.focus()
            gallery.open(id)
          }}
        >
          <img src={image.url} width={image.width} height={image.height} alt={alt} onError={fail} />
        </button>
      ) : (
        <span className="transcript-image-note">
          {external ? (
            <ExternalLink href={href}>{alt || href}</ExternalLink>
          ) : (
            <Link href={href}>{alt || href}</Link>
          )}
          <small role="status">
            {t(failure ?? (readFailed ? 'files.view.failed' : note(content)))}
          </small>
        </span>
      )}
      {mediaMenu.menu}
    </span>
  )
}
