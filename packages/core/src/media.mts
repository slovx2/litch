import type { FileScope } from './projection/file-refs.mjs'
import { isAbsolutePath, joinPath, normalizePath, parentPath } from './text/paths.mjs'

export type ImageTarget =
  | { kind: 'external'; href: string }
  | { kind: 'blocked'; reason: 'outside' | 'unsupported' }
  | { kind: 'file'; root: string; path: string; format: 'image' | 'svg' }

/** 相对路径只按会话 cwd 解释；绝对路径可预览，但拒绝逃逸写法、UNC 和任意 URI。 */
export function transcriptImageTarget(href: string, scope: FileScope | null): ImageTarget {
  if (/^https?:\/\//i.test(href)) return { kind: 'external', href }
  const blocked = (reason: 'outside' | 'unsupported'): ImageTarget => ({ kind: 'blocked', reason })
  if (!href || href.length > 4096) return blocked('unsupported')
  let path: string
  try {
    path = decodeURIComponent(href.split('#')[0] ?? '')
  } catch {
    return blocked('unsupported')
  }
  if (
    !path ||
    /^[\\/]{2}/.test(path) ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.startsWith('~') ||
    path.split(/[\\/]/).includes('..') ||
    (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path))
  )
    return blocked('unsupported')
  if (/^[a-z]:[\\/]/i.test(scope?.cwd ?? path)) path = path.replaceAll('\\', '/')
  if (path.includes('\\')) return blocked('unsupported')
  if (!isAbsolutePath(path) && !scope) return blocked('unsupported')
  const full = isAbsolutePath(path) ? normalizePath(path) : joinPath(scope?.cwd ?? '', path)
  if (!isAbsolutePath(full)) return blocked('unsupported')
  return { kind: 'file', root: parentPath(full) ?? full, path: full, format: 'image' }
}
