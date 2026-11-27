import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import { type ResolvedAgent, resolveAgent } from './agent.mjs'
import { type Catalog, models } from './catalog.mjs'
import { AcpError } from './connection.mjs'
import { AcpRuntime, type AgentHandle } from './runtime.mjs'

const CACHE_MS = 60_000
const AUTH_METHOD_FILE = join('cache', 'acp-auth-state.json')
const OAUTH_FILE = 'antigravity-oauth-token'
const AUTH_METHODS = new Set([
  'oauth-personal',
  'oauth-business',
  'gemini-api-key',
  'agent-platform',
])
type Snapshot = { catalog: Catalog; image: boolean }

/** 只认 CLI 帮助中定义的路径开关，处理等号和分开的写法，最后一个值生效。 */
function pathOption(args: string[], names: string[], fallback: string): string {
  let value = fallback
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    const at = arg.indexOf('=')
    if (names.includes(at === -1 ? arg : arg.slice(0, at)))
      value = (at === -1 ? args[++i] : arg.slice(at + 1)) || fallback
  }
  return value
}

function inside(root: string, path: string): boolean {
  const tail = relative(root, path)
  return !isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`)
}

function fileStamp(path: string, includeCtime = true) {
  const info = statSync(path, { throwIfNoEntry: false })
  return info
    ? [info.dev, info.ino, info.size, info.mtimeMs, includeCtime ? info.ctimeMs : null]
    : null
}

/** 只传递官方 ACP 持久化的登录方式标识，不复制登录令牌或其他字段。 */
function stageAuthMethod(data: string, scratch: string): void {
  const source = join(data, AUTH_METHOD_FILE)
  const info = lstatSync(source, { throwIfNoEntry: false })
  if (!info?.isFile() || info.size > 1024) return
  let methodId: unknown
  try {
    methodId = JSON.parse(readFileSync(source, 'utf8')).methodId
  } catch {
    return
  }
  if (typeof methodId !== 'string' || !AUTH_METHODS.has(methodId)) return
  mkdirSync(join(scratch, 'cache'), { mode: 0o700 })
  writeFileSync(join(scratch, AUTH_METHOD_FILE), JSON.stringify({ methodId }), { mode: 0o600 })
}

/** 由 agy 自己读同一令牌。清理只 unlink 探测端的入口；Litch 不接触令牌内容。 */
function stageOAuth(data: string, scratch: string): void {
  const source = join(data, OAUTH_FILE)
  if (!statSync(source, { throwIfNoEntry: false })?.isFile()) return
  const target = join(scratch, OAUTH_FILE)
  // Windows 普通用户可能没有创建符号链接的权限；这两个目录通常在同一卷。
  if (process.platform === 'win32') linkSync(realpathSync(source), target)
  else symlinkSync(source, target, 'file')
}

/** agy 的目录探测保留原 CLI 配置入口，只把会话和 ACP 日志写到本次独占的目录。 */
export class AgyCatalog {
  private readonly home: string
  private readonly env: NodeJS.ProcessEnv
  private readonly failure: (agent: AgentHandle, error: unknown) => ProtocolError
  private cache: { key: string; until: number; value: Snapshot } | null = null
  private pending: { key: string; value: Promise<Snapshot> } | null = null
  private epoch = 0
  private closed = false
  private runtime: AcpRuntime | null = null
  private stopping: Promise<void> | null = null

  constructor(
    home: string,
    env: NodeJS.ProcessEnv,
    failure: (agent: AgentHandle, error: unknown) => ProtocolError,
  ) {
    this.home = home
    this.env = env
    this.failure = failure
  }

  invalidate(): void {
    this.epoch++
    this.cache = null
  }

  async read(): Promise<Snapshot> {
    if (this.closed) throw new ProtocolError(-32603, '模型目录查询不可用')
    const agent = resolveAgent(this.env)
    const { args } = agent.spec
    const home = resolve(
      (process.platform === 'win32' ? this.env.USERPROFILE : this.env.HOME) || homedir(),
    )
    const gemini = resolve(home, pathOption(args, ['--gemini-dir', '--gemini_dir'], '.gemini'))
    const data = resolve(
      gemini,
      pathOption(args, ['--app-data-dir', '--app_data_dir'], 'antigravity-cli'),
    )
    const profile = resolve(data, pathOption(args, ['--cli_dir_name'], '.'))
    if (!inside(home, gemini) || !inside(gemini, data) || !inside(gemini, profile))
      throw new ProtocolError(-32603, '无法隔离 Antigravity 模型目录查询的数据路径')

    // 不读取令牌内容：只比较文件元数据，并在 Litch 登录或退出时明确作废。
    const key = JSON.stringify([
      this.epoch,
      agent.argv,
      fileStamp(agent.cli),
      fileStamp(join(profile, 'settings.json')),
      fileStamp(join(data, AUTH_METHOD_FILE)),
      // 硬链接的增加与移除可能只改 ctime；这种变化不是换账号。
      fileStamp(join(data, OAUTH_FILE), false),
    ])
    if (this.cache?.key === key && Date.now() < this.cache.until) return this.cache.value
    if (this.pending) {
      if (this.pending.key === key) return this.pending.value
      await this.pending.value.catch(() => {})
      return this.read()
    }
    const epoch = this.epoch
    const value = this.probe(agent, gemini, data, profile)
      .then((result) => {
        if (!this.closed && this.epoch === epoch && models(result.catalog).length)
          this.cache = { key, value: result, until: Date.now() + CACHE_MS }
        return result
      })
      .finally(() => {
        this.pending = null
      })
    this.pending = { key, value }
    return value
  }

  private async probe(
    resolved: ResolvedAgent,
    gemini: string,
    data: string,
    profile: string,
  ): Promise<Snapshot> {
    mkdirSync(gemini, { recursive: true, mode: 0o700 })
    const scratch = mkdtempSync(join(gemini, 'litch-catalog-'))
    const runtime = new AcpRuntime(
      this.home,
      {
        request: async () => {
          throw new AcpError(-32601, '模型目录查询不提供客户端工具')
        },
        notification() {},
        closed() {},
      },
      this.env,
      undefined,
      true,
    )
    this.runtime = runtime
    let agent: AgentHandle | undefined
    try {
      stageAuthMethod(data, scratch)
      stageOAuth(data, scratch)
      agent = await runtime.agent({
        ...resolved,
        argv: [
          ...resolved.argv,
          '--app-data-dir',
          basename(scratch),
          '--cli_dir_name',
          relative(scratch, profile),
          '--log-file',
          join(scratch, 'acp.log'),
          '--disable-telemetry',
        ],
      })
      const handle = agent
      // 先只读列会话，让官方 CLI 打开摘要库。包装命令忽略了路径参数时不要建会话。
      if (!handle.caps.list)
        throw new ProtocolError(-32603, '无法验证 Antigravity 探测目录：ACP 未声明会话列表')
      await handle.connection.request('session/list', {}, 5_000).catch((error) => {
        throw this.failure(handle, error)
      })
      if (
        !lstatSync(join(scratch, 'conversation_summaries.db'), { throwIfNoEntry: false })?.isFile()
      )
        throw new ProtocolError(-32603, 'Antigravity 未在独立目录打开摘要库，已跳过模型探测')
      const response = await handle.connection
        .request('session/new', { cwd: scratch, mcpServers: [] }, 8_000)
        .catch((error) => {
          throw this.failure(handle, error)
        })
      const sessionId = response?.sessionId
      if (typeof sessionId !== 'string')
        throw new ProtocolError(-32603, 'Antigravity 查询模型时没有返回会话号')
      if (handle.caps.close)
        await handle.connection.request('session/close', { sessionId }, 1_000).catch(() => null)
      return {
        catalog: {
          configOptions: Array.isArray(response.configOptions) ? response.configOptions : null,
          models: Array.isArray(response.models?.availableModels) ? response.models : null,
          modes: Array.isArray(response.modes?.availableModes) ? response.modes : null,
        },
        image: handle.caps.image,
      }
    } finally {
      await this.stop(runtime, true)
      this.runtime = null
      this.stopping = null
      // 只清理 mkdtemp 创建的目录；不改写用户目录中共享的 SQLite 或 protobuf 摘要。
      if (!agent || agent.child.exitCode !== null || agent.child.signalCode !== null)
        rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
  }

  async close(signalled: boolean): Promise<void> {
    this.closed = true
    if (this.runtime) await this.stop(this.runtime, signalled)
    await this.pending?.value.catch(() => {})
  }

  private stop(runtime: AcpRuntime, signalled: boolean): Promise<void> {
    this.stopping ??= runtime.close(signalled)
    return this.stopping
  }
}
