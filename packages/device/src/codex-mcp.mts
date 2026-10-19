// 原生 codex 的 MCP 服务（litch/harness/mcp/*）：config.toml 的 `mcp_servers.<名字>`。
//   - 两种传输：有 command 的是 stdio，有 url 的是流式 HTTP（codex 没有单独的 SSE）。
//   - 我们认的字段之外（超时、工具白名单黑名单、required、scopes……）都放进 extra，原样读写。
//   - env 里名字像密钥的（含 KEY、TOKEN、SECRET、PASSWORD 等）读回来是空串，名字列在 secretKeys；
//     写的时候 secretKeys 里有、env 里没给（或给的空串）的保留原来的值。
//   - 改完调 config/mcpServer/reload，codex 当场换上新的配置，不用重启。
//   - 状态问 mcpServerStatus/list（detail 只要工具和登录状态）。它会去连每个服务，慢的话不等，状态给 null。
import type {
  HarnessMcpReadResponse,
  HarnessMcpServer,
  HarnessMcpWriteResponse,
  HarnessSettingSpec,
} from '../../protocol/src/harness-config.mjs'
import { type Ask, batchWrite, type CodexEdit, readSnapshot, segment } from './codex-config-io.mjs'
import { HarnessConfigError, text } from './harness-config.mjs'
import { isObject } from './wire.mjs'

/** 等 MCP 状态最多这么久（毫秒）：codex 要把每个服务都连一遍 */
const STATUS_TIMEOUT_MS = 8000

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i
const NAME = /^[A-Za-z0-9_-]+$/
/** 我们自己拆出来的字段，别的都进 extra */
const KNOWN = new Set([
  'command',
  'args',
  'env',
  'cwd',
  'url',
  'http_headers',
  'bearer_token_env_var',
  'enabled',
])

const spec = (
  key: string,
  type: HarnessSettingSpec['type'],
  title: [string, string],
): HarnessSettingSpec => ({
  key,
  group: 'mcp',
  type,
  title: text(...title),
  description: null,
  default: null,
  effect: 'none',
})

const EXTRA_FIELDS: HarnessSettingSpec[] = [
  spec('startup_timeout_sec', 'number', ['启动超时（秒）', 'Startup timeout (s)']),
  spec('tool_timeout_sec', 'number', ['工具调用超时（秒）', 'Tool timeout (s)']),
  spec('enabled_tools', 'stringList', ['只用这些工具', 'Enabled tools']),
  spec('disabled_tools', 'stringList', ['不用这些工具', 'Disabled tools']),
  spec('required', 'boolean', ['启动失败就报错', 'Required']),
  spec('scopes', 'stringList', ['OAuth 授权范围', 'OAuth scopes']),
  spec('env_http_headers', 'json', ['从环境变量取的请求头', 'Headers from environment']),
  spec('env_vars', 'json', ['透传的环境变量', 'Forwarded environment variables']),
]

