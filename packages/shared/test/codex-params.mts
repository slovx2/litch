// 原生 codex 收不收一份参数：发给它的 thread/start、turn/start 逐条照上游的约束核对，返回它会拒绝或悄悄丢掉的地方。
// 依据是上游 openai/codex 的 rust-v0.160.0-alpha.3（和本机实测用的 codex 0.160.0 最接近的标签），跟进上游时对一遍：
//   - 形状：仓库固定的协议快照（protocol/codex-app-server/0.163.0）封闭之后校验（strict-schema.mts 的 seal）。
//     上游不拒绝多出来的字段、只是悄悄丢掉，发了它不认识的字段等于没发，所以多出来的也算出入；
//   - thread/start：app-server/src/request_processors/thread_processor.rs 的 thread_start
//     （permissions 和 sandbox 不能同时给、projectId 不能是空的）和 validate_dynamic_tools（逐条抄）；
//     动态工具的参数结构照 codex-rs/tools/src/json_schema.rs 的 parse_tool_input_schema：先整理、再按它的结构反序列化，
//     反序列化不过的整个 thread/start 被拒；
//   - turn/start：turn_processor.rs 的 validate_user_input_image_urls（输入里的图片不能是远程地址）。
// 0.8.0 的命名空间说明超过 1024 个字，codex 整个拒绝 thread/start，用户在 Codex 上一个会话都建不成：这里就是守这一类的。
import { paramsOf } from './strict-schema.mjs'
import { describe } from './strict-wire.mjs'

const NAME_MAX = 128
const NAMESPACE_MAX = 64
const NAMESPACE_DESCRIPTION_MAX = 1024
const RESERVED_NAMESPACES = new Set([
  'api_tool',
  'browser',
  'computer',
  'container',
  'file_search',
  'functions',
  'image_gen',
  'multi_tool_use',
  'python',
  'python_user_visible',
  'submodel_delegator',
  'terminal',
  'tool_search',
  'web',
])
const PRIMITIVES = ['string', 'number', 'boolean', 'integer', 'object', 'array', 'null']
/**
 * 上游的 JsonSchema 结构认的键；别的键整理之后被丢掉，模型看不到。format、prefixItems 整理时只拿来推断类型，
 * 推断完也丢掉，所以不在这里面
 */
const KEPT = new Set([
  '$ref',
  'type',
  'description',
  'encrypted',
  'enum',
  'const',
  'items',
  'minItems',
  'properties',
  'required',
  'additionalProperties',
  'anyOf',
  'oneOf',
  'allOf',
  '$defs',
  'definitions',
])

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 上游按字符（Rust 的 chars，即码点）数，不是按 UTF-16 */
const chars = (text: string) => [...text].length

/** 名字和命名空间：只许字母数字下划线连字符（按字节查，汉字也算不合格），不超过上限 */
function identifier(value: string, label: string, max: number): string[] {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) return [`${label} 只能是字母数字下划线连字符：${value}`]
  if (chars(value) > max) return [`${label} 超过 ${max} 个字：${value}`]
  return []
}

/**
 * 一份参数结构能不能被上游收下（parse_tool_input_schema）：整理（sanitize_json_schema）之后，
 * 每个结点都要能反序列化成它的 JsonSchema。整理得很宽（类型不认识的会推断或者清空），真会失败的只有下面这几种。
 * dropped 收集整理时被丢掉的键：codex 不交给模型，写了等于没写
 */
function schemaProblems(node: unknown, path: string, dropped: Set<string>): string[] {
  // 布尔形式的结构整理成字符串，数组逐个整理
  if (typeof node === 'boolean') return []
  if (!isObject(node)) return [`${path} 不是一个结构（对象）`]
  const problems: string[] = []
  const child = (value: unknown, at: string) => problems.push(...schemaProblems(value, at, dropped))
  for (const key of Object.keys(node)) if (!KEPT.has(key)) dropped.add(key)
  if (node.$ref !== undefined && typeof node.$ref !== 'string')
    problems.push(`${path}.$ref 不是字符串`)
  if (node.description !== undefined && typeof node.description !== 'string')
    problems.push(`${path}.description 不是字符串`)
  if (node.encrypted !== undefined && typeof node.encrypted !== 'boolean')
    problems.push(`${path}.encrypted 不是布尔`)
  if (node.enum !== undefined && !Array.isArray(node.enum)) problems.push(`${path}.enum 不是数组`)
  if (
    node.minItems !== undefined &&
    !(Number.isInteger(node.minItems) && Number(node.minItems) >= 0)
  )
    problems.push(`${path}.minItems 不是非负整数`)
  if (
    node.required !== undefined &&
    !(Array.isArray(node.required) && node.required.every((entry) => typeof entry === 'string'))
  )
    problems.push(`${path}.required 不是字符串数组`)
  if (node.properties !== undefined) {
    if (!isObject(node.properties)) problems.push(`${path}.properties 不是对象`)
    else
      for (const [name, value] of Object.entries(node.properties)) child(value, `${path}.${name}`)
  }
  if (node.items !== undefined) child(node.items, `${path}[]`)
  if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean')
    child(node.additionalProperties, `${path}.additionalProperties`)
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const list = node[key]
    if (list === undefined) continue
    if (!Array.isArray(list)) problems.push(`${path}.${key} 不是数组`)
    else for (const [index, entry] of list.entries()) child(entry, `${path}.${key}[${index}]`)
  }
  for (const key of ['$defs', 'definitions']) {
    // 定义表不是对象的，上游直接丢掉，不报错
    const table = node[key]
    if (isObject(table))
      for (const [name, value] of Object.entries(table)) child(value, `${path}.${key}.${name}`)
  }
  return problems
}

