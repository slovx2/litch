import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { hostPi } from './versions.mjs'

// 设置页要用、但 Pi 没从包入口导出的几处内部模块（设置文件的锁、MCP 配置与登录、各家的默认模型）。
// 和 sdk.mts 加载内置扩展清单一样，按用户安装的 Pi 里的文件位置加载；用到时才加载，
// 换了版本找不到时只有设置页报“读不了”，不连累会话。

/** 设置文件的读改写，持 Pi 自己的文件锁（和命令行、TUI 改设置用的同一把） */
export interface SettingsStorage {
  withLock(
    scope: 'global' | 'project',
    fn: (current: string | undefined) => string | undefined,
  ): void
}

export interface McpEntry {
  name: string
  config: Record<string, any>
  source: string
  scope?: string
}

export interface McpConnection {
  readonly state: string
  readonly error?: string
  readonly oauthUrl: string | undefined
  readonly tools: Array<{ name: string }>
  challenge: unknown
  getClient(): Promise<unknown>
  reconnect(): Promise<unknown>
  oauthSettings(): Record<string, unknown>
  close(): Promise<void>
}

export class InternalsUnavailable extends Error {}

const cache = new Map<string, Promise<any>>()
function load(path: string, names: string[]): Promise<any> {
  let loading = cache.get(path)
  if (!loading) {
    const url = new URL(path, pathToFileURL(hostPi().sdkEntry))
    loading = import(url.href).then((module) => {
      const missing = names.filter((name) => module[name] === undefined)
      if (missing.length) throw new Error(`缺少 ${missing.join('、')}`)
      return module
    })
    cache.set(path, loading)
  }
  return loading.catch((error) => {
    cache.delete(path)
    throw new InternalsUnavailable(
      `用户安装的 Pi ${hostPi().version} 里找不到 ${path}（${error instanceof Error ? error.message : String(error)}）`,
    )
  })
}

export async function settingsStorage(agentDir: string): Promise<SettingsStorage> {
  const { FileSettingsStorage } = await load('./core/settings-manager.js', ['FileSettingsStorage'])
  // 第一个参数是工作目录，只用来找项目设置；这里只写用户层
  return new FileSettingsStorage(agentDir, agentDir)
}

export interface McpConfigModule {
  loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): {
    servers: McpEntry[]
    errors: string[]
  }
  addMcpServerConfig(path: string, name: string, config: Record<string, unknown>): boolean
  removeMcpServerConfig(path: string, name: string): boolean
}

export const mcpConfig = (): Promise<McpConfigModule> =>
  load('./extensions/mcp/config.js', [
    'loadMcpConfig',
    'addMcpServerConfig',
    'removeMcpServerConfig',
  ])

/** 和 `pi mcp login` 一样建一条连接（只为登录：先连一次看要不要登录，登录完再连一次） */
export async function mcpConnection(entry: McpEntry, cwd: string, agentDir: string) {
  const runtime = await load('./extensions/mcp/runtime.js', [
    'McpServerConnection',
    'McpServerLog',
    'McpOAuthCredentialStore',
    'createDefaultTransport',
    'signInMcpServer',
  ])
  const credentials = new runtime.McpOAuthCredentialStore()
  const connection: McpConnection = new runtime.McpServerConnection({
    entry,
    cwd,
    createTransport: runtime.createDefaultTransport,
    credentials,
    log: new runtime.McpServerLog(join(agentDir, 'mcp.log')),
    onTools: () => {},
  })
  return {
    connection,
    credentials: credentials as {
      forServer(url: string): unknown
      tokens(url: string): unknown
      remove(url: string): boolean
    },
    signIn: runtime.signInMcpServer as (options: {
      serverUrl: string
      store: unknown
      settings: Record<string, unknown>
      challenge: unknown
      prompt: {
        showAuthorizationUrl(url: URL): void
        promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined>
      }
    }) => Promise<void>,
    Cancelled: runtime.McpSignInCancelledError as new () => Error,
  }
}

/** 登录后、切换 provider 时 Pi 给这家选的默认模型 */
export async function defaultModelPerProvider(): Promise<Record<string, string>> {
  return (await load('./core/model-resolver.js', ['defaultModelPerProvider']))
    .defaultModelPerProvider
}
