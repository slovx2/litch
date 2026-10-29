// 文件标签的右半边：开着的文件（一排标签）和正看着的那个的内容。只读。
// 单击打开的是预览（标签上的名字是斜的），再点别的文件就被换掉；双击、回车，或者双击标签，固定下来。
import { baseName, type FileContent, type FileGroup, previewKind, relativeTo } from '@litch/core'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { Close, Icon } from '../app/icons.tsx'
import type { MessageKey } from '../i18n/index.ts'
import { type FileAction, runFileAction } from './actions.ts'
import { CodeView } from './CodeView.tsx'
import { useFileContent } from './content.ts'
import { byteSize, splitLines } from './lines.ts'
import { PreviewPanel } from './preview/PreviewPanel.tsx'
import { rendererFor } from './preview/registry.ts'
import {
  activateFile,
  closeFile,
  type OpenFile,
  pinFile,
  retargetFile,
  revealPath,
  useTreeUi,
} from './state.ts'

const GROUP_TEXT: Record<FileGroup, MessageKey> = {
  image: 'files.view.group.image',
  audio: 'files.view.group.audio',
  video: 'files.view.group.video',
  archive: 'files.view.group.archive',
  document: 'files.view.group.document',
  font: 'files.view.group.font',
  database: 'files.view.group.database',
  executable: 'files.view.group.executable',
  binary: 'files.view.group.binary',
}

/** 没有内容可显示的时候占着位置的那一块：一句是怎么回事，可以再带一句说明和一个按钮 */
function Hold({
  kind,
  title,
  note,
  children,
}: {
  kind: string
  title: string
  note?: string | undefined
  children?: ReactNode
}) {
  return (
    <div className="fv-hold" data-hold={kind} role="status">
      <b>{title}</b>
      {note ? <span>{note}</span> : null}
      {children}
    </div>
  )
}

/** 过一会儿才显示：读得快的时候不闪一下“正在读取” */
function Delayed({ ms, children }: { ms: number; children: ReactNode }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), ms)
    return () => window.clearTimeout(timer)
  }, [ms])
  return shown ? children : null
}

function SourceFileBody({
  deviceId,
  root,
  uiKey,
  tab,
}: {
  deviceId: string
  root: string
  uiKey: string
  tab: OpenFile
}) {
  const t = useT()
  const [nonce, setNonce] = useState(0)
  const loaded = useFileContent(deviceId, root, tab.path, nonce)
  const content: FileContent | null = loaded.content
  const relative = relativeTo(root, tab.path)
  const settled = loaded.state === 'ready' ? loaded.content : null

  // 读不到：换成另一种读法再试一次。打开的其实是个目录：不开文件，在树里把它露出来
  useEffect(() => {
    if (settled?.kind === 'missing' && tab.alt) retargetFile(uiKey, tab.path, tab.alt)
    else if (settled?.kind === 'directory') {
      closeFile(uiKey, tab.path)
      revealPath(uiKey, tab.path)
    }
  }, [settled, uiKey, tab.path, tab.alt])

  const act = (action: FileAction) =>
    runFileAction(action, { path: tab.path, relative, line: tab.line })
  const reload = () => setNonce((n) => n + 1)
  const lineCount = useMemo(
    () => (content?.kind === 'text' ? splitLines(content.text).length : 0),
    [content],
  )

  return (
    <div
      className="fv-file"
      role="tabpanel"
      data-path={tab.path}
      data-state={loaded.state}
      data-kind={content?.kind ?? ''}
    >
      <div className="fv-head">
        <span className="ell grow" title={tab.path}>
          {relative}
        </span>
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
          aria-busy={loaded.state === 'loading'}
          onClick={reload}
        >
          <Icon name="reload" small />
        </button>
      </div>
      {loaded.state === 'failed' ? (
        <Hold kind="failed" title={t('files.view.failed')} note={whyNot(loaded.error, t)}>
          <button type="button" className="btn" onClick={reload}>
            {t('files.retry')}
          </button>
        </Hold>
      ) : content === null ? (
        <Delayed ms={300}>
          <Hold kind="loading" title={t('files.view.loading')} />
        </Delayed>
      ) : content.kind === 'text' ? (
        <CodeView
          uiKey={uiKey}
          path={tab.path}
          text={content.text}
          language={content.language}
          line={tab.line}
          jump={tab.jump}
        />
      ) : content.kind === 'tooLarge' ? (
        <Hold
          kind="tooLarge"
          title={t('files.view.tooLarge')}
          note={t('files.view.tooLarge.note', {
            size: byteSize(content.bytes),
            limit: byteSize(content.limit),
          })}
        />
      ) : content.kind === 'binary' ? (
        <Hold
          kind="binary"
          title={t(GROUP_TEXT[content.group])}
          note={
            content.bytes === null
              ? t('files.view.binary.note')
              : t('files.view.binary.sized', { size: byteSize(content.bytes) })
          }
        />
      ) : content.kind === 'missing' ? (
        <Hold kind="missing" title={t('files.view.missing')} note={t('files.view.missing.note')}>
          <button type="button" className="btn" onClick={reload}>
            {t('files.retry')}
          </button>
        </Hold>
      ) : null}
      {/* 底下一条：这是什么、多大。只读是常驻的——这里看得了改不了 */}
      <div className="fv-foot">
        {content?.kind === 'text' ? (
          <span className="ell">
            {content.language ?? t('files.view.plain')} · {t('files.view.lines', { n: lineCount })}{' '}
            · {byteSize(content.bytes)}
          </span>
        ) : null}
        <span className="grow" />
        {content?.kind === 'text' && content.lossy ? (
          <span className="pill wait" title={t('files.view.lossy.note')}>
            {t('files.view.lossy')}
          </span>
        ) : null}
        <span className="pill mute">{t('files.view.readonly')}</span>
      </div>
    </div>
  )
}