/** 只有一个 null 类型的顶层结构上游不收 */
function nullOnly(schema: unknown): boolean {
  if (!isObject(schema)) return false
  const type = schema.type
  const types = (Array.isArray(type) ? type : [type]).filter(
    (entry): entry is string => typeof entry === 'string' && PRIMITIVES.includes(entry),
  )
  return types.length === 1 && types[0] === 'null'
}

/** validate_dynamic_tools 逐条抄。dropped 收集参数结构里 codex 不交给模型的键 */
export function dynamicToolProblems(tools: unknown, dropped = new Set<string>()): string[] {
  if (!Array.isArray(tools)) return []
  const problems: string[] = []
  const tool = (entry: Json, namespace: string | null, seen: Set<string>) => {
    const name = String(entry.name ?? '')
    const label = namespace ? `${namespace}.${name}` : name
    if (name.trim() === '') return problems.push('工具名是空的')
    if (name.trim() !== name) return problems.push(`工具名前后有空白：${label}`)
    const bad = identifier(name, '工具名', NAME_MAX)
    if (bad.length > 0) return problems.push(...bad)
    if (name === 'mcp' || name.startsWith('mcp__')) return problems.push(`工具名是保留的：${label}`)
    if (seen.has(name)) return problems.push(`工具名重复：${label}`)
    seen.add(name)
    if (entry.deferLoading === true && namespace === null)
      return problems.push(`延迟装载的工具要放在命名空间里：${label}`)
    if (nullOnly(entry.inputSchema)) return problems.push(`${label} 的参数结构只有 null`)
    return problems.push(...schemaProblems(entry.inputSchema, `${label} 的参数`, dropped))
  }
  const topLevel = new Set<string>()
  const namespaces = new Set<string>()
  for (const spec of tools) {
    if (!isObject(spec)) continue
    if (spec.type === 'function') {
      tool(spec, null, topLevel)
      continue
    }
    const name = String(spec.name ?? '')
    const bad = identifier(name, '命名空间', NAMESPACE_MAX)
    if (name.trim() === '') problems.push('命名空间是空的')
    else if (name.trim() !== name) problems.push(`命名空间前后有空白：${name}`)
    else if (bad.length > 0) problems.push(...bad)
    else if (chars(String(spec.description ?? '')) > NAMESPACE_DESCRIPTION_MAX)
      problems.push(
        `${name} 的说明有 ${chars(String(spec.description))} 个字，上限 ${NAMESPACE_DESCRIPTION_MAX}`,
      )
    else if (name === 'mcp' || name.startsWith('mcp__')) problems.push(`命名空间是保留的：${name}`)
    else if (RESERVED_NAMESPACES.has(name))
      problems.push(`命名空间和 Responses API 的保留名撞了：${name}`)
    else if (namespaces.has(name)) problems.push(`命名空间重复：${name}`)
    else if (!Array.isArray(spec.tools) || spec.tools.length === 0)
      problems.push(`命名空间里一个工具都没有：${name}`)
    else {
      namespaces.add(name)
      const seen = new Set<string>()
      for (const entry of spec.tools) if (isObject(entry)) tool(entry, name, seen)
    }
  }
  return problems
}

/** 远程地址的图片（上游 is_remote_image_url：第一个冒号前面是 http 或 https，不管后面有没有 //） */
const remote = (url: unknown) => typeof url === 'string' && /^https?:/i.test(url)

/** 一份参数到了原生 codex 手里：rejects 是它会整个拒绝的原因，ignored 是它不认识、悄悄丢掉的字段（发了等于没发） */
export interface CodexVerdict {
  rejects: string[]
  ignored: string[]
}

/**
 * 原生 codex 怎么看一份参数。params 是线上的样子（经过一次 JSON 序列化），
 * 聚合面自己的参数（harness、projectId）要先摘掉：设备进程转给 codex 之前就摘了
 */
export function codexVerdict(method: 'thread/start' | 'turn/start', params: unknown): CodexVerdict {
  const validate = paramsOf('ClientRequest', method)
  if (!validate) throw new Error(`上游的协议快照里没有 ${method}`)
  const verdict: CodexVerdict = { rejects: [], ignored: [] }
  if (!validate(params)) {
    const errors = validate.errors ?? []
    const line = (found: { path: string; problem: string }) =>
      `${method} 的参数${found.path || '/'}：${found.problem}`
    // 上游不拒绝多出来的字段，悄悄丢掉（封闭时补的 unevaluatedProperties 报的就是这种）；
    // 上游自己标了 deny_unknown_fields 的几处（快照里的 additionalProperties: false）照样拒绝
    const extra = new Set(
      describe(
        errors.filter((error) => error.keyword === 'unevaluatedProperties'),
        params,
      ).map(line),
    )
    for (const found of describe(errors, params).map(line))
      (extra.has(found) ? verdict.ignored : verdict.rejects).push(found)
  }
  if (!isObject(params)) return verdict
  if (method === 'thread/start') {
    if (params.sandbox != null && params.permissions != null)
      verdict.rejects.push('thread/start 的 permissions 不能和 sandbox 一起给')
    if (params.projectId === '') verdict.rejects.push('thread/start 的 projectId 是空的')
    verdict.rejects.push(...dynamicToolProblems(params.dynamicTools))
  } else {
    const input = Array.isArray(params.input) ? params.input : []
    if (input.some((item) => isObject(item) && item.type === 'image' && remote(item.url)))
      verdict.rejects.push('turn/start 的输入里有远程地址的图片')
  }
  return verdict
}

/** 原生 codex 会拒绝或悄悄丢掉的地方：Litch 自己发的参数两样都不该有 */
export function codexRejects(method: 'thread/start' | 'turn/start', params: unknown): string[] {
  const { rejects, ignored } = codexVerdict(method, params)
  return [...rejects, ...ignored]
}
