// 调系统的 ssh：拼参数、把一段远程脚本跑到结束、把 ssh 自己的报错归到“哪一步没成”上。
// 只调用系统的 ssh 可执行文件，不内嵌任何 SSH 协议库；不传密码，不上传文件。
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import {
  type AbortSignalLike,
  ConnectError,
  type ConnectStage,
  phrase,
  type RemoteTarget,
  type Text,
} from '@litch/core'
import { sshBase } from './args.mjs'
import type { RemoteScript } from './script.mjs'

/** ssh 自己出错（连不上、认证没过、配置有问题）时的退出码 */
const SSH_FAILED = 255
/** 报错只留末尾这么多字 */
const TAIL = 2000

/** 跑远程脚本用的 ssh 参数 */
export function sshArgs(target: RemoteTarget): string[] {
  const { options, destination } = sshBase(target)
  // 远程命令固定是这一句，脚本从标准输入喂进去，见 script.mts
  return [...options, '--', destination, 'exec sh']
}

/** 交互式 shell 在没有终端时会抱怨这两句，和出了什么错没有关系 */
const NOISE = [/cannot set terminal process group/, /no job control in this shell/]

/** 报错的末尾，去掉那几句无关的 */
export function tailOf(stderr: string): string | null {
  const text = stderr
    .split('\n')
    .filter((line) => !NOISE.some((pattern) => pattern.test(line)))
    .join('\n')
    .trim()
  return text ? text.slice(-TAIL) : null
}

/** ssh 以 255 退出：从它的报错里认出是哪一种 */
export function sshFailure(stderr: string): ConnectError {
  const detail = tailOf(stderr)
  const has = (pattern: RegExp) => pattern.test(stderr)
  const fail = (stage: ConnectStage, text: Text, retriable: boolean) =>
    new ConnectError(stage, text, retriable, detail)
  if (has(/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed/i)) {
    return fail('hostKey', phrase('ssh.hostKeyChanged'), false)
  }
  if (has(/Host key verification failed|No \S+ host key is known for/i)) {
    return fail('hostKey', phrase('ssh.hostKeyUnknown'), false)
  }
  if (
    has(/Permission denied|Too many authentication failures|No more authentication methods/i) ||
    has(/sign_and_send_pubkey|agent refused operation/i)
  ) {
    return fail('auth', phrase('ssh.auth'), false)
  }
  if (has(/Bad configuration option|Bad owner or permissions|terminating, \d+ bad config/i)) {
    return fail('unreachable', phrase('ssh.config'), false)
  }
  // 解析不了名字、连接被拒、超时、网络不通、中途断开：过一会儿可能自己就好了
  return fail('unreachable', phrase('ssh.unreachable'), true)
}

export interface RunResult {
  /** 退出码。被信号结束时是 null */
  code: number | null
  /** 标记之后的标准输出。没见到标记就是空的 */
  out: string
  /** 见没见到标记：见到了说明内层脚本开始跑了 */
  marked: boolean
  stderr: string
}

export interface RunOptions {
  signal: AbortSignalLike
  timeoutMs: number
}

/** 起一个 ssh 子进程。起不来（比如这台电脑上没有 ssh 命令）会在它的 error 事件里报，见 spawnFailure */
export function spawnSsh(target: RemoteTarget): ChildProcessWithoutNullStreams {
  return spawn('ssh', sshArgs(target), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
}

export const spawnFailure = (error: NodeJS.ErrnoException): ConnectError =>
  error.code === 'ENOENT'
    ? new ConnectError('unreachable', phrase('ssh.noClient'), false)
    : new ConnectError('unreachable', phrase('ssh.failed', { code: error.code ?? '' }), true)

/** 把一段脚本在对面跑到结束。ssh 自己出的错直接抛出来；脚本的退出码交给调用方去认 */
export function runRemote(
  target: RemoteTarget,
  script: RemoteScript,
  options: RunOptions,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawnSsh(target)
    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (run: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      run()
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle(() =>
        reject(
          new ConnectError(
            'unreachable',
            phrase('ssh.timeout', { seconds: Math.round(options.timeoutMs / 1000) }),
            true,
            tailOf(stderr),
          ),
        ),
      )
    }, options.timeoutMs)
    options.signal.addEventListener(
      'abort',
      () => {
        child.kill('SIGKILL')
        settle(() => reject(new ConnectError('unreachable', phrase('connect.cancelled'))))
      },
      { once: true },
    )
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-TAIL * 4)
    })
    child.on('error', (error) => settle(() => reject(spawnFailure(error))))
    child.on('close', (code) => {
      settle(() => {
        const at = stdout.indexOf(`${script.marker}\n`)
        // 没见到标记就以 255 结束：是 ssh 自己没连上，不是脚本的事
        if (code === SSH_FAILED && at < 0) return reject(sshFailure(stderr))
        resolve({
          code,
          out: at < 0 ? '' : stdout.slice(at + script.marker.length + 1),
          marked: at >= 0,
          stderr,
        })
      })
    })
    // 对面的 sh 可能已经退了（ssh 没连上），这时往里写会报错，不用管，退出码会说明原因
    child.stdin.on('error', () => {})
    child.stdin.end(script.text)
  })
}

/** 脚本输出里的 `键=值` 行。同一个键出现多次的拼成多行 */
export function fields(out: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of out.split('\n')) {
    const at = line.indexOf('=')
    if (at <= 0) continue
    const key = line.slice(0, at)
    const value = line.slice(at + 1)
    result[key] = key in result ? `${result[key]}\n${value}` : value
  }
  return result
}
