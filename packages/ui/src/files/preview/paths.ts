import { isAbsolutePath, joinPath, normalizePath, parentPath, withinRoot } from '@litch/core'

export type DocumentTarget =
  | { kind: 'external'; href: string }
  | { kind: 'local'; path: string; line?: number; fragment?: string }
  /** outside：路径本身没问题，只是出了项目根目录 */
  | { kind: 'blocked'; outside?: true }

/** 文件内链接使用文件目录，不使用会话 cwd；URL 解码后再次拒绝 scheme/UNC/NUL。 */
export function documentTarget(root: string, path: string, href: string): DocumentTarget {
  if (/^https?:\/\//i.test(href)) return { kind: 'external', href }
  const hash = href.indexOf('#')
  let name: string, fragment: string
  try {
    name = decodeURIComponent(hash >= 0 ? href.slice(0, hash) : href)
    fragment = hash >= 0 ? decodeURIComponent(href.slice(hash + 1)) : ''
  } catch {
    return { kind: 'blocked' }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(name) && !/^[a-z]:[\\/]/i.test(name)) return { kind: 'blocked' }
  if (/^[\\/]{2}/.test(name) || /[\0\r\n]/.test(name + fragment)) return { kind: 'blocked' }
  const location = fragment.match(/^L(\d+)(?:-L?\d+)?$/)
  const colon = name.match(/:(\d+)(?::\d+)?$/)
  if (colon) name = name.slice(0, colon.index)
  const full = !name
    ? path
    : isAbsolutePath(name)
      ? normalizePath(name)
      : joinPath(parentPath(path) ?? root, name)
  const safe = withinRoot(root, full)
  if (safe === null) return { kind: 'blocked', outside: true }
  const line = Number(location?.[1] ?? colon?.[1])
  return {
    kind: 'local',
    path: safe,
    ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}),
    ...(!location && fragment ? { fragment } : {}),
  }
}

export const headingSlug = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\-\s]/gu, '')
    .replace(/\s+/g, '-') || 'section'
