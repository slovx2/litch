import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** Go 模块目录只读；只处理本次临时树中的目录，不跟随符号链接。 */
export function removeTestTree(root) {
  const writable = (directory) => {
    const stat = lstatSync(directory)
    if (!stat.isDirectory()) return
    chmodSync(directory, stat.mode | 0o700)
    for (const name of readdirSync(directory)) writable(join(directory, name))
  }
  writable(root)
  rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
}
