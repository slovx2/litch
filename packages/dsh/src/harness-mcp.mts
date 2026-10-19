// harness 详情设置里的 MCP（litch/harness/mcp/*）。dsh 的 MCP 服务是 profile 补丁文件里的插件行：
//   - insert:
//       - id: mcp-github
//         name: '@deepseek-ai/dsh-mcp-client'
//         config: { serverName: github, transport: stdio, command: npx, args: [...], env: {...} }
// 它的设置接口不管这种行（插件没有设置结构），所以直接改 $DSH_HOME/profiles/web/cordis.patch.yml：
// 用 yaml 的文档模型只动要改的那几处，注释、别的行、`!!js` 表达式都原样留着。dsh 盯着这个文件，改完它自己重载。
// 只管这个文件里用户自己插的 MCP 行；组合层（bundle）、命令行补丁里的不列。

import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Document, isMap, isScalar, isSeq, parseDocument, YAMLMap, YAMLSeq } from 'yaml'
import type {
  HarnessMcpReadResponse,
  HarnessMcpServer,
  HarnessMcpWriteResponse,
  HarnessSettingSpec,
} from '../../protocol/src/harness-config.mjs'
import { HarnessConfigError, text, versionOf } from './harness-common.mjs'
import { DSH_PROFILE, dshHome } from './runtime.mjs'

const MODULE = '@deepseek-ai/dsh-mcp-client'
/** dsh 的 serverName 规矩 */
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
/** 名字像密钥的环境变量、请求头：读的时候不回值 */
const SECRET_NAME = /key|token|secret|passw|auth|credential|cookie/i
/** extra 里认的字段（dsh-mcp-client 的配置） */
const EXTRA_KEYS = ['toolCallTimeoutMs', 'maxInstructionBytes', 'failOnStartupError', 'reconnect']
/** 两种传输各自的字段：换传输时把另一种的删掉 */
const STDIO_KEYS = ['command', 'args', 'env', 'cwd']
const HTTP_KEYS = ['url', 'headers']

export const patchFile = (): string => join(dshHome(), 'profiles', DSH_PROFILE, 'cordis.patch.yml')

const extraFields: HarnessSettingSpec[] = [
  {
    key: 'toolCallTimeoutMs',
    group: 'mcp',
    type: 'integer',
    title: text('每次调用超时（毫秒）', 'Per-call timeout (ms)'),
    description: null,
    default: 60000,
    effect: 'none',
    minimum: 1,
  },
  {
    key: 'maxInstructionBytes',
    group: 'mcp',
    type: 'integer',
    title: text('服务器指令的字节上限', 'Max server instruction bytes'),
    description: null,
    default: 32768,
    effect: 'none',
    minimum: 1,
  },
  {
    key: 'failOnStartupError',
    group: 'mcp',
    type: 'boolean',
    title: text('连不上时让插件启动失败', 'Fail plugin activation when the server cannot connect'),
    description: null,
    default: false,
    effect: 'none',
  },
  {
    key: 'reconnect',
    group: 'mcp',
    type: 'json',
    title: text('断线重连', 'Reconnect'),
    description: text(
      'enabled、initialDelayMs、maxDelayMs、maxAttempts',
      'enabled, initialDelayMs, maxDelayMs, maxAttempts',
    ),
    default: null,
    effect: 'none',
  },
]

interface Loaded {
  source: string
  doc: Document
}

function load(): Loaded {
  let source = ''
  try {
    source = readFileSync(patchFile(), 'utf8')
  } catch {}
  const doc = parseDocument(source || '[]', { keepSourceTokens: false })
  // dsh 建的空文件是一个 `[]`：换成块式的列表，往里加的行才是正常的样子（文件头的注释在文档上，不受影响）
  if (!isSeq(doc.contents) || (doc.contents.flow && doc.contents.items.length === 0)) {
    const seq = new YAMLSeq()
    seq.flow = false
    doc.contents = seq as any
  }
  return { source, doc }
}

