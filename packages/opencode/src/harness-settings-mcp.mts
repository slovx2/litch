import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  HarnessAuthStartResponse,
  HarnessAuthStep,
  HarnessMcpReadResponse,
  HarnessMcpServer,
  HarnessMcpWriteResponse,
  HarnessSettingSpec,
} from '../../protocol/src/harness-config.mjs'
import { sleep } from '../../shared/src/util.mjs'
import type { HarnessSettings } from './harness-settings.mjs'
import { callbackPort } from './harness-settings-providers.mjs'
import {
  type Attempt,
  conflict,
  invalid,
  notFound,
  opencodeMessage,
  text,
} from './harness-settings-shared.mjs'
import { editJsonc, readGlobalConfig } from './native-config.mjs'

// MCP（litch/harness/mcp/*）：用户级的 MCP 服务写在全局配置的 mcp.<名字> 里。OpenCode 有两种：
// local（起一个命令，走 stdio）和 remote（一个地址，Streamable HTTP，不行时退回 SSE，两者不分开配）。
// 状态问 serve 的 GET /mcp。OAuth 用 serve 的 /mcp/:name/auth/authenticate：它在设备上开浏览器、
// 在设备的 127.0.0.1:19876（或配置里给的端口）等回调，开不了浏览器时发 mcp.browser.open.failed 事件带上链接，
// 这时把链接交给客户端（远程设备要转发回调端口）。凭据存在 OpenCode 自己的 mcp-auth.json。

const SECRET = /key|token|secret|password|passwd|credential|auth/i
const BEARER = /^Bearer \{env:([^}]+)\}$/
// 等 OpenCode 开浏览器的结果多久：开不了的话它很快就发事件
const BROWSER_WAIT_MS = 3000
const WAIT_MS = 15 * 60_000

const EXTRA_FIELDS: HarnessSettingSpec[] = [
  {
    key: 'timeout',
    group: 'mcp',
    type: 'integer',
    title: text('请求超时（毫秒）', 'Request timeout (ms)'),
    description: text('不设是 5000 毫秒', 'Defaults to 5000 ms'),
    default: 5000,
    effect: 'none',
    minimum: 1,
  },
  {
    key: 'oauth',
    group: 'mcp',
    type: 'json',
    title: text('OAuth 设置', 'OAuth settings'),
    description: text(
      '只对地址类的服务有用：clientId、clientSecret、scope、callbackPort、redirectUri；写 false 关掉自动发现',
      'Remote servers only: clientId, clientSecret, scope, callbackPort, redirectUri; false turns off discovery',
    ),
    default: null,
    effect: 'none',
  },
]

const isRecord = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const stringMap = (value: unknown): Record<string, string> =>
  isRecord(value)
    ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]))
    : {}

function status(entry: any): NonNullable<HarnessMcpServer['status']> | null {
  if (!isRecord(entry)) return null
  const message = typeof entry.error === 'string' ? entry.error : null
  switch (entry.status) {
    case 'connected':
      return { state: 'connected', message: null }
    case 'disabled':
      return { state: 'disabled', message: null }
    case 'failed':
      return { state: 'failed', message }
    case 'needs_auth':
    case 'needs_client_registration':
      return { state: 'needsAuth', message }
    default:
      return { state: 'unknown', message }
  }
}

function toServer(name: string, config: Record<string, any>, state: any): HarnessMcpServer {
  const { type, command, cwd, environment, enabled, url, headers, ...rest } = config
  const extra = Object.keys(rest).length ? rest : undefined
  if (type === 'local') {
    const env = stringMap(environment)
    const secretKeys = Object.keys(env).filter(
      (key) => SECRET.test(key) && !env[key]?.startsWith('{env:'),
    )
    for (const key of secretKeys) env[key] = ''
    const [program = '', ...args] = Array.isArray(command) ? command.map(String) : []
    return {
      name,
      transport: 'stdio',
      enabled: enabled !== false,
      command: program,
      args,
      ...(typeof cwd === 'string' ? { cwd } : {}),
      env,
      secretKeys,
      ...(extra ? { extra } : {}),
      status: status(state),
    }
  }
  const all = stringMap(headers)
  const bearer = Object.entries(all).find(
    ([key, value]) => key.toLowerCase() === 'authorization' && BEARER.test(value),
  )
  if (bearer) delete all[bearer[0]]
  return {
    name,
    transport: 'http',
    enabled: enabled !== false,
    url: String(url ?? ''),
    headers: all,
    ...(bearer ? { bearerTokenEnvVar: (BEARER.exec(bearer[1]) as RegExpExecArray)[1] } : {}),
    ...(extra ? { extra } : {}),
    status: status(state),
  }
}

