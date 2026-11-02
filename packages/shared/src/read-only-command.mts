// 受控查询共用的进程边界；不经 shell，不在缺少沙箱时回落裸命令。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export class ReadCommandError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export function readOnlyCommand(
  command: string[],
  cwd: string,
  platform = process.platform,
): {
  argv: string[]
  boundary: 'sandboxed' | 'controlled-methods'
} {
  if (platform === 'win32') return { argv: command, boundary: 'controlled-methods' }
  if (platform === 'darwin') {
    const sandbox = '/usr/bin/sandbox-exec'
    if (!existsSync(sandbox))
      throw new ReadCommandError('sandbox_unavailable', 'sandbox-exec is unavailable.')
    return {
      boundary: 'sandboxed',
      argv: [
        sandbox,
        '-p',
        '(version 1)(allow default)(deny file-write*)(allow file-write* (literal "/dev/null"))(deny network*)',
        ...command,
      ],
    }
  }
  if (platform === 'linux') {
    const sandbox = '/usr/bin/bwrap'
    if (!existsSync(sandbox))
      throw new ReadCommandError('sandbox_unavailable', 'bubblewrap is unavailable.')
    return {
      boundary: 'sandboxed',
      argv: [
        sandbox,
        '--die-with-parent',
        '--new-session',
        '--unshare-all',
        '--ro-bind',
        '/',
        '/',
        '--dev',
        '/dev',
        '--proc',
        '/proc',
        '--chdir',
        cwd,
        '--',
        ...command,
      ],
    }
  }
  throw new ReadCommandError(
    'sandbox_unavailable',
    'No read-only command sandbox for this platform.',
  )
}

export interface ReadCommandResult {
  code: number | null
  stdout: Buffer
  stderr: string
  truncated: boolean
  boundary: 'sandboxed' | 'controlled-methods'
}

export async function runReadOnlyCommand(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  maxBytes = 512 * 1024,
): Promise<ReadCommandResult> {
  signal.throwIfAborted()
  const { argv, boundary } = readOnlyCommand(command, cwd)
  const executable = argv[0]
  if (!executable) throw new ReadCommandError('invalid', 'Missing executable.')
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv.slice(1), {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const chunks: Buffer[] = []
    let bytes = 0
    let stderr = ''
    let truncated = false
    const abort = () => child.kill('SIGKILL')
    signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      const remaining = maxBytes - bytes
      if (remaining > 0) {
        chunks.push(chunk.subarray(0, remaining))
        bytes += Math.min(remaining, chunk.length)
      }
      if (chunk.length > remaining) {
        truncated = true
        child.kill('SIGKILL')
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8').slice(0, Math.max(0, 4096 - stderr.length))
    })
    const cleanup = () => signal.removeEventListener('abort', abort)
    child.once('error', (error) => {
      cleanup()
      reject(new ReadCommandError('unavailable', error.message))
    })
    child.once('close', (code) => {
      cleanup()
      if (signal.aborted) reject(new ReadCommandError('cancelled', 'Query cancelled or timed out.'))
      else if (code !== 0 && /^(sandbox-exec|bwrap):/m.test(stderr))
        reject(new ReadCommandError('sandbox_unavailable', stderr))
      else resolve({ code, stdout: Buffer.concat(chunks), stderr, truncated, boundary })
    })
    if (signal.aborted) abort()
  })
}
