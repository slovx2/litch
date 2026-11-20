// 运行时只向本机设备请求当前线程的启动增量；凭据本身始终由 GitHub 助手回调。
import { createHash } from 'node:crypto'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'

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

export async function deviceGithubEnvironment(
  harness: string,
  threadId: string,
  env: NodeJS.ProcessEnv,
): Promise<{ env: NodeJS.ProcessEnv; ghPath?: string; ghArgs?: string[]; release(): void }> {
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
    release: () => {
      void request(path, { action: 'release', lease: value.lease })
    },
  }
}
