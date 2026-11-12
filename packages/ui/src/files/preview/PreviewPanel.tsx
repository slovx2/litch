import {
  type DeviceView,
  decodeBase64,
  type FilePreview,
  keys,
  languageOf,
  normalizePath,
  observeFileChanges,
  type PreviewKind,
  parentPath,
  pathTwin,
  relativeTo,
  withinRoot,
} from '@litch/core'
import {
  Component,
  lazy,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { useT } from '../../app/appearance.ts'
import { whyNot } from '../../app/errors.ts'
import { Icon } from '../../app/icons.tsx'
import { useKey, useServices } from '../../app/services.tsx'
import { type FileAction, runFileAction } from '../actions.ts'
import { CodeView } from '../CodeView.tsx'
import { useFileWatching } from '../content.ts'
import { FileDestination } from '../FileDestination.tsx'
import { byteSize, splitLines } from '../lines.ts'
import {
  FileBrowserPlace,
  type OpenFile,
  openInFiles,
  retargetFile,
  setFileMode,
} from '../state.ts'
import type { PreviewScope } from './contract.ts'
import { rendererFor } from './registry.ts'
import { PreviewResources } from './resources.ts'
import './preview.css'
import { FileLinkInfo } from '../FileLinkDetails.tsx'

class PreviewBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

export function PreviewPanel({
  deviceId,
  root,
  uiKey,
  tab,
  format,
  onUnsupported,
}: {
  deviceId: string
  root: string
  uiKey: string
  tab: OpenFile
  format: PreviewKind
  onUnsupported(): void
}) {
  const t = useT()
  const { channel } = useServices()
  const watching = useFileWatching()
  const place = useContext(FileBrowserPlace)
  const device = useKey<DeviceView>(keys.device(deviceId))
  const [linkError, setLinkError] = useState('')
  const twin = pathTwin(device?.os)
  const projectRoot = place?.roots
    .map(normalizePath)
    .find((base) => withinRoot(base, tab.path, twin) !== null)
  const resourceRoot = projectRoot
    ? withinRoot(projectRoot, tab.path) !== null
      ? projectRoot
      : (twin(projectRoot) ?? projectRoot)
    : (parentPath(tab.path) ?? root)
  const [refresh, setRefresh] = useState(0)
  const [error, setError] = useState('')
  const text = ['markdown', 'svg', 'html', 'csv'].includes(format)
  const source = text && (tab.previewMode ?? (tab.line ? 'source' : 'preview')) === 'source'
  // 记下内容是按哪种方式读的：切到源码的那一帧还拿着预览读到的内容，不能先拿它画源码，
  // 否则行号定位在这一帧就算滚过了，读完重画时不再滚
  const reading = source ? 'source' : format
  const [loaded, setLoaded] = useState<{ reading: string; value: FilePreview } | null>(null)
  const content = loaded?.reading === reading ? loaded.value : null
  const scope = useMemo<PreviewScope>(
    () => ({ deviceId, root: resourceRoot, path: tab.path }),
    [deviceId, resourceRoot, tab.path],
  )
  const [resources, setResources] = useState<PreviewResources | null>(null)
  const Renderer = useMemo(() => {
    const loader = rendererFor(format)
    if (!loader) throw new Error('没有注册此文件渲染器')
    return lazy(loader)
  }, [format])
  const sourceText = useMemo(
    () =>
      content?.kind === 'ready' && source
        ? new TextDecoder().decode(decodeBase64(content.dataBase64))
        : '',
    [content, source],
  )
  // 每次变化创建独立资源预算；读取串行合并，慢连接不会被连续变更反复取消。
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh 是手动重读
  useEffect(() => {
    if (!watching) return
    let alive = true
    let current: PreviewResources | null = null
    let pending: PreviewResources | null = null
    let previous: FilePreview | null = null
    setLoaded(null)
    setError('')
    const read = async () => {
      const next = new PreviewResources((where, kind, signal) =>
        channel.command('files.preview', { ...where, format: kind }, { signal }),
      )
      pending = next
      try {
        const result = await next.load(scope, reading)
        if (!alive) return
        if (result.kind === 'unsupported') {
          onUnsupported()
          return
        }
        if (result.kind === 'missing' && tab.alt) {
          retargetFile(uiKey, tab.path, tab.alt)
          return
        }
        setError('')
        if (
          result.kind === 'ready' &&
          previous?.kind === 'ready' &&
          result.dataBase64 === previous.dataBase64
        )
          return
        previous = result
        current?.dispose()
        current = next
        setResources(next)
        setLoaded({ reading, value: result })
      } catch (reason) {
        if (alive && !next.abort.signal.aborted) setError(whyNot(reason, t))
      } finally {
        if (current !== next) next.dispose()
        pending = null
      }
    }
    const close = observeFileChanges(channel, scope, read, true)
    return () => {
      alive = false
      close()
      pending?.dispose()
      current?.dispose()
    }
  }, [channel, scope, reading, refresh, tab.alt, tab.path, uiKey, t, onUnsupported, watching])
  const reload = () => setRefresh((n) => n + 1)
  const act = (action: FileAction) =>
    runFileAction(action, {
      deviceId,
      root,
      path: tab.path,
      relative: relativeTo(root, tab.path),
      line: tab.line,
    })
  const retry = (
    <button type="button" className="btn" onClick={reload}>
      {t('files.retry')}
    </button>
  )
  const invalid = (
    <div className="fv-hold" data-hold="invalid" role="status">
      <b>{t('files.view.failed')}</b>
      <span>{t('preview.invalid')}</span>
    </div>
  )
  let body: ReactNode = null
  if (error)
    body = (
      <div className="fv-hold" data-hold="failed" role="status">
        <b>{t('files.view.failed')}</b>
        <span>{error}</span>
        {retry}
      </div>
    )
  else if (!content)
    body = (
      <div className="fv-hold" role="status">
        {t('files.view.loading')}
      </div>
    )
  else if (content.kind === 'ready') {
    body = !resources ? null : source ? (
      <CodeView
        uiKey={uiKey}
        path={tab.path}
        text={sourceText}
        language={languageOf(tab.path)}
        line={tab.line}
        jump={tab.jump}
      />
    ) : (
      <Suspense fallback={<div className="fv-hold">{t('files.view.loading')}</div>}>
        <Renderer
          scope={scope}
          data={content}
          resources={resources}
          fragment={tab.fragment}
          jump={tab.jump}
          open={(path, line, fragment) => {
            setLinkError('')
            void channel
              .command('files.resolve', {
                deviceId,
                root,
                ref: { path, line: line ?? null, alt: null },
                href: path,
              })
              .then(
                (result) => {
                  const found = result.candidates[0]
                  if (result.status !== 'ready' || !found) {
                    setLinkError(t(`files.link.error.${result.failures[0]?.reason ?? 'read'}`))
                    return
                  }
                  openInFiles({
                    deviceId,
                    workspaceId: place?.workspaceId ?? null,
                    sessionId: place?.sessionId ?? null,
                    ...found,
                    link: result,
                    line: line ?? null,
                    ...(fragment ? { fragment } : {}),
                  })
                },
                (error) => setLinkError(String(error)),
              )
          }}
        />
      </Suspense>
    )
  } else if (content.kind === 'tooLarge')
    body = (
      <div className="fv-hold" data-hold="tooLarge" role="status">
        <b>{t('files.view.tooLarge')}</b>
        <span>
          {t('files.view.tooLarge.note', {
            size: byteSize(content.bytes),
            limit: byteSize(content.limit),
          })}
        </span>
        {/* 源码的上限比渲染宽：渲染不了的文档多半还能看源码 */}
        {text && !source ? (
          <button
            type="button"
            className="btn"
            onClick={() => setFileMode(uiKey, tab.path, 'source')}
          >
            {t('preview.openSource')}
          </button>
        ) : null}
      </div>
    )
  else if (content.kind === 'missing')
    body = (
      <div className="fv-hold" data-hold="missing" role="status">
        <b>{t('files.view.missing')}</b>
        <span>{t('files.view.missing.note')}</span>
      </div>
    )
  else
    body = (
      <div className="fv-hold" data-hold={content.kind} role="status">
        <b>{t('files.view.failed')}</b>
        <span>{t(`preview.${content.kind}`)}</span>
        {content.kind === 'changed' || content.kind === 'busy' ? retry : null}
      </div>
    )
  return (
    <div
      className="fv-file fp"
      data-path={tab.path}
      data-state={error ? 'failed' : content ? 'ready' : 'loading'}
      data-kind={content?.kind ?? ''}
    >
      <div className="fv-head">
        <FileDestination
          subject={{ deviceId, root, path: tab.path, relative: relativeTo(root, tab.path) }}
        />
        <span className="ell grow" title={tab.path}>
          {relativeTo(root, tab.path)}
        </span>
        {tab.link ? <FileLinkInfo result={tab.link} /> : null}
        {text ? (
          <span className="seg">
            <button
              type="button"
              data-tool="preview"
              aria-pressed={!source}
              onClick={() => setFileMode(uiKey, tab.path, 'preview')}
            >
              {t('preview.view')}
            </button>
            <button
              type="button"
              data-tool="source"
              aria-pressed={source}
              onClick={() => setFileMode(uiKey, tab.path, 'source')}
            >
              {t('preview.source')}
            </button>
          </span>
        ) : null}
        <button type="button" className="mini" data-tool="mention" onClick={() => act('mention')}>
          {t('files.action.mention')}
        </button>
        <button
          type="button"
          className="ibtn"
          data-tool="copy"
          title={t('files.action.copyRelative')}
          aria-label={t('files.action.copyRelative')}
          onClick={() => act('copyRelative')}
        >
          <Icon name="copy" small />
        </button>
        <button
          type="button"
          className="ibtn"
          data-tool="reload"
          title={t('files.view.reload')}
          aria-label={t('files.view.reload')}
          aria-busy={!error && !content}
          onClick={reload}
        >
          <Icon name="reload" small />
        </button>
      </div>
      {linkError ? (
        <p role="alert" className="err">
          {linkError}
        </p>
      ) : null}
      <PreviewBoundary key={`${tab.path}:${source}:${refresh}`} fallback={invalid}>
        {body}
      </PreviewBoundary>
      <div className="fv-foot">
        <span className="ell">
          {content?.kind === 'ready'
            ? `${source ? `${t('files.view.lines', { n: splitLines(sourceText).length })} · ` : ''}${byteSize(content.bytes)}`
            : ''}
        </span>
        <span className="grow" />
        <span className="pill mute">{t('files.view.readonly')}</span>
      </div>
    </div>
  )
}
