// 清理器的磁盘边界：主目录可以使用系统规范路径，.litch、附件根和编号目录不允许软链。
import { lstat, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ATTACHMENT_ID } from '../../protocol/src/file-attachments.mjs'

export function attachmentId(home: string, path: string): string | null {
  if (
    !isAbsolute(path) ||
    path.includes('\0') ||
    path.split(/[\\/]/).some((p) => p === '..' || p === '.')
  )
    return null
  const root = join(home, '.litch', 'attachments')
  const parts = relative(root, path).split(sep)
  return parts.length === 2 && ATTACHMENT_ID.test(parts[0] ?? '') && parts[1] ? parts[0]! : null
}

export async function attachmentRoot(home: string): Promise<string | null> {
  try {
    const canonicalHome = await realpath(home)
    const parent = join(canonicalHome, '.litch')
    const root = join(parent, 'attachments')
    for (const path of [parent, root]) {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
        return null
    }
    return root
  } catch {
    return null
  }
}

export async function attachmentDirectory(root: string, id: string) {
  if (!ATTACHMENT_ID.test(id)) return null
  const path = join(root, id)
  try {
    const [info, actual] = await Promise.all([lstat(path), realpath(path)])
    if (!info.isDirectory() || info.isSymbolicLink() || actual !== path || dirname(actual) !== root)
      return null
    return { path, info }
  } catch {
    return null
  }
}

/** 不跟随目录内的软链；异常、太深或文件过多时放弃本次清理。 */
export async function safeAttachmentTree(root: string, directory: string): Promise<boolean> {
  if (dirname(directory) !== root || resolve(directory) !== directory) return false
  const pending = [directory]
  let budget = 10_000
  while (pending.length) {
    const current = pending.pop()!
    if (--budget < 0) return false
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (!path.startsWith(`${directory}${sep}`) || --budget < 0) return false
      const info = await lstat(path)
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) return false
      if ((await realpath(path)) !== path) return false
      if (info.isDirectory()) pending.push(path)
    }
  }
  return true
}
