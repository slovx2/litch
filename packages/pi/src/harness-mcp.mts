// Pi 的 MCP：<agent-dir>/mcp.json 的 mcpServers（项目层的 .pi/mcp.json 不管）。增删用 Pi 自己改这份文件的函数
// （和 pi mcp add/remove 一样：别的内容和缩进都留着）；登录同 pi mcp login：先连一次，要登录才走浏览器授权，
// 令牌由 Pi 存进 mcp-auth.json。改了的配置新会话才用上（Pi 在会话开始时连 MCP）。

import { EXTENSION } from '../../protocol/src/device.mjs'
import type {
  HarnessAuthStartResponse,
  HarnessMcpNameParams,
  HarnessMcpReadResponse,
  HarnessMcpRemoveParams,
  HarnessMcpServer,
  HarnessMcpUpsertParams,
  HarnessMcpWriteResponse,
  HarnessSettingSpec,
} from '../../protocol/src/harness-config.mjs'
import { HARNESS_CONFIG_NOTIFICATION } from '../../protocol/src/harness-config.mjs'
import { AuthAttempt, failure } from './harness-auth.mjs'
import {
  agentPath,
  changed,
  checkVersion,
  fail,
  HARNESS,
  hashOf,
  parseObject,
  readText,
  t,
} from './harness-common.mjs'
import { mcpConfig, mcpConnection } from './pi-internals.mjs'
import { getAgentDir } from './sdk.mjs'
import type { PiServer } from './server.mjs'

const SERVER_NAME = /^[A-Za-z0-9_-]+$/
/** 协议里单列的字段；其余（timeout、exposure、toolExposure、oauth、type 等）原样放进 extra */
const KNOWN = new Set(['command', 'args', 'cwd', 'env', 'url', 'headers', 'enabled'])
/** 看着像密钥的环境变量、请求头：字面量的值不读回（引用环境变量 ${NAME} 或命令 !cmd 的照常给） */
const SECRET_NAME = /key|token|secret|password|passwd|authorization|cookie|credential/i
const BEARER_ENV = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

const EXPOSURES = ['codemode', 'codemode-deferred', 'deferred', 'direct', 'hidden'] as const

const EXTRA_FIELDS: HarnessSettingSpec[] = [
  {
    key: 'timeout',
    group: 'mcp',
    type: 'integer',
    title: t('请求超时（秒）', 'Request timeout (seconds)'),
    description: null,
    default: 60,
    effect: 'newSession',
    minimum: 1,
  },
  {
    key: 'exposure',
    group: 'mcp',
    type: 'enum',
    title: t('工具怎么给模型', 'Tool exposure'),
    description: t(
      'codemode：经 codemode 脚本调用（默认）；deferred：经 tool_search 按需加载；direct：直接声明给模型；hidden：不能调用',
      'codemode: called from codemode scripts (default); deferred: loaded on demand through tool_search; direct: declared to the model; hidden: not callable',
    ),
    default: 'codemode',
    effect: 'newSession',
    options: EXPOSURES.map((value) => ({ value, title: t(value, value) })),
  },
  {
    key: 'toolExposure',
    group: 'mcp',
    type: 'json',
    title: t('单个工具的给法', 'Per-tool exposure'),
    description: t('工具名或带 * 的式子 → 给法', 'Tool name or pattern with * → exposure'),
    default: null,
    effect: 'newSession',
  },
  {
    key: 'oauth',
    group: 'mcp',
    type: 'json',
    title: t('OAuth 客户端', 'OAuth client'),
    description: t(
      '授权服务不支持动态注册时用：clientId、clientSecret、callbackPort、callbackUrl、scope',
      'For authorization servers without dynamic registration: clientId, clientSecret, callbackPort, callbackUrl, scope',
    ),
    default: null,
    effect: 'newSession',
  },
]

const mcpPath = () => agentPath('mcp.json')

