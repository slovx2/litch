const pathKeys = new Set([
  'cwd',
  'path',
  'filePath',
  'file_path',
  'sourcePath',
  'destinationPath',
  'workspaceRoot',
])
const pathLists = new Set(['writableRoots', 'additionalDirectories'])

// Windows SFTP 用 /C:/... 表示盘符；交给 SDK 和 fs 前恢复为 Windows 原生绝对路径。
export function nativeWirePaths<T>(value: T, platform = process.platform): T {
  if (platform !== 'win32' || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => nativeWirePaths(item, platform)) as T
  const path = (item: unknown) =>
    typeof item === 'string' && /^\/[a-z]:\//i.test(item) ? item.slice(1) : item
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      pathKeys.has(key)
        ? path(item)
        : pathLists.has(key) && Array.isArray(item)
          ? item.map(path)
          : nativeWirePaths(item, platform),
    ]),
  ) as T
}
