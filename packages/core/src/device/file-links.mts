// 点击时才验证候选。所有读取都经当前设备的 Files，不使用客户端主机的路径或 home。
import { type AbortSignalLike, ChannelError } from '../channel/protocol.mjs'
import type { FileContent, FileLinkResolution, FileLinkTarget } from '../model-files.mjs'
import { previewKind } from '../model-preview.mjs'
import type { FileRef } from '../projection/file-refs.mjs'
import { isAbsolutePath, normalizePath, parentPath, samePath, withinRoot } from '../text/paths.mjs'
import type { Files } from './files.mjs'

export async function resolveFileLink(
  files: Files,
  home: string | null,
  root: string,
  ref: FileRef,
  href: string,
  sameContent: (a: FileContent, b: FileContent) => boolean,
  signal?: AbortSignalLike,
): Promise<FileLinkResolution> {
  const attempted: string[] = []
  const candidates: FileLinkTarget[] = []
  const contents: FileContent[] = []
  const failures: FileLinkResolution['failures'] = []
  const expand = (path: string) => {
    if (path === '~' || path.startsWith('~/')) {
      if (!home) return null
      return normalizePath(home + path.slice(1))
    }
    return normalizePath(path)
  }
  for (const raw of ref.candidates ?? [ref.path, ...(ref.alt ? [ref.alt] : [])]) {
    const path = expand(raw)
    if (path === null) {
      failures.push({ path: raw, reason: 'home' })
      continue
    }
    if (attempted.some((other) => samePath(other, path))) continue
    attempted.push(path)
    if (!isAbsolutePath(path) || /^[\\/]{2}/.test(path) || /[\0\r\n]/.test(path)) {
      failures.push({ path, reason: 'unrecognized' })
      continue
    }
    const base = expand(root)
    // 根外文件以其父目录为新文件树根。预览仍只允许这个根内的真实路径与相对资源。
    const at = base && withinRoot(base, path) !== null ? base : (parentPath(path) ?? path)
    try {
      const target = await files.target(at, path, signal)
      const content = await files.read(target.root, target.path, signal)
      if (content.kind === 'missing') failures.push({ path, reason: 'missing' })
      else {
        candidates.push(target)
        contents.push(content)
      }
    } catch (error) {
      if (error instanceof ChannelError && error.code === 'cancelled') throw error
      const reason = /ENOENT|ENOTDIR|no such file|os error 2\b/i.test(String(error))
        ? 'missing'
        : error instanceof ChannelError && error.code === 'offline'
          ? 'offline'
          : error instanceof ChannelError && error.code === 'unsupported'
            ? 'unsupported'
            : /EACCES|EPERM|permission denied|access.*denied|os error (5|13)\b/i.test(String(error))
              ? 'permission'
              : 'read'
      failures.push({ path, reason })
    }
  }
  let identical = candidates.length <= 1
  if (
    contents.length > 1 &&
    contents.every((content) => content.kind === 'text' && !content.lossy)
  ) {
    const first = contents[0]
    identical = first?.kind === 'text' && contents.every((content) => sameContent(first, content))
  } else if (contents.length > 1 && contents.every((content) => content.kind === 'binary')) {
    // 二进制只走已有受限预览；旧服务或超过预算时不猜是否同内容，保留候选让人选。
    const bytes: string[] = []
    for (const candidate of candidates) {
      const format = previewKind(candidate.path)
      if (!format) break
      try {
        const preview = await files.preview(candidate.root, candidate.path, format, signal)
        if (preview.kind !== 'ready') break
        bytes.push(preview.dataBase64)
      } catch {
        break
      }
    }
    identical = bytes.length === candidates.length && bytes.every((value) => value === bytes[0])
  }
  // 其他候选权限不足/离线时也不能静默把第一个当作唯一命中。
  const uncertain = failures.some((failure) => failure.reason !== 'missing')
  return {
    status: candidates.length === 0 ? 'failed' : identical && !uncertain ? 'ready' : 'choose',
    href,
    path: expand(ref.path) ?? ref.path,
    attempted,
    candidates,
    failures,
  }
}
