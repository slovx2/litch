// Windows 的 Computer Use 助手（apps/computer-use-win，Rust）：构建产物在哪、装进应用后放哪。
// 助手的位置和构建命令只写在这里，打包（pack.mjs）、做安装包（make-installer.mjs）、自检（check-computer-use.mjs）都从这里取。
//
// 打包不替你构建助手：先在 apps/computer-use-win 里跑一遍 WIN_HELPER_BUILD（发布流程在打包前跑）。
// 要在 crate 目录里跑：rustup 按当前目录找 rust-toolchain.toml，在仓库根目录用 --manifest-path 跑的话用的是默认工具链。
// 用别处编好的一份时，LITCH_COMPUTER_USE_WIN_HELPER 指过去（和主进程开发时找助手用的是同一个变量）。
// 本机打包暂时不想带助手（比如没装 Rust），设 LITCH_WITHOUT_COMPUTER_USE=1：打出来的应用里没有 Computer Use，
// 打包和做安装包都只给一句警告。发布流程不设它，没有助手就报错。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../..', import.meta.url))

/** 助手的可执行文件名 */
export const WIN_HELPER_EXE = 'litch-computer-use.exe'
/** 在应用资源目录里的子目录名：<resources>/computer-use/litch-computer-use.exe */
export const WIN_HELPER_DIR = 'computer-use'
/** 只出 x64：ARM64 版在里程碑 W5 以后 */
export const WIN_HELPER_TARGET = 'x86_64-pc-windows-msvc'
/** 助手的 crate 目录 */
export const WIN_HELPER_CRATE = join(repo, 'apps', 'computer-use-win')

/** 构建助手的命令（在 WIN_HELPER_CRATE 里跑） */
export const WIN_HELPER_BUILD = [
  'cargo',
  'build',
  '--release',
  '--locked',
  '--target',
  WIN_HELPER_TARGET,
]

/** 打包时取哪一份助手 */
export function winHelperPath() {
  return (
    process.env.LITCH_COMPUTER_USE_WIN_HELPER ||
    join(WIN_HELPER_CRATE, 'target', WIN_HELPER_TARGET, 'release', WIN_HELPER_EXE)
  )
}

/** 这次打包是不是明说了不带助手 */
export const withoutWinHelper = () => process.env.LITCH_WITHOUT_COMPUTER_USE === '1'

/** 找不到助手时的说法：怎么构建，或者怎么明说不带 */
export function missingWinHelper(path) {
  return (
    `没有找到 Windows 的 Computer Use 助手 ${path}。先在 apps/computer-use-win 里构建：${WIN_HELPER_BUILD.join(' ')}` +
    `（用别处编好的一份就用 LITCH_COMPUTER_USE_WIN_HELPER 指过去）；` +
    '这次不带 Computer Use 的话设 LITCH_WITHOUT_COMPUTER_USE=1'
  )
}

/** 助手在不在：不在又没明说不带就抛错，明说了不带就返回 null */
export function requireWinHelper() {
  const path = winHelperPath()
  if (existsSync(path)) return path
  if (withoutWinHelper()) return null
  throw new Error(missingWinHelper(path))
}
