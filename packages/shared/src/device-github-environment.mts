// 运行时只向本机设备请求当前线程的启动增量；凭据本身始终由 GitHub 助手回调。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'

/**
 * 命令里哪个变量放它所在的 Litch 会话号（与 Go 入口 agentHasGithubContext 一致）：原生 codex、Pi、dsh 用自己给命令的，
 * 其余（Claude、OpenCode、ACP、Antigravity）由 Litch 给成 LITCH_THREAD_ID。Litch 自己起命令时（litch_shell 等）照这个写。
 */
export function githubThreadVariable(harness: string | undefined): string {
  return harness === 'codex'
    ? 'CODEX_THREAD_ID'
    : harness === 'pi'
      ? 'PI_SESSION_ID'
      : harness === 'dsh'
        ? 'DSH_SESSION_ID'
        : 'LITCH_THREAD_ID'
}

/**
 * 进程起来时还不知道会话号的（Gemini 的会话进程先起、session/new 之后才有会话号，见 packages/acp/src/session-agents.mts），
 * 环境里放这个变量指向一个文件，会话号写在文件里。LITCH_THREAD_ID 为空时才看它（与 Go 入口 agentHasGithubContext 一致）。
 */
export const THREAD_ID_FILE_VARIABLE = 'LITCH_THREAD_ID_FILE'

/** 读会话号文件：读不到、为空、太长或带空白以外的怪字符都算没有 */
export function threadIdFromFile(path: string | undefined): string | undefined {
  if (!path) return undefined
  try {
    const value = readFileSync(path, 'utf8').trim()
    return /^[\w:.-]{1,256}$/.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

export function deviceGithubEnvironmentSocket(deviceSocket: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\litch-github-env-${createHash('sha256').update(deviceSocket.toLowerCase()).digest('hex')}`
    : join(dirname(deviceSocket), 'ge.sock')
}

function request(socket: string, data: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const conn = connect(socket)
    let body = ''
    const finish = (value: unknown) => {
      resolve(value)
      conn.destroy()
    }
    conn.setEncoding('utf8')
    conn.setTimeout(3000, () => finish(null))
    conn.on('error', () => finish(null))
    conn.on('connect', () => conn.write(`${JSON.stringify(data)}\n`))
    conn.on('data', (part: string) => {
      body += part
      if (body.length > 32768) finish(null)
    })
    conn.on('end', () => {
      try {
        finish(JSON.parse(body))
      } catch {
        finish(null)
      }
    })
  })
}

/** 这个会话是不是经理注入了 GitHub 身份的会话；设备不在、问不到都算不是 */
export async function deviceGithubInjected(
  harness: string,
  threadId: string,
  deviceSocket: string,
): Promise<boolean> {
  if (!deviceSocket || !threadId || !harness) return false
  const value = (await request(deviceGithubEnvironmentSocket(deviceSocket), {
    action: 'probe',
    harness,
    threadId,
  })) as { injected?: unknown } | null
  return value?.injected === true
}

/** 设备上有没有哪位经理开着 GitHub 身份注入（不针对某个会话）；问不到算没有 */
export async function deviceGithubConfigured(deviceSocket: string): Promise<boolean> {
  if (!deviceSocket) return false
  const value = (await request(deviceGithubEnvironmentSocket(deviceSocket), {
    action: 'configured',
  })) as { injected?: unknown } | null
  return value?.injected === true
}

export async function deviceGithubEnvironment(
  harness: string,
  threadId: string,
  env: NodeJS.ProcessEnv,
): Promise<{
  env: NodeJS.ProcessEnv
  ghPath?: string
  ghArgs?: string[]
  release(uncertain?: boolean): void
}> {
  const deviceSocket = env.LITCH_DEVICE_SOCKET
  if (!deviceSocket || !threadId) return { env, release() {} }
  const path = deviceGithubEnvironmentSocket(deviceSocket)
  const base = Object.fromEntries(
    Object.entries(env).filter(([key]) => /^(?:PATH|GIT_CONFIG_COUNT)$/i.test(key)),
  )
  const value = (await request(path, { action: 'start', harness, threadId, base })) as {
    lease?: string
    env?: Record<string, string>
    ghPath?: string
    ghArgs?: string[]
  } | null
  if (!value || typeof value.lease !== 'string' || !value.env) return { env, release() {} }
  return {
    env: { ...env, ...value.env },
    ...(value.ghPath ? { ghPath: value.ghPath } : {}),
    ...(value.ghArgs ? { ghArgs: value.ghArgs } : {}),
    release: (uncertain) => {
      void request(path, {
        action: 'release',
        lease: value.lease,
        ...(uncertain ? { uncertain } : {}),
      })
    },
  }
}

/**
 * lark-cli 的租约：经理绑了飞书应用的会话拿设备代理的环境（占位令牌、签名钥匙、隔离目录）；
 * 没绑的交给宿主自己装的 lark-cli。绑了却拿不到（应用停用、凭据失效、设备没回）时只报原因，不回退宿主。
 */
export async function deviceFeishuEnvironment(
  harness: string,
  threadId: string,
  env: NodeJS.ProcessEnv,
): Promise<
  | { state: 'host' }
  | { state: 'error'; message: string }
  | { state: 'lease'; env: NodeJS.ProcessEnv; larkPath: string; release(): void }
> {
  const deviceSocket = env.LITCH_DEVICE_SOCKET
  if (!deviceSocket || !threadId) return { state: 'host' }
  const path = deviceGithubEnvironmentSocket(deviceSocket)
  const value = (await request(path, { action: 'feishu', harness, threadId })) as {
    lease?: unknown
    env?: Record<string, string>
    larkPath?: unknown
    error?: unknown
  } | null
  if (!value) return { state: 'error', message: 'the Litch device did not answer' }
  if (typeof value.error === 'string') return { state: 'error', message: value.error }
  if (typeof value.lease !== 'string' || typeof value.larkPath !== 'string' || !value.env)
    return { state: 'host' }
  // 宿主环境里的 lark-cli 变量（别的应用、令牌、配置目录）一律不带进来
  const base = Object.fromEntries(
    Object.entries(env).filter(([key]) => !/^LARKSUITE_CLI_/i.test(key)),
  )
  const lease = value.lease
  return {
    state: 'lease',
    env: { ...base, ...value.env },
    larkPath: value.larkPath,
    release: () => {
      void request(path, { action: 'release', lease })
    },
  }
}
