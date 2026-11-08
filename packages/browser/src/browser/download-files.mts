// 发布时保留 Chromium 写入的系统隔离标记；普通 fs.copyFile 在 macOS 会丢弃扩展属性。
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { copyFile, link, unlink } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

export async function copyDownloadFile(source: string, destination: string): Promise<void> {
  await copyFile(source, destination, constants.COPYFILE_EXCL)
  try {
    if (process.platform !== 'darwin') return
    const options = { encoding: 'utf8' as const, timeout: 5000 }
    const names = await run('/usr/bin/xattr', [source], options)
    if (!names.stdout.split('\n').includes('com.apple.quarantine')) return
    const value = await run('/usr/bin/xattr', ['-px', 'com.apple.quarantine', source], options)
    await run(
      '/usr/bin/xattr',
      ['-wx', 'com.apple.quarantine', value.stdout.replace(/\s/g, ''), destination],
      options,
    )
  } catch (error) {
    // 不能把丢失隔离标记的副本当作下载成功；这一份目标是本次排他创建的。
    await unlink(destination)
    throw error
  }
}

export async function publishDownloadFile(source: string, destination: string): Promise<void> {
  try {
    // 同卷原子发布且保留文件元数据；不覆盖已存在的目标（含符号链接）。
    await link(source, destination)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (!['EXDEV', 'ENOTSUP', 'EOPNOTSUPP'].includes(code ?? '')) throw error
    // 系统“下载”目录可能在另一卷；排他复制，再恢复隔离标记。
    await copyDownloadFile(source, destination)
  }
}