function save(doc: Document): void {
  const path = patchFile()
  let mode = 0o644
  try {
    mode = statSync(path).mode & 0o777
  } catch {}
  const temp = `${path}.litch-${process.pid}`
  writeFileSync(temp, doc.toString({ lineWidth: 0, flowCollectionPadding: false }), { mode })
  renameSync(temp, path)
}

const top = (doc: Document): YAMLSeq => doc.contents as unknown as YAMLSeq

/** 文件里的 MCP 行：哪一项 insert 里的第几个 */
interface Row {
  holder: YAMLSeq
  row: YAMLMap
  id: string
}

function rows(doc: Document): Row[] {
  const found: Row[] = []
  for (const item of top(doc).items) {
    if (!isMap(item)) continue
    const inserted = item.get('insert', true)
    if (!isSeq(inserted)) continue
    for (const row of inserted.items)
      if (isMap(row) && row.get('name') === MODULE && typeof row.get('id') === 'string')
        found.push({ holder: inserted, row, id: String(row.get('id')) })
  }
  return found
}

/** 顶层的 `- id: <行号>\n  disabled: true` 这种补丁（dsh 的插件开关就这么写）对这一行说了什么 */
function patchedDisabled(doc: Document, id: string): boolean | undefined {
  let disabled: boolean | undefined
  for (const item of top(doc).items)
    if (isMap(item) && item.get('id') === id && typeof item.get('disabled') === 'boolean')
      disabled = item.get('disabled') as boolean
  return disabled
}

/** 节点给人看的值：`!!js` 表达式显示成 “!!js 表达式”，原样写回时不动它 */
function shown(node: unknown): unknown {
  if (isScalar(node) && node.tag === 'tag:yaml.org,2002:js') return `!!js ${String(node.value)}`
  if (isScalar(node)) return node.value
  if (isMap(node) || isSeq(node)) return node.toJSON()
  return node
}

function stringMap(node: unknown, secrets: string[]): Record<string, string> | undefined {
  if (!isMap(node)) return undefined
  const out: Record<string, string> = {}
  for (const pair of node.items) {
    const name = String(isScalar(pair.key) ? pair.key.value : pair.key)
    const value = shown(pair.value)
    const literal = typeof value === 'string' && !value.startsWith('!!js ')
    if (SECRET_NAME.test(name) && literal) {
      secrets.push(name)
      out[name] = ''
    } else out[name] = String(value ?? '')
  }
  return out
}

