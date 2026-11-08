import { spawn } from 'node:child_process'
import { win32 } from 'node:path'
import { checkCancelled, ReadFault } from './result.mjs'

export interface CommandResult {
  code: number
  stdout: Buffer
  stderr: Buffer
}
export type RunCommand = (
  file: string,
  args: string[],
  input: Buffer,
  signal: AbortSignal,
  options?: { env?: NodeJS.ProcessEnv },
) => Promise<CommandResult>

// 只用管道传数据；不建 shell、不把密文或明文放进参数、错误、日志。
export const runCommand: RunCommand = async (file, args, input, signal, options) => {
  checkCancelled(signal)
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...options,
    })
    let stdout: Buffer[] = []
    let stderr: Buffer[] = []
    let bytes = 0
    let stopped = false
    let timedOut = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      child.kill()
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 500)
    }
    const abort = () => {
      stopped = true
      stop()
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, 120_000)
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 8 * 1024 * 1024) {
        timedOut = true
        stop()
        chunk.fill(0)
      } else target.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk))
    // spawn 失败也会发 close；不在 error 里提前结束，保证退出后再清理文件。
    child.on('error', () => {
      timedOut = true
    })
    child.stdin.on('error', () => {
      /* 提前退出时 EPIPE 不得泄露输入或成为未处理异常。 */
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      signal.removeEventListener('abort', abort)
      const output = {
        code: code ?? -1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      }
      for (const buffer of [...stdout, ...stderr]) buffer.fill(0)
      stdout = []
      stderr = []
      if (stopped || timedOut) {
        output.stdout.fill(0)
        output.stderr.fill(0)
        reject(new ReadFault(stopped ? 'cancelled' : 'failed'))
      } else resolve(output)
    })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.stdin.end(input)
  })
}

export function powershellPath(): string {
  return win32.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
}

export async function powershell(
  script: string,
  input: Buffer,
  signal: AbortSignal,
  run: RunCommand = runCommand,
): Promise<CommandResult> {
  // EncodedCommand 只有固定程序，用户数据只在 stdin。
  return run(
    powershellPath(),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(
        `[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)\n${script}`,
        'utf16le',
      ).toString('base64'),
    ],
    input,
    signal,
  )
}

export async function restrictWindowsDirectory(path: string, signal: AbortSignal): Promise<void> {
  const output = await powershell(
    `
$ErrorActionPreference = 'Stop'
try {
  $path = [Console]::In.ReadToEnd()
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $path -AclObject $acl
  exit 0
} catch { exit 1 }
`,
    Buffer.from(path),
    signal,
  )
  output.stdout.fill(0)
  output.stderr.fill(0)
  if (output.code !== 0) throw new ReadFault('failed')
}
