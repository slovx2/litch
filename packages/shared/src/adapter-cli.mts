import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 适配器的命令行（Go 写的 codex-harness-adapter）在哪。带终端的命令和进程要回头用它的 pty-bridge 子命令。
//
// 命令行起运行时和设备进程的时候，把自己的路径放在这个环境变量里交过来（cmd/codex-harness-adapter 的
// adapterCLIEnvironment），以它为准。读走就从环境里拿掉：它是交给这个进程的，用户的命令、harness 的命令行、
// 模型跑的命令都不该继承到。不拿掉的话，在适配器的会话里跑这个仓库的测试，测到的就是正在运行的那一份命令行。
const ENVIRONMENT = 'CHA_ADAPTER_CLI'
const given = process.env[ENVIRONMENT] ?? ''
delete process.env[ENVIRONMENT]

const NAME = `codex-harness-adapter${process.platform === 'win32' ? '.exe' : ''}`

/**
 * 命令行的路径，找不到是空的。
 * 没有命令行那一层的时候（单元测试、夹具、直接跑源码）没人交路径过来，从这个文件往上找 bin/ 里的那一份：
 * 源码目录和三种分发形式都是 <根>/bin/codex-harness-adapter 配 <根>/packages/<包>/…。
 */
export function adapterCliPath(): string {
  if (given) return given
  let directory = dirname(fileURLToPath(import.meta.url))
  while (true) {
    const candidate = resolve(directory, 'bin', NAME)
    if (existsSync(candidate)) return candidate
    const parent = dirname(directory)
    if (parent === directory) return ''
    directory = parent
  }
}