export async function mcpRead(h: HarnessSettings): Promise<HarnessMcpReadResponse> {
  await h.server.api()
  const snapshot = readGlobalConfig(h.paths)
  const configs = isRecord(snapshot.merged.mcp) ? snapshot.merged.mcp : {}
  const api = await h.server.api()
  const states = await api.request('GET', '/mcp', { timeoutMs: 15000 }).catch(() => ({}))
  return {
    servers: Object.entries(configs)
      // 只有 enabled 的那种条目是给别处（项目里）定义的服务开关，不是一个服务
      .filter(
        ([, config]) => isRecord(config) && (config.type === 'local' || config.type === 'remote'),
      )
      .map(([name, config]) => toServer(name, config, states?.[name])),
    transports: ['stdio', 'http'],
    oauth: true,
    extraFields: EXTRA_FIELDS,
    version: snapshot.version,
    files: [
      { role: 'mcp', path: snapshot.target },
      { role: 'credentials', path: join(h.paths.dataDir, 'mcp-auth.json') },
    ],
  }
}

function strings(value: unknown, key: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw invalid(key, `${key} 应当是一列字`, `${key} must be a list of strings`)
  return value
}

function toConfig(server: HarnessMcpServer, previous: Record<string, any> | undefined) {
  const extra = isRecord(server.extra) ? { ...server.extra } : {}
  const timeout: unknown = extra.timeout
  if (timeout !== undefined && !(Number.isInteger(timeout) && (timeout as number) > 0))
    throw invalid('timeout', '超时要是正整数（毫秒）', 'Timeout must be a positive integer (ms)')
  const enabled = server.enabled === false ? { enabled: false } : {}
  if (server.transport === 'stdio') {
    const command = String(server.command ?? '').trim()
    if (!command) throw invalid('command', '要写启动的命令', 'Command is required')
    const env = isRecord(server.env) ? stringMap(server.env) : {}
    const old = stringMap(previous?.environment)
    // 密钥类的值读到的是空串：原样交回来的表示不改
    for (const key of server.secretKeys ?? [])
      if (env[key] === '' && old[key] !== undefined) env[key] = old[key]
    return {
      type: 'local',
      command: [command, ...strings(server.args, 'args')],
      ...(server.cwd?.trim() ? { cwd: server.cwd.trim() } : {}),
      ...(Object.keys(env).length ? { environment: env } : {}),
      ...enabled,
      ...extra,
    }
  }
  const url = String(server.url ?? '').trim()
  if (!/^https?:\/\//.test(url))
    throw invalid(
      'url',
      '地址要以 http:// 或 https:// 开头',
      'URL must start with http:// or https://',
    )
  const headers = isRecord(server.headers) ? stringMap(server.headers) : {}
  if (server.bearerTokenEnvVar?.trim())
    headers.Authorization = `Bearer {env:${server.bearerTokenEnvVar.trim()}}`
  return {
    type: 'remote',
    url,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...enabled,
    ...extra,
  }
}

export async function mcpUpsert(h: HarnessSettings, p: any): Promise<HarnessMcpWriteResponse> {
  const server: HarnessMcpServer = isRecord(p.server) ? (p.server as HarnessMcpServer) : ({} as any)
  const name = String(server.name ?? '').trim()
  if (!name) throw invalid('name', '要给服务起个名字', 'Name is required')
  if (!['stdio', 'http', 'sse'].includes(server.transport))
    throw invalid(
      'transport',
      `不认识的连接方式 ${server.transport}`,
      `Unknown transport ${server.transport}`,
    )
  await h.server.api()
  const snapshot = readGlobalConfig(h.paths)
  if (p.expectedVersion !== snapshot.version) throw conflict()
  const configs = isRecord(snapshot.merged.mcp) ? snapshot.merged.mcp : {}
  const previousName = typeof p.previousName === 'string' ? p.previousName : undefined
  if (previousName && !configs[previousName])
    throw notFound(`没有 MCP 服务 ${previousName}`, `No MCP server ${previousName}`)
  if (previousName && previousName !== name && configs[name])
    throw invalid('name', `已经有叫 ${name} 的服务了`, `An MCP server named ${name} already exists`)
  const config = toConfig(server, configs[previousName ?? name])
  let next = editJsonc(snapshot.text, ['mcp', name], config)
  if (previousName && previousName !== name)
    next = editJsonc(next, ['mcp', previousName], undefined)
  const restartRequired = await h.commitConfig(
    snapshot.target,
    next,
    snapshot.files.some((file) => file.path === snapshot.target) ? snapshot.text : null,
  )
  h.changed('mcp')
  return { version: readGlobalConfig(h.paths).version, restartRequired }
}

export async function mcpRemove(h: HarnessSettings, p: any): Promise<HarnessMcpWriteResponse> {
  const name = String(p.name ?? '')
  await h.server.api()
  const snapshot = readGlobalConfig(h.paths)
  if (p.expectedVersion !== snapshot.version) throw conflict()
  if (!isRecord(snapshot.merged.mcp) || !snapshot.merged.mcp[name])
    throw notFound(`没有 MCP 服务 ${name}`, `No MCP server ${name}`)
  const next = editJsonc(snapshot.text, ['mcp', name], undefined)
  const restartRequired = await h.commitConfig(snapshot.target, next, snapshot.text)
  h.changed('mcp')
  return { version: readGlobalConfig(h.paths).version, restartRequired }
}

function outcome(result: any): HarnessAuthStep {
  if (result?.status === 'connected')
    return { kind: 'done', auth: { signedIn: true, kind: 'oauth', label: null } }
  const reason = typeof result?.error === 'string' ? result.error : String(result?.status ?? '')
  return {
    kind: 'failed',
    message: text(`MCP 服务没有连上：${reason}`, `The MCP server did not connect: ${reason}`),
  }
}

export async function mcpLogin(h: HarnessSettings, p: any): Promise<HarnessAuthStartResponse> {
  const name = String(p.name ?? '')
  await h.server.api()
  const snapshot = readGlobalConfig(h.paths)
  const config = isRecord(snapshot.merged.mcp) ? snapshot.merged.mcp[name] : undefined
  if (!isRecord(config)) throw notFound(`没有 MCP 服务 ${name}`, `No MCP server ${name}`)
  if (config.type !== 'remote')
    throw invalid(
      'name',
      '只有地址类的 MCP 服务能用 OAuth 登录',
      'Only remote MCP servers can sign in with OAuth',
    )
  const api = await h.server.api()
  const attempt: Attempt = {
    id: randomUUID(),
    mcpServer: name,
    stage: 'waiting',
    abort: new AbortController(),
  }
  h.attempts.set(attempt.id, attempt)
  let opened: (url: string) => void = () => {}
  const browserFailed = new Promise<string>((resolve) => {
    opened = resolve
  })
  h.mcpBrowser.set(name, opened)
  const finished = api
    .request('POST', `/mcp/${encodeURIComponent(name)}/auth/authenticate`, {
      timeoutMs: WAIT_MS,
      signal: attempt.abort.signal,
    })
    .then(
      outcome,
      (error): HarnessAuthStep => ({
        kind: 'failed',
        message: text(
          `登录没有完成：${opencodeMessage(error)}`,
          `Sign-in did not complete: ${opencodeMessage(error)}`,
        ),
      }),
    )
    .finally(() => {
      h.attempts.delete(attempt.id)
      if (h.mcpBrowser.get(name) === opened) h.mcpBrowser.delete(name)
    })
  const first = await Promise.race([
    finished.then((step) => ({ step })),
    browserFailed.then((url) => ({ url })),
    sleep(BROWSER_WAIT_MS).then(() => ({})),
  ])
  if ('step' in first) return { attemptId: attempt.id, step: first.step }
  // 还没完成：之后的结果经 auth/updated 通知
  void finished.then((step) => {
    if (!attempt.abort.signal.aborted) h.authUpdated(attempt.id, step, { mcpServer: name })
  })
  if ('url' in first)
    return {
      attemptId: attempt.id,
      step: {
        kind: 'openUrl',
        url: first.url,
        callbackPort: callbackPort(first.url) ?? 19876,
        message: null,
      },
    }
  // OpenCode 已经在设备上的浏览器里打开了授权页（本机的设备就是你眼前这台），等它完成
  return {
    attemptId: attempt.id,
    step: {
      kind: 'prompt',
      fields: [],
      message: text(
        '授权页已经在设备的浏览器里打开了，授权完这里会自动更新',
        'The authorization page was opened in the device’s browser; this updates once you finish',
      ),
    },
  }
}
