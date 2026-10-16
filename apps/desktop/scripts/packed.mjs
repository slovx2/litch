// 装好的应用放在哪。打包脚本往这里写，自检脚本带 --packed 时从这里找。
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 打包的输出目录 */
export const OUT_DIR = fileURLToPath(new URL('../out', import.meta.url))

/** 装好的应用里那个可执行文件。这一版只出 macOS 的应用 */
export function packedBinary() {
  if (process.platform !== 'darwin') throw new Error('这一版只在 macOS 上打包')
  return join(OUT_DIR, `Litch-darwin-${process.arch}`, 'Litch.app/Contents/MacOS/Litch')
}
