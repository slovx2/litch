// macOS 上给装好的应用做本机的临时签名（没有开发者身份，换一台机器不认）。
//
// 应用里除了 Electron 自己的那些，还有内置适配器带的可执行文件（Go 的命令行、Node），放在
// Contents/Resources/adapter 下面。codesign 的 --deep 只会进到框架、辅助应用这些标准位置去签，
// Resources 下面的可执行文件它只当成资源记一个哈希，不给它们签名。所以这里先把它们各签一遍，
// 再给整个应用签：里面的先签、外面的后签，顺序反了外面记下的哈希就对不上了。
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { HELPER_APP_NAME, signHelper } from '../../computer-use/build-app.mjs'

/** Mach-O 的文件头：64 位、32 位（两种字节序），和装着几种架构的胖文件 */
const THIN = new Set(['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface'])
const FAT = 'cafebabe'

function isMachO(file) {
  const head = Buffer.alloc(8)
  const handle = openSync(file, 'r')
  try {
    if (readSync(handle, head, 0, 8, 0) < 8) return false
  } finally {
    closeSync(handle)
  }
  const magic = head.toString('hex', 0, 4)
  if (THIN.has(magic)) return true
  // Java 的 class 文件开头也是这四个字节，后面跟的是版本号（几十）；胖文件后面跟的是架构的个数（个位数）
  return magic === FAT && head.readUInt32BE(4) < 20
}

/** 目录里所有的 Mach-O 文件。不跟符号链接走 */
export function machOFiles(directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...machOFiles(path))
    else if (entry.isFile() && isMachO(path)) found.push(path)
  }
  return found
}

const codesign = (...args) =>
  execFileSync('codesign', args, { stdio: ['ignore', 'inherit', 'inherit'] })

/**
 * 给应用做临时签名，返回内置适配器里签过的那些文件。
 * 这样签过之后，官方 Node 原来的签名和它声明的权限就没有了：临时签名不开“加固的运行时”，用不着那些权限；
 * 将来换成开发者身份签名时要开，那时得把 Node 要的权限（允许即时编译等）一起带上。
 */
export function signAdHoc(appPath) {
  const adapter = join(appPath, 'Contents', 'Resources', 'adapter')
  const inner = machOFiles(adapter)
  for (const file of inner) codesign('--force', '--sign', '-', file)
  // 打包器改了应用的名字和信息，原来那份签名对不上了：整个重新签一次，
  // 这样系统认得出它是“Litch”而不是“Electron”
  codesign('--force', '--deep', '--sign', '-', appPath)
  // Computer Use 的助手在 SharedSupport 里，--deep 刚才把它也签成了没有加固运行时的样子：按它自己的规矩
  // （加固的运行时、固定的签名标识）重签一遍，外层的签名记着里面的哈希，所以外层只签自己（不带 --deep）再签一次
  const helper = join(appPath, 'Contents', 'SharedSupport', HELPER_APP_NAME)
  if (existsSync(helper)) {
    signHelper(helper, {})
    codesign('--force', '--sign', '-', appPath)
  }
  codesign('--verify', '--deep', '--strict', appPath)
  return inner
}
