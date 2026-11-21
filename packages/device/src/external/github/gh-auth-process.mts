// 固定 gh 负责网页授权。stdout/stderr 只在此处短暂解析，不透传到日志或协议。
import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { GITHUB_GH_VERIFICATION_URL, type GithubGhScope } from '../secrets-oauth-probe.mjs'
import { GithubWriteFault, isGithubScopedToken, login } from './write-api.mjs'

const maxOutput = 32768
const codePattern =
  /(?:First copy your one-time code|One-time code):\s*([A-Z0-9]{4}-[A-Z0-9]{4})(?=\s|$)/i
const urlPattern =
  /Open this URL to continue in your web browser:[ \t]*(https?:\/\/[^\s]+)(?=[\r\n \t])/i
function plain(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
}

interface RunOptions {
  ghPath: string
  configDirectory: string
  workingDirectory?: string
  args: string[]
  signal: AbortSignal
  useHostKeyring?: boolean
  onOutput?: (outputs: readonly string[]) => void
  promptTimeoutMs?: number
  hasPrompt?: () => boolean
}

function privateGhEnvironment(directory: string, useHostKeyring: boolean): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => /^(?:https?_proxy|no_proxy)$/i.test(key)),
    ),
    GH_CONFIG_DIR: directory,
    GH_HOST: 'github.com',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
    GH_TELEMETRY: 'false',
    GH_SPINNER_DISABLED: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    HOME: directory,
    USERPROFILE: directory,
    XDG_CONFIG_HOME: directory,
    APPDATA: directory,
    LANG: 'C',
    LC_ALL: 'C',
    NO_COLOR: '1',
    ...(process.platform === 'win32' && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
    ...(useHostKeyring && process.env.DBUS_SESSION_BUS_ADDRESS
      ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS }
      : {}),
    ...(useHostKeyring && process.env.XDG_RUNTIME_DIR
      ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }
      : {}),
  }
}

function stopped(signal: AbortSignal): GithubWriteFault {
  return signal.reason instanceof GithubWriteFault
    ? signal.reason
    : new GithubWriteFault('github_gh_login_canceled')
}

async function run(
  options: RunOptions,
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  if (!isAbsolute(options.ghPath) || !isAbsolute(options.configDirectory))
    throw new GithubWriteFault('github_gh_configuration_invalid')
  if (options.signal.aborted) throw stopped(options.signal)
  return new Promise((resolve, reject) => {
    const child = spawn(options.ghPath, options.args, {
      env: privateGhEnvironment(options.configDirectory, options.useHostKeyring === true),
      cwd: options.workingDirectory ?? options.configDirectory,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const output = ['', '']
    let failure: GithubWriteFault | undefined
    let promptTimer: NodeJS.Timeout | undefined
    const stop = (error: GithubWriteFault) => {
      failure ??= error
      child.kill('SIGKILL')
    }
    const abort = () => stop(stopped(options.signal))
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted) abort()
    if (options.promptTimeoutMs !== undefined)
      promptTimer = setTimeout(() => {
        if (!options.hasPrompt?.())
          stop(new GithubWriteFault('github_gh_device_prompt_unrecognized'))
      }, options.promptTimeoutMs)
    function append(index: number, part: string) {
      if (failure) return
      output[index] = (output[index] ?? '') + part
      if (output.reduce((total, value) => total + Buffer.byteLength(value), 0) > maxOutput)
        return stop(new GithubWriteFault('github_gh_output_too_large'))
      try {
        options.onOutput?.(output)
        if (promptTimer && options.hasPrompt?.()) clearTimeout(promptTimer)
      } catch (error) {
        stop(
          error instanceof GithubWriteFault
            ? error
            : new GithubWriteFault('github_gh_device_prompt_unrecognized'),
        )
      }
    }
    child.stdout.setEncoding('utf8').on('data', (part: string) => append(0, part))
    child.stderr.setEncoding('utf8').on('data', (part: string) => append(1, part))
    child.once('error', () => {
      failure ??= new GithubWriteFault('github_gh_process_unavailable')
    })
    child.once('close', (status) => {
      if (promptTimer) clearTimeout(promptTimer)
      options.signal.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else resolve({ stdout: output[0] ?? '', stderr: output[1] ?? '', status })
    })
  })
}

export async function runGithubGhDeviceLogin(input: {
  ghPath: string
  configDirectory: string
  scopes: readonly GithubGhScope[]
  signal: AbortSignal
  promptTimeoutMs: number
  onCode(code: { userCode: string; verificationUrl: typeof GITHUB_GH_VERIFICATION_URL }): void
}): Promise<void> {
  let codeDisplayed = false
  const result = await run({
    ...input,
    args: [
      'auth',
      'login',
      '--hostname',
      'github.com',
      '--git-protocol',
      'https',
      '--web',
      '--scopes',
      input.scopes.join(','),
      '--insecure-storage',
      '--clipboard=false',
    ],
    hasPrompt: () => codeDisplayed,
    onOutput: (outputs) => {
      if (codeDisplayed) return
      const streams = outputs.map(plain)
      const code = streams.map((value) => codePattern.exec(value)?.[1]).find(Boolean)
      const url = streams.map((value) => urlPattern.exec(value)?.[1]).find(Boolean)
      // URL 到达空白才构成完整输出；不解析半截 URL，也不对外发非预期地址。
      if (url && url !== GITHUB_GH_VERIFICATION_URL)
        throw new GithubWriteFault('github_gh_device_url_untrusted')
      if (code && url === GITHUB_GH_VERIFICATION_URL) {
        codeDisplayed = true
        input.onCode({ userCode: code.toUpperCase(), verificationUrl: GITHUB_GH_VERIFICATION_URL })
      }
    },
  })
  const report = plain(`${result.stderr}\n${result.stdout}`)
  if (
    result.status !== 0 &&
    /expired_token|(?:one-time|device|verification)?\s*code[^\n]{0,70}expir|device code expired/i.test(
      report,
    )
  )
    throw new GithubWriteFault('github_gh_device_code_expired')
  if (!codeDisplayed) throw new GithubWriteFault('github_gh_device_prompt_unrecognized')
  if (result.status !== 0) throw new GithubWriteFault('github_gh_login_failed')
}

export async function readGithubGhToken(input: {
  ghPath: string
  configDirectory: string
  workingDirectory?: string
  signal: AbortSignal
  useHostKeyring?: boolean
  accountLogin?: string
}): Promise<string> {
  if (input.accountLogin !== undefined && !login(input.accountLogin))
    throw new GithubWriteFault('github_gh_account_invalid')
  const result = await run({
    ...input,
    args: [
      'auth',
      'token',
      '--hostname',
      'github.com',
      ...(input.accountLogin ? ['--user', input.accountLogin] : []),
    ],
  })
  if (result.status !== 0) throw new GithubWriteFault('github_gh_login_token_unavailable')
  const token = result.stdout.trim()
  if (!isGithubScopedToken(token)) throw new GithubWriteFault('github_gh_token_unsupported')
  return token
}
