import { decodeBase64, type FilePreview, previewKind } from '@litch/core'
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useT } from '../../../app/appearance.ts'
import type { MessageKey } from '../../../i18n/index.ts'
import { CodeBlock } from '../../../transcript/CodeBlock.tsx'
import { ExternalLink } from '../../../transcript/ExternalLink.tsx'
import { Markdown } from '../../../transcript/Markdown.tsx'
import { MermaidBlock } from '../../../transcript/Mermaid.tsx'
import { type MarkdownPolicy, MarkdownPolicyContext } from '../../../transcript/markdown-policy.ts'
import type { PreviewRendererProps } from '../contract.ts'
import { imageInfo, svgInfo } from '../image-info.ts'
import { documentTarget, headingSlug } from '../paths.ts'

/** 文中的图没画出来时写的原因：还在读、读到了但不能显示、或者本来就不自动加载 */
function imageNote(loads: boolean, content: FilePreview | null): MessageKey {
  if (!loads) return 'preview.blocked'
  switch (content?.kind) {
    case undefined:
    case 'ready':
      return 'files.view.loading'
    case 'tooLarge':
      return 'preview.imageTooLarge'
    case 'missing':
      return 'files.view.missing'
    case 'outside':
      return 'preview.imageOutside'
    case 'unsupported':
    case 'changed':
    case 'busy':
      return `preview.${content.kind}`
    default:
      return 'preview.imageInvalid'
  }
}

function DocumentImage({
  href,
  alt,
  props,
}: {
  href: string
  alt: string
  props: PreviewRendererProps
}) {
  const t = useT()
  const element = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const [content, setContent] = useState<FilePreview | null>(null)
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState<MessageKey | null>(null)
  const target = documentTarget(props.scope.root, props.scope.path, href)
  const path = target.kind === 'local' ? target.path : null
  const format = path ? previewKind(path) : null
  const loads = format === 'image' || format === 'svg'
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true)
      },
      { rootMargin: '200px' },
    )
    if (element.current) observer.observe(element.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!visible || !path || !loads) return
    let alive = true
    props.resources.load({ ...props.scope, path }, format, true).then(
      (result) => {
        if (alive) setContent(result)
      },
      () => {
        if (alive) setFailed('files.view.failed')
      },
    )
    return () => {
      alive = false
    }
  }, [visible, path, format, loads, props.resources, props.scope])
  useEffect(() => {
    if (content?.kind !== 'ready') return
    const bytes = decodeBase64(content.dataBase64)
    const info = format === 'svg' ? svgInfo(new TextDecoder().decode(bytes)) : imageInfo(bytes)
    if (!info) {
      setFailed('preview.imageInvalid')
      return
    }
    if (!props.resources.claimPixels(path ?? href, info.width * info.height)) {
      setFailed('preview.imageBudget')
      return
    }
    const made = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: info.mime }))
    setUrl(made)
    return () => URL.revokeObjectURL(made)
  }, [content, format, props.resources, path, href])
  const shown = url && !failed
  return (
    <span ref={element} className="fp-resource" data-state={shown ? 'image' : 'note'}>
      {shown ? (
        <img
          className="fp-inline-image"
          src={url}
          alt={alt}
          onError={() => setFailed('preview.imageInvalid')}
        />
      ) : (
        <span className="dim">
          {alt || href} ·{' '}
          {t(
            failed ??
              (target.kind === 'blocked' && target.outside
                ? 'preview.imageOutside'
                : imageNote(loads, content)),
          )}
          {target.kind === 'external' ? (
            <>
              {' '}
              · <ExternalLink href={target.href}>{target.href}</ExternalLink>
            </>
          ) : null}
        </span>
      )}
    </span>
  )
}

function DocumentCode({
  lang,
  text,
  diagrams,
}: {
  lang: string
  text: string
  diagrams: Set<string>
}) {
  const id = useId()
  const [allowed, setAllowed] = useState(false)
  useEffect(() => {
    if (
      lang.trim() !== 'mermaid' ||
      text.length > 20_000 ||
      (text.match(/-->|---|==>|-\.->/g)?.length ?? 0) > 200 ||
      diagrams.size >= 8
    )
      return
    diagrams.add(id)
    setAllowed(true)
    return () => {
      diagrams.delete(id)
    }
  }, [lang, text, diagrams, id])
  if (lang.trim() === 'mermaid' && allowed) return <MermaidBlock text={text} open={false} bounded />
  return (
    <div className="fp-code">
      {text.length <= 20_000 && lang.trim() !== 'mermaid' ? (
        <CodeBlock lang={lang} text={text} />
      ) : (
        <pre>
          <code>{text}</code>
        </pre>
      )}
    </div>
  )
}

export default function MarkdownPreview(props: PreviewRendererProps) {
  const t = useT()
  const host = useRef<HTMLDivElement>(null)
  const [fragment, setFragment] = useState(props.fragment)
  const [anchorJump, setAnchorJump] = useState(0)
  const text = useMemo(
    () => new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(props.data.dataBase64)),
    [props.data],
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: 文本更新后重新计算这一份文档的图表预算
  const diagrams = useMemo(() => new Set<string>(), [text])
  const policy = useMemo<MarkdownPolicy>(
    () => ({
      link(href: string, children: ReactNode) {
        const target = documentTarget(props.scope.root, props.scope.path, href)
        if (target.kind === 'external')
          return <ExternalLink href={target.href}>{children}</ExternalLink>
        if (target.kind !== 'local')
          return (
            <span className="md-dead" title={href}>
              {children}
            </span>
          )
        return (
          <a
            href={`#${encodeURIComponent(target.path)}`}
            onClick={(event) => {
              event.preventDefault()
              if (target.path === props.scope.path && target.fragment) {
                setFragment(target.fragment)
                setAnchorJump((n) => n + 1)
              } else props.open(target.path, target.line, target.fragment)
            }}
          >
            {children}
          </a>
        )
      },
      image: (href, alt) => <DocumentImage href={href} alt={alt} props={props} />,
      code: (lang, source) => <DocumentCode lang={lang} text={source} diagrams={diagrams} />,
    }),
    [props, diagrams],
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: 外部重复点击同一标题也要重新定位
  useEffect(() => {
    setFragment(props.fragment)
    setAnchorJump((n) => n + 1)
  }, [props.fragment, props.jump])
  // biome-ignore lint/correctness/useExhaustiveDependencies: 文本更新后 DOM 标题也需要重新编号
  useEffect(() => {
    const headings = host.current?.querySelectorAll('h1,h2,h3,h4,h5,h6') ?? []
    const names = new Map<string, number>()
    for (const heading of headings) {
      const slug = headingSlug(heading.textContent ?? '')
      const count = names.get(slug) ?? 0
      names.set(slug, count + 1)
      heading.id = `fp-h-${count ? `${slug}-${count}` : slug}`
    }
    if (fragment) {
      const found = Array.from(headings).find((heading) => heading.id === `fp-h-${fragment}`)
      found?.scrollIntoView({ block: 'start' })
    }
  }, [text, fragment, anchorJump])
  // 除字节限额外限制 DOM 工作量，重复短行也不能生成海量节点。
  if (text.split('\n').length > 10_000 || (text.match(/[[\]*`<>|]/g)?.length ?? 0) > 30_000)
    return <div className="fv-hold">{t('files.view.tooLarge')}</div>
  return (
    <div ref={host} className="fp-document">
      <MarkdownPolicyContext.Provider value={policy}>
        <Markdown text={text} streaming={false} anchor={`document:${props.scope.path}`} />
      </MarkdownPolicyContext.Provider>
    </div>
  )
}
