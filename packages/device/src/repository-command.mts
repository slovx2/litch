import { execFile } from 'node:child_process'

export class RepositoryCommandError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export interface RepositoryCommandResult {
  code: number | null
  stdout: Buffer
  stderr: string
  truncated: boolean
}

export async function runGit(
  argv: string[],
  cwd: string,
  signal: AbortSignal,
  maxBytes = 512 * 1024,
): Promise<RepositoryCommandResult> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    // 使用设备 PATH 和环境，不经 shell；Git 自身的配置、钩子及子进程照常生效。
    execFile(
      'git',
      argv,
      {
        cwd,
        signal,
        killSignal: 'SIGKILL',
        maxBuffer: maxBytes,
        encoding: 'buffer',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (signal.aborted) {
          reject(new RepositoryCommandError('cancelled', 'Git command cancelled or timed out.'))
          return
        }
        const limited = error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        if (error && typeof error.code !== 'number' && !limited) {
          reject(new RepositoryCommandError('unavailable', error.message))
          return
        }
        const output = stdout.subarray(0, maxBytes)
        const remaining = Math.max(0, maxBytes - output.length)
        resolve({
          code: limited ? null : typeof error?.code === 'number' ? error.code : 0,
          stdout: output,
          stderr: stderr.subarray(0, remaining).toString('utf8'),
          truncated: limited || stdout.length + stderr.length > maxBytes,
        })
      },
    )
  })
}
