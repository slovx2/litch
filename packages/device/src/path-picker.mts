import { constants } from 'node:fs'
import { access, lstat, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import type { PathPickerEntry, PathPickerListing } from '../../protocol/src/path-picker.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import { requireDeviceDirectory } from './directory-validation.mjs'
import { isObject } from './wire.mjs'

/** 复用 fs/readDirectory 取得名字，再补必要的文件类型与可执行标记；不读取内容。 */
export async function listDevicePaths(
  given: unknown,
  readDirectory: (path: string) => Promise<unknown>,
): Promise<PathPickerListing> {
  if (
    !isObject(given) ||
    Object.keys(given).some((key) => key !== 'path') ||
    (given.path !== null && typeof given.path !== 'string')
  )
    throw new ProtocolError(-32602, 'Expected {path: string | null}.')
  const path = requireDeviceDirectory(given.path === null ? homedir() : (given.path as string))
  const raw = await readDirectory(path)
  if (!isObject(raw) || !Array.isArray(raw.entries)) throw new Error('Invalid directory response.')
  const names = raw.entries
    .flatMap((entry) =>
      isObject(entry) && typeof entry.fileName === 'string' ? [entry.fileName] : [],
    )
    .sort((a, b) => a.localeCompare(b))
  const entries: PathPickerEntry[] = []
  let next = 0
  const selected = names.slice(0, 2000)
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';')
  await Promise.all(
    Array.from({ length: Math.min(8, selected.length) }, async () => {
      for (;;) {
        const name = selected[next++]
        if (name === undefined) return
        const full = join(path, name)
        const entry: PathPickerEntry = { name, kind: 'other', targetKind: null, executable: null }
        try {
          const link = await lstat(full)
          if (link.isSymbolicLink()) entry.kind = 'link'
          const target = link.isSymbolicLink() ? await stat(full) : link
          entry.targetKind = target.isDirectory() ? 'dir' : target.isFile() ? 'file' : null
          if (entry.kind !== 'link') entry.kind = entry.targetKind ?? 'other'
          if (target.isFile()) {
            entry.executable =
              process.platform === 'win32'
                ? extensions.includes(extname(name).toLowerCase())
                : await access(full, constants.X_OK).then(
                    () => true,
                    () => false,
                  )
          }
        } catch {
          /* 列目录期间文件被删除或链接失效，保留名称与已知类型。 */
        }
        entries.push(entry)
      }
    }),
  )
  entries.sort(
    (a, b) =>
      Number(b.targetKind === 'dir') - Number(a.targetKind === 'dir') ||
      a.name.localeCompare(b.name),
  )
  const parent = dirname(path)
  return {
    path,
    parent: parent === path ? null : parent,
    entries,
    total: names.length,
    truncated: names.length > selected.length,
  }
}
