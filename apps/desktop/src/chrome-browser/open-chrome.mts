// 在 Google Chrome 里打开网址。扩展页（chrome://）和商店页都要在 Chrome 里开，不能交给系统默认浏览器。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** Windows 上 Chrome 正式版的几个安装位置（全机安装、每用户安装）。 */
function windowsChrome(): string | null {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA,
  ]
  for (const root of roots) {
    const file = root && join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')
    if (file && existsSync(file)) return file
  }
  return null
}

/** Linux 上按 PATH 找 Chrome 正式版，没有再找 Chromium。 */
function linuxChrome(): string | null {
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const name of names)
    for (const dir of dirs) if (existsSync(join(dir, name))) return join(dir, name)
  return null
}

export function openInChrome(url: string): Promise<void> {
  const [command, args] =
    process.platform === 'darwin'
      ? ['/usr/bin/open', ['-a', 'Google Chrome', url]]
      : [process.platform === 'win32' ? windowsChrome() : linuxChrome(), [url]]
  if (!command) return Promise.reject(new Error('Google Chrome was not found.'))
  return new Promise<void>((resolve, reject) => {
    // 已开着的 Chrome 会把网址交给现有窗口，新起的进程随即退出；首次启动时 Chrome 一直在跑，不等它
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      if (process.platform !== 'darwin') resolve()
    })
    if (process.platform === 'darwin')
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error('Could not open Chrome.')),
      )
  })
}
