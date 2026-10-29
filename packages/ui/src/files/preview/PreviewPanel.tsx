import {
  decodeBase64,
  type FilePreview,
  languageOf,
  type PreviewKind,
  relativeTo,
} from '@litch/core'
import { Component, lazy, type ReactNode, Suspense, useEffect, useMemo, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { whyNot } from '../../app/errors.ts'
import { useServices } from '../../app/services.tsx'
import { runFileAction } from '../actions.ts'
import { CodeView } from '../CodeView.tsx'
import { byteSize, splitLines } from '../lines.ts'
import { type OpenFile, openFile, retargetFile, setFileMode } from '../state.ts'
import type { PreviewScope } from './contract.ts'
import { rendererFor } from './registry.ts'
import { PreviewResources } from './resources.ts'
import './preview.css'

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
  const [refresh, setRefresh] = useState(0)
  const [content, setContent] = useState<FilePreview | null>(null)
  const [error, setError] = useState('')
  const text = ['markdown', 'svg', 'html', 'csv'].includes(format)
  const source = text && (tab.previewMode ?? (tab.line ? 'source' : 'preview')) === 'source'
  const scope = useMemo<PreviewScope>(
    () => ({ deviceId, root, path: tab.path }),
    [deviceId, root, tab.path],
  )
  const [resources, setResources] = useState<PreviewResources | null>(null)
  // effect 中创建：StrictMode 的卸载/重挂不能复用已取消的资源。
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh 与 scope 明确开始新一代
  useEffect(() => {
    const value = new PreviewResources((where, kind, signal) =>
      channel.command('files.preview', { ...where, format: kind }, { signal }),
    )
    setResources(value)
    return () => value.dispose()
  }, [channel, scope, refresh])
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
  useEffect(() => {
    if (!resources) return
    let alive = true
    setContent(null)
    setError('')
    resources.load(scope, source ? 'source' : format).then(
      (result) => {
        if (!alive) return
        if (result.kind === 'unsupported') {
          onUnsupported()
          return
        }
        if (result.kind === 'missing' && tab.alt) {
          retargetFile(uiKey, tab.path, tab.alt)
          return
        }
        setContent(result)
      },
      (reason) => {
        if (alive && !resources.abort.signal.aborted) setError(whyNot(reason, t))
      },
    )
    return () => {
      alive = false
    }
  }, [scope, resources, format, source, tab.alt, tab.path, uiKey, t, onUnsupported])
  const invalid = (
    <div className="fv-hold" role="status">
      {t('preview.invalid')}
    </div>
  )
  let body: ReactNode = null
  if (error)
    body = (
      <div className="fv-hold" role="status">
        {error}
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
          open={(path, line, fragment) =>
            openFile(uiKey, path, {
              ...(line ? { line } : {}),
              ...(fragment ? { fragment } : {}),
              reveal: true,
            })
          }
        />
      </Suspense>
    )
  } else if (content.kind === 'tooLarge')
    body = (
      <div className="fv-hold" role="status">
        <b>{t('files.view.tooLarge')}</b>
        <span>
          {t('files.view.tooLarge.note', {
            size: byteSize(content.bytes),
            limit: byteSize(content.limit),
          })}
        </span>
      </div>
    )
  else
    body = (
      <div className="fv-hold" role="status">
        {content.kind === 'missing' ? t('files.view.missing') : t(`preview.${content.kind}`)}
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
        <span className="ell grow" title={tab.path}>
          {relativeTo(root, tab.path)}
        </span>
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
        <button
          type="button"
          className="mini"
          onClick={() =>
            runFileAction('mention', {
              path: tab.path,
              relative: relativeTo(root, tab.path),
              line: tab.line,
            })
          }
        >
          {t('files.action.mention')}
        </button>
        <button
          type="button"
          className="mini"
          data-tool="reload"
          onClick={() => setRefresh((n) => n + 1)}
        >
          {t('files.view.reload')}
        </button>
      </div>
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
