import { join } from 'node:path'

/** 各宿主约定同一每用户路径；纯函数，不读取 HOME，也不创建目录。 */
export function chromeClaimDirectory(
  home: string,
  platform: string,
  localAppData?: string,
): string {
  const base =
    platform === 'darwin'
      ? join(home, 'Library/Application Support')
      : platform === 'win32'
        ? localAppData || join(home, 'AppData/Local')
        : join(home, '.local/state')
  return join(base, 'chrome-automation-claims', 'v1')
}