function serverOf(doc: Document, entry: Row, plugins: any[]): HarnessMcpServer {
  const config = entry.row.get('config', true)
  const get = (key: string) => (isMap(config) ? config.get(key, true) : undefined)
  const enabled = !(patchedDisabled(doc, entry.id) ?? entry.row.get('disabled') === true)
  const secretKeys: string[] = []
  const http = shown(get('transport')) === 'streamable-http'
  const extra: Record<string, unknown> = {}
  for (const key of EXTRA_KEYS) if (get(key) !== undefined) extra[key] = shown(get(key))
  const plugin = plugins.find((one) => one.patchId === entry.id)
  const phase = plugin?.fiberPhase
  return {
    name: String(shown(get('serverName')) ?? entry.id),
    transport: http ? 'http' : 'stdio',
    enabled,
    ...(http
      ? {
          url: String(shown(get('url')) ?? ''),
          headers: stringMap(get('headers'), secretKeys) ?? {},
        }
      : {
          command: String(shown(get('command')) ?? ''),
          args: ((shown(get('args')) as unknown[]) ?? []).map(String),
          env: stringMap(get('env'), secretKeys) ?? {},
          ...(get('cwd') !== undefined ? { cwd: String(shown(get('cwd'))) } : {}),
        }),
    ...(secretKeys.length ? { secretKeys } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
    status: !enabled
      ? { state: 'disabled', message: null }
      : phase && phase !== 'active'
        ? { state: 'failed', message: `dsh 插件状态：${phase}` }
        : null,
  }
}

export function readMcp(plugins: any[]): HarnessMcpReadResponse {
  const { source, doc } = load()
  return {
    servers: rows(doc).map((entry) => serverOf(doc, entry, plugins)),
    transports: ['stdio', 'http'],
    oauth: false,
    extraFields,
    version: versionOf(source),
    files: [{ role: 'mcp', path: patchFile() }],
  }
}

const invalid = (zh: string, en: string, key?: string) =>
  new HarnessConfigError('invalidValue', text(zh, en), key)

function checkVersion(source: string, expected: string): void {
  if (versionOf(source) !== expected)
    throw new HarnessConfigError(
      'versionConflict',
      text(
        'MCP 配置在读过之后被改了，请重读',
        'The MCP configuration changed since it was read; reload',
      ),
    )
}

/** 写一项：值和现在显示的一样就不动（留住 `!!js` 表达式和原来的写法） */
function put(map: YAMLMap, key: string, value: unknown): void {
  if (value === undefined) {
    map.delete(key)
    return
  }
  if (JSON.stringify(shown(map.get(key, true))) === JSON.stringify(value)) return
  map.set(key, value)
}

/**
 * 写环境变量、请求头：读的时候遮住的（secretKeys）没给或给的是空串，原来的值留着；
 * 别的照给的来，原样写回的 `!!js` 表达式不动
 */
function putStrings(config: YAMLMap, key: string, given: Record<string, string> | undefined): void {
  const old = config.get(key, true)
  const next = new YAMLMap()
  const previous = new Map<string, unknown>()
  if (isMap(old))
    for (const pair of old.items)
      previous.set(String(isScalar(pair.key) ? pair.key.value : pair.key), pair.value)
  const masked = (name: string) => {
    const value = shown(previous.get(name))
    return SECRET_NAME.test(name) && typeof value === 'string' && !value.startsWith('!!js ')
  }
  for (const [name, node] of previous) if (masked(name) && !given?.[name]) next.set(name, node)
  for (const [name, value] of Object.entries(given ?? {})) {
    if (masked(name) && !value) continue
    const node = previous.get(name)
    next.set(name, node !== undefined && shown(node) === value ? node : value)
  }
  if (next.items.length) config.set(key, next)
  else config.delete(key)
}

function validate(server: HarnessMcpServer): void {
  if (!NAME_PATTERN.test(server.name))
    throw invalid(
      '名字只能用字母、数字、_ 和 -，最长 32 个字',
      'The name may only use letters, digits, _ and -, up to 32 characters',
      'name',
    )
  if (server.transport === 'sse')
    throw invalid(
      'dsh 不支持 SSE，只有 stdio 和流式 HTTP',
      'dsh supports only stdio and streamable HTTP, not SSE',
      'transport',
    )
  if (server.transport === 'stdio' && !server.command?.trim())
    throw invalid('stdio 要填命令', 'stdio needs a command', 'command')
  if (server.transport === 'http' && !/^https?:\/\//.test(server.url ?? ''))
    throw invalid('要填 http(s) 的地址', 'An http(s) URL is required', 'url')
  if (server.bearerTokenEnvVar)
    throw invalid(
      'dsh 没有从环境变量取 Bearer token 的配置，写在请求头里',
      'dsh has no bearer token env var setting; put it in a header',
      'bearerTokenEnvVar',
    )
  for (const key of Object.keys(server.extra ?? {}))
    if (!EXTRA_KEYS.includes(key))
      throw invalid(`dsh 的 MCP 没有 ${key} 这一项`, `dsh MCP has no field ${key}`, key)
}

/** 新增或整条替换一个 MCP 服务 */
export function upsertMcp(
  previousName: string | undefined,
  server: HarnessMcpServer,
  expectedVersion: string,
): HarnessMcpWriteResponse {
  const { source, doc } = load()
  checkVersion(source, expectedVersion)
  validate(server)
  const all = rows(doc)
  const nameOf = (entry: Row) =>
    String(
      shown((entry.row.get('config', true) as YAMLMap | undefined)?.get('serverName', true)) ??
        entry.id,
    )
  const lookup = previousName ?? server.name
  let entry = all.find((one) => nameOf(one) === lookup)
  if (!entry && previousName)
    throw new HarnessConfigError(
      'notFound',
      text(`没有 ${previousName} 这个 MCP 服务`, `No MCP server named ${previousName}`),
    )
  if (all.some((one) => one !== entry && nameOf(one) === server.name))
    throw invalid(
      `已经有叫 ${server.name} 的 MCP 服务了`,
      `An MCP server named ${server.name} already exists`,
      'name',
    )
  if (!entry) {
    const ids = new Set(all.map((one) => one.id))
    let id = `mcp-${server.name}`
    for (let index = 2; ids.has(id); index++) id = `mcp-${server.name}-${index}`
    const row = doc.createNode({ id, name: MODULE, config: {} }) as YAMLMap
    const holder = doc.createNode([]) as YAMLSeq
    holder.items.push(row)
    top(doc).items.push(doc.createNode({ insert: holder }))
    entry = { holder, row, id }
  }
  const existing: unknown = entry.row.get('config', true)
  const map = isMap(existing) ? existing : new YAMLMap()
  if (map !== existing) entry.row.set('config', map)
  put(map, 'serverName', server.name)
  put(map, 'transport', server.transport === 'http' ? 'streamable-http' : 'stdio')
  if (server.transport === 'http') {
    for (const key of STDIO_KEYS) map.delete(key)
    put(map, 'url', server.url)
    putStrings(map, 'headers', server.headers)
  } else {
    for (const key of HTTP_KEYS) map.delete(key)
    put(map, 'command', server.command)
    put(map, 'args', server.args?.length ? server.args : undefined)
    putStrings(map, 'env', server.env)
    put(map, 'cwd', server.cwd || undefined)
  }
  for (const key of EXTRA_KEYS) put(map, key, server.extra?.[key])
  // 启停写在这一行上；顶层另有针对它的开关补丁（dsh 插件页写的）就删掉，免得两处说的不一样
  if (server.enabled) entry.row.delete('disabled')
  else entry.row.set('disabled', true)
  dropPatches(doc, entry.id)
  save(doc)
  return { version: versionOf(readFileSync(patchFile(), 'utf8')), restartRequired: false }
}

function dropPatches(doc: Document, id: string): void {
  const items = top(doc).items
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (isMap(item) && item.get('id') === id && !item.has('name') && !item.has('insert'))
      items.splice(index, 1)
  }
}

export function removeMcp(name: string, expectedVersion: string): HarnessMcpWriteResponse {
  const { source, doc } = load()
  checkVersion(source, expectedVersion)
  const entry = rows(doc).find(
    (one) =>
      String(
        shown((one.row.get('config', true) as YAMLMap | undefined)?.get('serverName', true)) ??
          one.id,
      ) === name,
  )
  if (!entry)
    throw new HarnessConfigError(
      'notFound',
      text(`没有 ${name} 这个 MCP 服务`, `No MCP server named ${name}`),
    )
  entry.holder.items.splice(entry.holder.items.indexOf(entry.row), 1)
  // insert 里空了，整项删掉
  if (!entry.holder.items.length) {
    const items = top(doc).items
    const index = items.findIndex(
      (item) => isMap(item) && (item.get('insert', true) as unknown) === entry.holder,
    )
    if (index >= 0) items.splice(index, 1)
  }
  dropPatches(doc, entry.id)
  save(doc)
  return { version: versionOf(readFileSync(patchFile(), 'utf8')), restartRequired: false }
}