const literalSecret = (name: string, value: unknown) =>
  SECRET_NAME.test(name) && typeof value === 'string' && !/^(\$|!)/.test(value)

/** 把密钥类的字面量换成空串，名字记进 secret */
function masked(record: unknown, secret: string[]): Record<string, string> | undefined {
  if (!record || typeof record !== 'object') return undefined
  return Object.fromEntries(
    Object.entries(record as Record<string, string>).map(([name, value]) => {
      if (!literalSecret(name, value)) return [name, String(value)]
      secret.push(name)
      return [name, '']
    }),
  )
}

function toServer(name: string, raw: Record<string, any>): HarnessMcpServer {
  const transport = raw.type === 'sse' ? 'sse' : typeof raw.command === 'string' ? 'stdio' : 'http'
  const secretKeys: string[] = []
  const server: HarnessMcpServer = { name, transport, enabled: raw.enabled !== false }
  if (transport === 'stdio') {
    server.command = raw.command
    if (Array.isArray(raw.args)) server.args = raw.args
    if (typeof raw.cwd === 'string') server.cwd = raw.cwd
    const env = masked(raw.env, secretKeys)
    if (env) server.env = env
  } else {
    if (typeof raw.url === 'string') server.url = raw.url
    const headers = { ...(raw.headers ?? {}) }
    // pi mcp add --bearer-token-env-var X 写的是 Authorization: Bearer ${X}
    const bearer =
      typeof headers.Authorization === 'string' && BEARER_ENV.exec(headers.Authorization)
    if (bearer) {
      server.bearerTokenEnvVar = bearer[1]!
      delete headers.Authorization
    }
    const shown = masked(headers, secretKeys)
    if (shown && Object.keys(shown).length) server.headers = shown
  }
  if (secretKeys.length) server.secretKeys = secretKeys
  const extra = Object.fromEntries(Object.entries(raw).filter(([key]) => !KNOWN.has(key)))
  if (Object.keys(extra).length) server.extra = extra
  server.status = server.enabled ? null : { state: 'disabled', message: null }
  return server
}

export async function mcpRead(): Promise<HarnessMcpReadResponse> {
  const path = mcpPath()
  const text = await readText(path)
  const config = parseObject(text, path)
  const servers =
    config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {}
  return {
    servers: Object.entries(servers).map(([name, raw]) => toServer(name, (raw ?? {}) as any)),
    // Pi 不支持旧的 SSE（docs/mcp.md）
    transports: ['stdio', 'http'],
    oauth: true,
    extraFields: EXTRA_FIELDS,
    version: hashOf(text),
    files: [
      { role: 'mcp', path },
      { role: 'credentials', path: agentPath('mcp-auth.json') },
    ],
  }
}

function invalid(key: string, zh: string, en: string): never {
  fail('invalidValue', `${key}：${zh}`, `${key}: ${en}`, key)
}

function stringRecord(value: unknown, key: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.values(value).some((v) => typeof v !== 'string')
  )
    invalid(key, '应当是名字到字符串的对照', 'must map names to strings')
  return value as Record<string, string>
}

/** 密钥类的名字没给值（读到的是空串）时，用原来的值 */
function keepSecrets(
  next: Record<string, string> | undefined,
  previous: unknown,
  secretKeys: string[] | undefined,
): Record<string, string> | undefined {
  const old = (previous && typeof previous === 'object' ? previous : {}) as Record<string, unknown>
  const merged = { ...(next ?? {}) }
  for (const name of secretKeys ?? [])
    if (!merged[name] && typeof old[name] === 'string') merged[name] = old[name] as string
  return Object.keys(merged).length ? merged : undefined
}

