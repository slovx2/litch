// 对话里提到的文件路径可以点开：在侧面板的文件标签里预览它，带行号的定位到那一行。
// 哪些字算路径由核心认（projection/file-refs.mts，认不准的宁可不认）；这里只管把认出来的画成能点的，
// 以及这个会话的路径相对于谁、点了去哪。
import {
  type DeviceView,
  explicitFileRef,
  type FileLinkResolution,
  type FileLinkTarget,
  type FileRef,
  type FileScope,
  fileRefOf,
  findFileRefs,
  keys,
  knownFileRef,
  pathTwin,
  type SessionSummary,
  sessionFileScope,
  unrecognizedFileLink,
  type WorkspaceView,
} from '@litch/core'
import {
  createContext,
  type MouseEvent,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from 'react'
import { useT } from '../app/appearance.ts'
import { useKey, useServices } from '../app/services.tsx'
import { FileLinkDialog } from '../files/FileLinkDialog.tsx'
import { openInFiles } from '../files/state.ts'
import { ExternalLink } from './ExternalLink.tsx'

export interface FileLinks {
  scope: FileScope
  resolve?(ref: FileRef, href: string): Promise<FileLinkResolution>
  open(ref: FileRef, target?: FileLinkTarget, result?: FileLinkResolution): void
}

const Context = createContext<FileLinks | null>(null)

export const FileLinksProvider = Context.Provider

/**
 * 这个会话里的路径怎么认、点了去哪。默认文件树根优先工作树，相对路径保留项目全部根；
 * 只读地看已归档的对话时没有摘要，也就不认路径。同一个目录的另一种写法按设备的系统认（pathTwin）
 */
export function useSessionFileLinks(
  deviceId: string,
  summary: SessionSummary | undefined,
): FileLinks | null {
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId))
  const { channel } = useServices()
  const os = useKey<DeviceView>(keys.device(deviceId))?.os
  const workspaceId = summary?.workspaceId ?? null
  const cwd = summary?.cwd ?? ''
  const roots = workspaces?.find((entry) => entry.id === workspaceId)?.roots ?? []
  // 按内容比：侧栏每来一次增量，工作区的对象都是新的
  const rootsKey = roots.join('\n')
  // biome-ignore lint/correctness/useExhaustiveDependencies: roots 按内容（rootsKey）比
  return useMemo(() => {
    if (!summary) return null
    const scope = sessionFileScope(summary, roots, pathTwin(os))
    if (!scope) return null
    const root = scope.root
    return {
      scope,
      resolve: (ref, href) => channel.command('files.resolve', { deviceId, root, ref, href }),
      open: (ref, target, result) =>
        openInFiles({
          deviceId,
          ...(result ? { link: result } : {}),
          workspaceId,
          root: target?.root ?? root,
          ...(target ? { kind: target.kind } : {}),
          path: target?.path ?? ref.path,
          alt: target ? null : ref.alt,
          line: ref.line,
          ...(ref.fragment ? { fragment: ref.fragment } : {}),
        }),
    }
  }, [deviceId, summary !== undefined, summary?.worktree, workspaceId, cwd, rootsKey, os, channel])
}

function FileLink({
  links,
  target,
  className,
  children,
  href,
}: {
  links: FileLinks
  target: FileRef
  className?: string
  children: ReactNode
  href?: string
}) {
  const t = useT()
  const [result, setResult] = useState<FileLinkResolution | null>(null)
  const [busy, setBusy] = useState(false)
  const open = (event: MouseEvent) => {
    event.preventDefault()
    if (busy) return
    if (!links.resolve) return links.open(target)
    setBusy(true)
    void links
      .resolve(target, href ?? target.path)
      .then(
        (resolution) => {
          const found = resolution.candidates[0]
          if (resolution.status === 'ready' && found) links.open(target, found, resolution)
          else setResult(resolution)
        },
        () =>
          setResult({
            status: 'failed',
            href: href ?? target.path,
            path: target.path,
            attempted: [],
            candidates: [],
            failures: [{ path: target.path, reason: 'read' }],
          }),
      )
      .finally(() => setBusy(false))
  }
  return (
    <>
      <a
        className={className ? `file-link ${className}` : 'file-link'}
        // 地址只是让它成为一个真的链接（键盘走得到、回车能开）；点了不跳转
        href={`#${encodeURI(target.path)}`}
        title={t('files.link.open', { path: target.path })}
        data-file={target.path}
        data-line={target.line ?? undefined}
        onClick={open}
        onAuxClick={open}
        aria-busy={busy}
      >
        {children}
      </a>
      {result ? (
        <FileLinkDialog
          result={result}
          onClose={() => setResult(null)}
          onPick={(found) => {
            setResult(null)
            links.open(target, found, result)
          }}
        />
      ) : null}
    </>
  )
}

/** 行内代码。整段是文件路径就能点，存在性在点击时核实 */
export function CodeSpan({ text }: { text: string }) {
  const links = useContext(Context)
  const target = links ? fileRefOf(text, links.scope) : null
  return (
    <code>
      {links && target ? (
        <FileLink links={links} target={target} href={text}>
          {text}
        </FileLink>
      ) : (
        text
      )}
    </code>
  )
}

/** 回答里的文件链接在所属设备打开，网址走浏览器；未识别的明确链接说明原因 */
export function Link({ href, children }: { href: string; children: ReactNode }) {
  const links = useContext(Context)
  const [failure, setFailure] = useState<FileLinkResolution | null>(null)
  let target: FileRef | null = null
  if (links) target = explicitFileRef(href, links.scope)
  if (!links || !target) {
    if (/^https?:\/\//i.test(href)) return <ExternalLink href={href}>{children}</ExternalLink>
    return (
      <>
        <a
          href={`#${encodeURIComponent(href)}`}
          title={href}
          onClick={(event) => {
            event.preventDefault()
            setFailure(unrecognizedFileLink(href))
          }}
          onAuxClick={(event) => {
            event.preventDefault()
            setFailure(unrecognizedFileLink(href))
          }}
        >
          {children}
        </a>
        {failure ? (
          <FileLinkDialog result={failure} onClose={() => setFailure(null)} onPick={() => {}} />
        ) : null}
      </>
    )
  }
  return (
    <FileLink links={links} target={target} href={href}>
      {children}
    </FileLink>
  )
}

/** 一段正文。里面扫得出文件路径的，路径那几个字能点 */
export function Prose({ text }: { text: string }) {
  const links = useContext(Context)
  const spans = links ? findFileRefs(text, links.scope) : []
  if (!links || spans.length === 0) return text
  const out: ReactNode[] = []
  let at = 0
  for (const span of spans) {
    if (span.start > at) out.push(text.slice(at, span.start))
    out.push(
      <FileLink
        key={span.start}
        links={links}
        target={span.ref}
        href={text.slice(span.start, span.end)}
      >
        {text.slice(span.start, span.end)}
      </FileLink>,
    )
    at = span.end
  }
  if (at < text.length) out.push(text.slice(at))
  return out
}

/** 工具调用里的文件路径（引擎给的，明知是文件）：点击时核实 */
export function ToolPath({ path, className }: { path: string; className?: string }) {
  const links = useContext(Context)
  const target = links ? knownFileRef(path, links.scope) : null
  if (!links || !target) {
    return (
      <span className={className} title={path}>
        {path}
      </span>
    )
  }
  return (
    <FileLink links={links} target={target} {...(className ? { className } : {})}>
      {path}
    </FileLink>
  )
}
