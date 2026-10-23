// 对话里提到的文件路径可以点开：在侧面板的文件标签里预览它，带行号的定位到那一行。
// 哪些字算路径由核心认（projection/file-refs.mts，认不准的宁可不认）；这里只管把认出来的画成能点的，
// 以及这个会话的路径相对于谁、点了去哪。
import {
  type DeviceView,
  type FileRef,
  type FileScope,
  fileRefOf,
  findFileRefs,
  insideRoot,
  keys,
  knownFileRef,
  normalizePath,
  pathTwin,
  type SessionSummary,
  type WorkspaceView,
} from '@litch/core'
import { createContext, type MouseEvent, type ReactNode, useContext, useMemo } from 'react'
import { useT } from '../app/appearance.ts'
import { useKey } from '../app/services.tsx'
import { openInFiles } from '../files/state.ts'
import { sessionRoots } from '../side/roots.ts'
import { ExternalLink } from './ExternalLink.tsx'

export interface FileLinks {
  scope: FileScope
  open(ref: FileRef): void
}

const Context = createContext<FileLinks | null>(null)

export const FileLinksProvider = Context.Provider

/**
 * 这个会话里的路径怎么认、点了去哪。路径要落在会话的根里（side/roots.ts，和侧面板的根一样：工作树、工作区、工作目录）；
 * 只读地看已归档的对话时没有摘要，也就不认路径。同一个目录的另一种写法按设备的系统认（pathTwin）
 */
export function useSessionFileLinks(
  deviceId: string,
  summary: SessionSummary | undefined,
): FileLinks | null {
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId))
  const os = useKey<DeviceView>(keys.device(deviceId))?.os
  const workspaceId = summary?.workspaceId ?? null
  const cwd = summary?.cwd ?? ''
  const roots = sessionRoots(summary, workspaces?.find((entry) => entry.id === workspaceId)?.roots)
  // 按内容比：侧栏每来一次增量，工作区的对象都是新的
  const rootsKey = roots.join('\n')
  // biome-ignore lint/correctness/useExhaustiveDependencies: roots 按内容（rootsKey）比
  return useMemo(() => {
    if (!summary) return null
    const here = cwd ? normalizePath(cwd) : ''
    const candidates = roots.map(normalizePath)
    const twin = pathTwin(os)
    // 工作区有几个根的：工作目录在哪个根里就认哪个
    const root = candidates.find((entry) => here && insideRoot(entry, here, twin)) ?? candidates[0]
    if (!root) return null
    return {
      scope: { root, cwd: here || root, twin },
      open: (ref) =>
        openInFiles({ deviceId, workspaceId, root, path: ref.path, alt: ref.alt, line: ref.line }),
    }
  }, [deviceId, summary !== undefined, workspaceId, cwd, rootsKey, os])
}

function FileLink({
  links,
  target,
  className,
  children,
}: {
  links: FileLinks
  target: FileRef
  className?: string
  children: ReactNode
}) {
  const t = useT()
  const open = (event: MouseEvent) => {
    event.preventDefault()
    links.open(target)
  }
  return (
    <a
      className={className ? `file-link ${className}` : 'file-link'}
      // 地址只是让它成为一个真的链接（键盘走得到、回车能开）；点了不跳转
      href={`#${encodeURI(target.path)}`}
      title={t('files.link.open', { path: target.path })}
      data-file={target.path}
      data-line={target.line ?? undefined}
      onClick={open}
      onAuxClick={open}
    >
      {children}
    </a>
  )
}

/** 行内代码。整段是工作区里的一个文件路径就能点 */
export function CodeSpan({ text }: { text: string }) {
  const links = useContext(Context)
  const target = links ? fileRefOf(text, links.scope) : null
  return (
    <code>
      {links && target ? (
        <FileLink links={links} target={target}>
          {text}
        </FileLink>
      ) : (
        text
      )}
    </code>
  )
}

/** 回答里的链接。地址是工作区里的文件路径的，在文件面板里打开；别的照外链办 */
export function Link({ href, children }: { href: string; children: ReactNode }) {
  const links = useContext(Context)
  let target: FileRef | null = null
  if (links && !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    let path = href
    try {
      path = decodeURI(href)
    } catch {
      // 解不开就照原样认
    }
    target = fileRefOf(path, links.scope)
  }
  if (!links || !target) return <ExternalLink href={href}>{children}</ExternalLink>
  return (
    <FileLink links={links} target={target}>
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
      <FileLink key={span.start} links={links} target={span.ref}>
        {text.slice(span.start, span.end)}
      </FileLink>,
    )
    at = span.end
  }
  if (at < text.length) out.push(text.slice(at))
  return out
}

/** 工具调用里的文件路径（引擎给的，明知是文件）：在工作区里的就能点 */
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