/** 协议的形状换回 mcp.json 里的一项；previous 是原来那一项（改名前的），用来留住没读回的密钥 */
function toConfig(
  server: HarnessMcpServer,
  previous: Record<string, any> | undefined,
): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  const extra = server.extra ?? {}
  if (typeof extra !== 'object' || Array.isArray(extra))
    invalid('extra', '应当是对象', 'must be an object')
  for (const [key, value] of Object.entries(extra)) if (!KNOWN.has(key)) config[key] = value
  if (server.transport === 'sse')
    invalid(
      'transport',
      'Pi 不支持旧的 SSE，用服务的流式 HTTP 地址（常是 /mcp）',
      'Pi does not support legacy SSE; use the streamable HTTP URL (often /mcp)',
    )
  if (server.transport === 'stdio') {
    if (typeof server.command !== 'string' || !server.command.trim())
      invalid('command', '不能为空', 'is required')
    config.command = server.command.trim()
    if (server.args !== undefined) {
      if (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== 'string'))
        invalid('args', '应当是一列字', 'must be a list of strings')
      if (server.args.length) config.args = server.args
    }
    if (server.cwd) config.cwd = server.cwd
    const env = keepSecrets(stringRecord(server.env, 'env'), previous?.env, server.secretKeys)
    if (env) config.env = env
    delete config.type
  } else if (server.transport === 'http') {
    if (
      typeof server.url !== 'string' ||
      !URL.canParse(server.url) ||
      !/^https?:$/.test(new URL(server.url).protocol)
    )
      invalid('url', '应当是 http 或 https 地址', 'must be an http or https URL')
    config.url = server.url
    const headers =
      keepSecrets(stringRecord(server.headers, 'headers'), previous?.headers, server.secretKeys) ??
      {}
    if (server.bearerTokenEnvVar) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(server.bearerTokenEnvVar))
        invalid(
          'bearerTokenEnvVar',
          '不是合法的环境变量名',
          'is not a valid environment variable name',
        )
      headers.Authorization = `Bearer \${${server.bearerTokenEnvVar}}`
    }
    if (Object.keys(headers).length) config.headers = headers
    if (config.type === 'stdio') delete config.type
  } else
    invalid(
      'transport',
      `不认识 ${String(server.transport)}`,
      `unknown transport ${String(server.transport)}`,
    )
  if (config.timeout !== undefined && !(typeof config.timeout === 'number' && config.timeout > 0))
    invalid('timeout', '应当是正数（秒）', 'must be a positive number of seconds')
  if (config.exposure !== undefined && !EXPOSURES.includes(config.exposure as any))
    invalid(
      'exposure',
      `不认识 ${String(config.exposure)}`,
      `unknown exposure ${String(config.exposure)}`,
    )
  // 和 Pi 的 /mcp 一样：启用时不写 enabled
  if (server.enabled === false) config.enabled = false
  return config
}

async function current(expectedVersion: unknown) {
  const path = mcpPath()
  const text = await readText(path)
  checkVersion(expectedVersion, hashOf(text))
  const config = parseObject(text, path)
  return { path, servers: (config.mcpServers ?? {}) as Record<string, any> }
}

export async function mcpUpsert(
  s: PiServer,
  p: HarnessMcpUpsertParams,
): Promise<HarnessMcpWriteResponse> {
  const server = p.server
  if (!server || typeof server.name !== 'string' || !SERVER_NAME.test(server.name))
    invalid('name', '只能用字母、数字、- 和 _', 'may only use letters, digits, - and _')
  const { path, servers } = await current(p.expectedVersion)
  const renamed = p.previousName !== undefined && p.previousName !== server.name
  if (renamed && servers[p.previousName!] === undefined)
    fail('notFound', `没有 MCP 服务 ${p.previousName}`, `No MCP server ${p.previousName}`)
  if (renamed && servers[server.name] !== undefined)
    invalid('name', `已经有叫 ${server.name} 的了`, `${server.name} already exists`)
  const config = toConfig(server, servers[p.previousName ?? server.name])
  const pi = await mcpConfig()
  pi.addMcpServerConfig(path, server.name, config)
  if (renamed) pi.removeMcpServerConfig(path, p.previousName!)
  changed(s, 'mcp')
  return { version: hashOf(await readText(path)), restartRequired: false }
}

