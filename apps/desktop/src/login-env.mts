// 取用户登录 shell 里的环境。
//
// 从访达、程序坞打开的应用，拿到的环境是系统给的最小的一份：PATH 里只有系统目录，
// 用户在 shell 配置里加的那些（Homebrew、~/.local/bin、各种版本管理器）都不在。
// 内置的适配器要靠 PATH 找用户自己装的 harness，之后会话里跑的命令也都从它那里继承环境，
// 所以拉起它之前先问一遍登录 shell：环境应当和用户在终端里看到的一样。
//
// 这个模块不碰 Electron，自检直接拿它跑。
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'

/** 认得的 shell：都接受 `-ilc 命令`。别的（csh 一类）不问，免得传过去的参数被当成别的意思 */
const KNOWN = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh'])
/** 用户的配置可能很慢，也可能停下来等输入。到点不等了，当作没问到 */
const TIMEOUT_MS = 8000
/** 环境再大也不该超过这个数。超过了多半是配置里在往外吐别的东西 */
const OUTPUT_MAX = 1024 * 1024
/** 这几个说的是那个 shell 进程自己的状况，不是用户配置的东西，不带过来 */
const SKIPPED = new Set(['_', 'PWD', 'OLDPWD', 'SHLVL'])

export type Environment = Record<string, string>

/** 从 shell 的输出里取出两个标记之间的那一段，拆成一个个变量。配置里吐的欢迎语之类在标记之外，自然丢掉 */
export function parseEnvironment(output: string, mark: string): Environment | null {
  const from = output.indexOf(mark)
  const to = output.lastIndexOf(mark)
  if (from < 0 || to <= from) return null
  const result: Environment = {}
  for (const entry of output.slice(from + mark.length, to).split('\0')) {
    const at = entry.indexOf('=')
    if (at <= 0) continue
    const name = entry.slice(0, at)
    if (!SKIPPED.has(name)) result[name] = entry.slice(at + 1)
  }
  return Object.keys(result).length > 0 ? result : null
}

/**
 * 问一遍登录 shell。问不到（没有 shell、不认得、超时、输出读不懂）就是 null，调用方照旧用自己的环境。
 * 只读不写：不改任何配置文件，也不把结果存到磁盘上。
 */
export function loginEnvironment(
  shell: string | undefined = process.env.SHELL,
  timeoutMs: number = TIMEOUT_MS,
): Promise<Environment | null> {
  return new Promise<Environment | null>((resolve) => {
    if (!shell || !isAbsolute(shell) || !KNOWN.has(basename(shell))) {
      resolve(null)
      return
    }
    const mark = `__litch_env_${randomBytes(8).toString('hex')}__`
    // 登录加交互：有人把 PATH 写在登录用的配置里，有人写在交互用的配置里，两样都要读到
    const child = spawn(
      shell,
      ['-ilc', `printf '%s' '${mark}'; command env -0; printf '%s' '${mark}'`],
      // 自成一组：超时的时候连它起的东西一起结束
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    let output = ''
    let settled = false
    const settle = (value: Environment | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        // 已经不在了
      }
      settle(null)
    }, timeoutMs)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk
      if (output.length > OUTPUT_MAX) settle(null)
    })
    child.on('error', () => settle(null))
    // 退出码不看：配置里最后一句失败了，前面导出的环境照样是对的
    child.on('close', () => settle(parseEnvironment(output, mark)))
  })
}
