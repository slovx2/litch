// Windows 路径统一用正斜杠传给设备；盘符和 UNC 根保留，比较时忽略大小写。
// 不接受依赖当前盘符的路径、设备命名空间或备用数据流，避免绕过访问范围。
export const windowsPath = (path: string): boolean => /^[a-z]:[/\\]|^[/\\]{2}/i.test(path)
export const windowsSystem = (system: string): boolean => /^windows\b|^win32$/i.test(system)

export function normalizeWindowsPath(raw: string): string | null {
  const path = raw.replace(/\\/g, '/')
  if (/[\0-\x1f<>"|?*]/.test(path) || /^\/\/[.?]\//.test(path)) return null
  const drive = /^([a-z]):\//i.exec(path)
  const unc = /^\/\/([^/]+)\/([^/]+)(?:\/|$)/.exec(path)
  if (!drive && !unc) return null
  const root = drive ? `${drive[1]?.toUpperCase()}:/` : `//${unc?.[1]}/${unc?.[2]}/`
  const tail = path.slice(drive ? 3 : (unc?.[0].length ?? 0))
  const parts: string[] = []
  for (const rawPart of tail.split('/')) {
    if (!rawPart || rawPart === '.') continue
    if (rawPart === '..') {
      parts.pop()
      continue
    }
    const part = rawPart.replace(/[ .]+$/, '')
    if (
      !part ||
      part.includes(':') ||
      /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)
    )
      return null
    parts.push(part)
  }
  if (unc && (/[ :.]$|:/.test(unc[1] ?? '') || /[ :.]$|:/.test(unc[2] ?? ''))) return null
  return parts.length ? root + parts.join('/') : root
}

/** 跨系统复制时，源文件名不能被 Windows 解释成别的目录、设备或同名别名。 */
export function windowsCopyPath(root: string, relative: string): string | null {
  if (!relative || relative.includes('\\')) return null
  const destination = `${root.replace(/\/$/, '')}/${relative}`
  return normalizeWindowsPath(destination) === destination ? destination : null
}
