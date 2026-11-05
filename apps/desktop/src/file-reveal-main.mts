// 只让可信主界面请求核心确认本机设备，再按文件面板的根核验真实路径。
import { access, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { FileRevealResult, FileSaveSource } from '@litch/core'
import { ipcMain, shell } from 'electron'
import type { SaveMainHost } from './file-save-main.mjs'

const REVEAL = 'file-reveal'
const inside = (root: string, path: string): boolean => {
  const rest = relative(root, path)
  return rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest)
}
const validPath = (path: unknown): path is string =>
  typeof path === 'string' &&
  isAbsolute(path) &&
  !/^[\\/]{2}|[\0\r\n]/.test(path) &&
  // Windows 的设备路径、UNC 与 NTFS 流不能交给系统文件管理器。
  !(process.platform === 'win32' && path.slice(2).includes(':'))

export async function revealLocalFile(source: FileSaveSource): Promise<FileRevealResult> {
  if (!validPath(source.root) || !validPath(source.path) || !inside(source.root, source.path))
    return 'denied'
  try {
    const [root, path] = await Promise.all([realpath(source.root), realpath(source.path)])
    if (!inside(root, path)) return 'denied'
    await access(path)
    const info = await stat(path)
    if (info.isDirectory()) return (await shell.openPath(path)) ? 'failed' : 'opened'
    if (!info.isFile()) return 'denied'
    shell.showItemInFolder(path)
    return 'opened'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing'
    return code === 'EACCES' || code === 'EPERM' ? 'denied' : 'failed'
  }
}

export function installFileReveal(host: Pick<SaveMainHost, 'isUiUrl' | 'send'>) {
  let next = 0
  const pending = new Map<number, (source: FileSaveSource | null | undefined) => void>()
  ipcMain.handle('litch:file-reveal', async (event, raw: unknown): Promise<FileRevealResult> => {
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame || !host.isUiUrl(frame.url)) return 'denied'
    const source = raw as FileSaveSource | null
    if (
      !source ||
      typeof source.deviceId !== 'string' ||
      !source.deviceId ||
      !validPath(source.root) ||
      !validPath(source.path)
    )
      return 'denied'
    if (pending.size >= 64) return 'failed'
    const id = ++next
    const checked = await new Promise<FileSaveSource | null | undefined>((resolve) => {
      const timer = setTimeout(() => finish(undefined), 10_000)
      const finish = (value: FileSaveSource | null | undefined) => {
        clearTimeout(timer)
        pending.delete(id)
        resolve(value)
      }
      pending.set(id, finish)
      if (!host.send({ type: REVEAL, id, source })) finish(undefined)
    })
    if (event.sender.isDestroyed() || event.sender.mainFrame !== frame || !host.isUiUrl(frame.url))
      return 'denied'
    if (checked === null) return 'remote'
    if (!checked) return 'failed'
    return revealLocalFile(checked)
  })
  return {
    receive(raw: unknown): boolean {
      const message = raw as {
        type?: string
        id?: number
        source?: FileSaveSource | null
        error?: boolean
      } | null
      if (message?.type !== REVEAL) return false
      if (typeof message.id === 'number')
        pending.get(message.id)?.(message.error ? undefined : message.source)
      return true
    },
    disconnected() {
      for (const done of pending.values()) done(undefined)
    },
  }
}