function FileBody(props: { deviceId: string; root: string; uiKey: string; tab: OpenFile }) {
  const t = useT()
  const [unavailable, setUnavailable] = useState(false)
  const format = previewKind(props.tab.path)
  if (unavailable)
    return (
      <>
        <div className="fp-unavailable dim" role="status">
          {t('preview.unsupported')}
        </div>
        <SourceFileBody {...props} />
      </>
    )
  return format && rendererFor(format) ? (
    <PreviewPanel {...props} format={format} onUnsupported={() => setUnavailable(true)} />
  ) : (
    <SourceFileBody {...props} />
  )
}

export function FileViewer({
  deviceId,
  root,
  uiKey,
}: {
  deviceId: string
  root: string
  uiKey: string
}) {
  const t = useT()
  const ui = useTreeUi(uiKey)
  const active = ui.tabs.find((tab) => tab.path === ui.active) ?? null

  if (ui.tabs.length === 0) {
    return (
      <section className="fv" aria-label={t('files.view')}>
        <div className="fv-none dim">{t('files.view.none')}</div>
      </section>
    )
  }
  return (
    <section className="fv" aria-label={t('files.view')}>
      <div className="fv-tabs" role="tablist" aria-label={t('files.view.tabs')}>
        {ui.tabs.map((tab) => {
          const name = baseName(tab.path)
          return (
            <div
              key={tab.path}
              className="fv-tab"
              role="presentation"
              data-path={tab.path}
              data-active={tab.path === ui.active}
              data-preview={!tab.pinned}
            >
              <button
                type="button"
                role="tab"
                className="fv-tab-btn"
                aria-selected={tab.path === ui.active}
                title={
                  tab.pinned
                    ? relativeTo(root, tab.path)
                    : t('files.view.previewTab', { path: relativeTo(root, tab.path) })
                }
                onClick={() => activateFile(uiKey, tab.path)}
                onDoubleClick={() => pinFile(uiKey, tab.path)}
                onAuxClick={(event) => {
                  // 鼠标中键：关掉
                  if (event.button !== 1) return
                  event.preventDefault()
                  closeFile(uiKey, tab.path)
                }}
              >
                <span className="ell">{name}</span>
              </button>
              <button
                type="button"
                className="ibtn"
                data-tool="close"
                title={t('files.view.close', { name })}
                aria-label={t('files.view.close', { name })}
                onClick={() => closeFile(uiKey, tab.path)}
              >
                <Close />
              </button>
            </div>
          )
        })}
      </div>
      {active ? (
        <FileBody key={active.path} deviceId={deviceId} root={root} uiKey={uiKey} tab={active} />
      ) : null}
    </section>
  )
}