const strings = (value: unknown): Record<string, string> =>
  isObject(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
    : {}

function serverOf(name: string, table: Record<string, unknown>): HarnessMcpServer {
  const transport = typeof table.url === 'string' ? 'http' : 'stdio'
  const server: HarnessMcpServer = { name, transport, enabled: table.enabled !== false }
  if (typeof table.command === 'string') server.command = table.command
  if (Array.isArray(table.args)) server.args = table.args.map(String)
  if (typeof table.cwd === 'string') server.cwd = table.cwd
  if (isObject(table.env)) {
    const env = strings(table.env)
    const secrets = Object.keys(env).filter((key) => SECRET_NAME.test(key))
    for (const key of secrets) env[key] = ''
    server.env = env
    if (secrets.length) server.secretKeys = secrets
  }
  if (typeof table.url === 'string') server.url = table.url
  if (isObject(table.http_headers)) server.headers = strings(table.http_headers)
  if (typeof table.bearer_token_env_var === 'string')
    server.bearerTokenEnvVar = table.bearer_token_env_var
  const extra = Object.fromEntries(
    Object.entries(table).filter(([key, value]) => !KNOWN.has(key) && value !== null),
  )
  if (Object.keys(extra).length) server.extra = extra
  return server
}

type McpStatus = NonNullable<HarnessMcpServer['status']>

function statusOf(
  server: HarnessMcpServer,
  row: Record<string, unknown> | undefined,
): McpStatus | null {
  if (!server.enabled) return { state: 'disabled', message: null }
  if (!row) return null
  if (row.authStatus === 'notLoggedIn') return { state: 'needsAuth', message: null }
  if (typeof row.toolsError === 'string' && row.toolsError)
    return { state: 'failed', message: row.toolsError }
  return { state: 'connected', message: null }
}

async function statuses(ask: Ask): Promise<Map<string, Record<string, unknown>> | null> {
  try {
    const result = await ask(
      'mcpServerStatus/list',
      { detail: 'toolsAndAuthOnly', limit: 500 },
      STATUS_TIMEOUT_MS,
    )
    const rows = isObject(result) && Array.isArray(result.data) ? result.data.filter(isObject) : []
    return new Map(rows.map((row) => [String(row.name), row]))
  } catch {
    return null
  }
}

/** litch/harness/mcp/read */
export async function readCodexMcp(ask: Ask, harness: string): Promise<HarnessMcpReadResponse> {
  const [snapshot, rows] = await Promise.all([readSnapshot(ask, harness), statuses(ask)])
  // 用户层里有的用它的原文：生效配置里每个服务都摊开了默认值（environment_id、为 null 的超时……），
  // 照那份写回去会把默认值写死进文件
  const tables = isObject(snapshot.config.mcp_servers) ? snapshot.config.mcp_servers : {}
  const own = isObject(snapshot.user.mcp_servers) ? snapshot.user.mcp_servers : {}
  const servers = Object.entries(tables)
    .filter((entry): entry is [string, Record<string, unknown>] => isObject(entry[1]))
    .map(([name, table]) => {
      const server = serverOf(name, isObject(own[name]) ? own[name] : table)
      server.status = rows
        ? statusOf(server, rows.get(name))
        : server.enabled
          ? null
          : statusOf(server, undefined)
      return server
    })
  return {
    servers,
    transports: ['stdio', 'http'],
    oauth: true,
    extraFields: EXTRA_FIELDS,
    version: snapshot.version,
    files: [{ role: 'mcp', path: snapshot.file }],
  }
}

function invalid(harness: string, zh: string, en: string, key?: string): HarnessConfigError {
  return new HarnessConfigError('invalidValue', harness, text(zh, en), key)
}

/** 客户端给的服务写成 config.toml 里的一张表 */
function tableOf(
  harness: string,
  server: HarnessMcpServer,
  previous: Record<string, unknown> | null,
) {
  const table: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(isObject(server.extra) ? server.extra : {}))
    if (!KNOWN.has(key) && value !== null && value !== undefined) table[key] = value
  if (server.transport === 'stdio') {
    if (typeof server.command !== 'string' || !server.command.trim())
      throw invalid(
        harness,
        'stdio 的服务要有 command',
        'A stdio server needs a command',
        'command',
      )
    table.command = server.command
    if (server.args?.length) table.args = server.args.map(String)
    if (server.cwd) table.cwd = server.cwd
    const env: Record<string, string> = { ...strings(server.env) }
    const old = strings(previous?.env)
    for (const key of server.secretKeys ?? [])
      if (!env[key] && old[key] !== undefined) env[key] = old[key]
    for (const [key, value] of Object.entries(env)) if (value === '') delete env[key]
    if (Object.keys(env).length) table.env = env
  } else if (server.transport === 'http') {
    if (typeof server.url !== 'string' || !/^https?:\/\//.test(server.url))
      throw invalid(
        harness,
        'HTTP 的服务要有 http(s) 地址',
        'An HTTP server needs an http(s) URL',
        'url',
      )
    table.url = server.url
    if (server.headers && Object.keys(server.headers).length)
      table.http_headers = strings(server.headers)
    if (server.bearerTokenEnvVar) table.bearer_token_env_var = server.bearerTokenEnvVar
  } else
    throw invalid(
      harness,
      `codex 不支持 ${String(server.transport)} 传输`,
      'Unsupported transport',
      'transport',
    )
  if (server.enabled === false) table.enabled = false
  return table
}

function nameOf(harness: string, value: unknown, field: string): string {
  if (typeof value === 'string' && NAME.test(value)) return value
  throw invalid(
    harness,
    `${field} 只能用字母、数字和 - _`,
    `${field} may only contain letters, digits, - and _`,
    field,
  )
}

/** litch/harness/mcp/upsert */
export async function upsertCodexMcp(
  ask: Ask,
  harness: string,
  params: Record<string, unknown>,
): Promise<HarnessMcpWriteResponse> {
  const server = params.server as HarnessMcpServer
  if (!isObject(server)) throw invalid(harness, '缺少 server', 'server is required')
  if (typeof params.expectedVersion !== 'string')
    throw invalid(harness, '缺少 expectedVersion', 'expectedVersion is required')
  const name = nameOf(harness, server.name, 'server.name')
  const previousName =
    params.previousName === undefined ? null : nameOf(harness, params.previousName, 'previousName')
  const snapshot = await readSnapshot(ask, harness)
  const user = isObject(snapshot.user.mcp_servers) ? snapshot.user.mcp_servers : {}
  const old = user[previousName ?? name]
  if (previousName && !isObject(old))
    throw new HarnessConfigError(
      'notFound',
      harness,
      text(`没有这个 MCP 服务：${previousName}`, `No such MCP server: ${previousName}`),
    )
  if (previousName && previousName !== name && isObject(user[name]))
    throw invalid(
      harness,
      `已经有叫 ${name} 的服务了`,
      `A server named ${name} already exists`,
      'server.name',
    )
  const edits: CodexEdit[] = [
    {
      keyPath: `mcp_servers.${segment(name)}`,
      value: tableOf(harness, server, isObject(old) ? old : null),
      mergeStrategy: 'replace',
    },
  ]
  if (previousName && previousName !== name)
    edits.push({
      keyPath: `mcp_servers.${segment(previousName)}`,
      value: null,
      mergeStrategy: 'replace',
    })
  const { version } = await batchWrite(ask, harness, snapshot, edits, params.expectedVersion)
  await ask('config/mcpServer/reload', {}).catch(() => null)
  return { version, restartRequired: false }
}

/** litch/harness/mcp/remove */
export async function removeCodexMcp(
  ask: Ask,
  harness: string,
  params: Record<string, unknown>,
): Promise<HarnessMcpWriteResponse> {
  const name = nameOf(harness, params.name, 'name')
  if (typeof params.expectedVersion !== 'string')
    throw invalid(harness, '缺少 expectedVersion', 'expectedVersion is required')
  const snapshot = await readSnapshot(ask, harness)
  const user = isObject(snapshot.user.mcp_servers) ? snapshot.user.mcp_servers : {}
  if (!isObject(user[name])) {
    const elsewhere =
      isObject(snapshot.config.mcp_servers) && isObject(snapshot.config.mcp_servers[name])
    throw new HarnessConfigError(
      elsewhere ? 'readOnly' : 'notFound',
      harness,
      elsewhere
        ? text(
            `${name} 不是写在用户配置里的，这里删不了`,
            `${name} is defined outside the user config`,
          )
        : text(`没有这个 MCP 服务：${name}`, `No such MCP server: ${name}`),
    )
  }
  const { version } = await batchWrite(
    ask,
    harness,
    snapshot,
    [{ keyPath: `mcp_servers.${segment(name)}`, value: null, mergeStrategy: 'replace' }],
    params.expectedVersion,
  )
  await ask('config/mcpServer/reload', {}).catch(() => null)
  return { version, restartRequired: false }
}