export async function mcpRemove(
  s: PiServer,
  p: HarnessMcpRemoveParams,
): Promise<HarnessMcpWriteResponse> {
  const { path, servers } = await current(p.expectedVersion)
  if (servers[p.name] === undefined || !(await mcpConfig()).removeMcpServerConfig(path, p.name))
    fail('notFound', `没有 MCP 服务 ${p.name}`, `No MCP server ${p.name}`)
  changed(s, 'mcp')
  return { version: hashOf(await readText(path)), restartRequired: false }
}

export async function mcpLogin(
  s: PiServer,
  p: HarnessMcpNameParams,
): Promise<HarnessAuthStartResponse> {
  const agentDir = getAgentDir()
  const loaded = (await mcpConfig()).loadMcpConfig({
    agentDir,
    cwd: agentDir,
    projectTrusted: false,
  })
  const entry = loaded.servers.find((server) => server.name === p.name)
  if (!entry) fail('notFound', `没有 MCP 服务 ${p.name}`, `No MCP server ${p.name}`)
  const pi = await mcpConnection(entry, agentDir, agentDir)
  const url = pi.connection.oauthUrl
  if (!url) {
    await pi.connection.close()
    fail(
      'invalidValue',
      `MCP 服务 ${p.name} 不用 OAuth（只有没写 Authorization 请求头的 HTTP 服务用）`,
      `MCP server ${p.name} does not use OAuth (only HTTP servers without an Authorization header do)`,
    )
  }
  const login: AuthAttempt = new AuthAttempt((step) =>
    s.notifyExtension(EXTENSION.harnessConfig, HARNESS_CONFIG_NOTIFICATION.authUpdated, {
      harness: HARNESS,
      attemptId: login.id,
      mcpServer: p.name,
      step,
    }),
  )
  const first = login.next()
  const signedIn = {
    kind: 'done' as const,
    auth: { signedIn: true, kind: 'oauth' as const, label: null },
  }
  const run = async () => {
    // 先连一次：连得上就是已经登录过了；不是“要登录”的失败照实报
    try {
      await pi.connection.getClient()
      return
    } catch {
      if (pi.connection.state !== 'needs-auth')
        throw new Error(pi.connection.error ?? `MCP 服务 ${p.name} 连不上`)
    }
    login.signal.throwIfAborted()
    await pi.signIn({
      serverUrl: url,
      store: pi.credentials.forServer(url),
      settings: pi.connection.oauthSettings(),
      challenge: pi.connection.challenge,
      prompt: {
        showAuthorizationUrl: (authorizationUrl) =>
          login.openUrl(
            authorizationUrl.href,
            '在浏览器里同意授权；浏览器不在这台设备上时，把授权后跳转到的地址粘贴回来',
          ),
        // 没粘贴、浏览器回调先到了，或者登录被取消了：交回 undefined，Pi 照它的规矩收场
        promptForRedirectUrl: (signal) =>
          login
            .ask(
              [
                {
                  id: 'redirectUrl',
                  title: t('跳转到的完整地址', 'Full redirect URL'),
                  secret: false,
                  placeholder: 'http://127.0.0.1:…/callback?code=…',
                },
              ],
              '',
              AbortSignal.any([signal, login.signal]),
            )
            .then(
              (inputs) => inputs.redirectUrl,
              () => undefined,
            ),
      },
    })
    pi.connection.challenge = undefined
    await pi.connection.reconnect()
  }
  run()
    .then(
      () => {
        login.finish(signedIn)
        changed(s, 'mcp')
      },
      (error) => login.finish({ kind: 'failed', message: failure(error, login.signal) }),
    )
    .finally(() => void pi.connection.close().catch(() => {}))
  return { attemptId: login.id, step: await first }
}
