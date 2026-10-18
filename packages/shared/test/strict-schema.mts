// 协议兼容性测试用的严格校验：把上游导出的结构定义快照“封闭”起来（不认识的字段一律算出入），
// 再拿它校验服务端发来的每一条消息。兼容性测试里的“结构校验”靠它。
//
// 上游的快照本身不拒绝多出来的字段（只有上游自己标了 deny_unknown_fields 的那几十处带 additionalProperties: false），
// 所以这里在装载时给每个对象形状补上 unevaluatedProperties: false。几处细节：
// - 上游把“公共字段加几种分支”写成同一层的 properties 加 oneOf/anyOf（serde 的 flatten），
//   分支只认自己的字段，公共字段由外面那层认：封闭只加在外面那层，分支里不加。
// - 带判别字段的 oneOf（type、mode 这类只取一个值的字段）补上 discriminator，校验只走对上号的那个分支，
//   报出来的才是那个分支的出入，不是每个分支各报一遍。
// - protocol/schema-corrections/ 里的勘误在这里生效；勘误对不上就报错。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { ErrorObject, ValidateFunction } from 'ajv'
import { Ajv2019 } from 'ajv/dist/2019.js'
import { protocolDirectory } from '../src/protocol-path.mjs'

const root = resolve(process.env.CODEX_SCHEMA_DIR ?? protocolDirectory())
const version = basename(dirname(root))
const protocolRoot = resolve(root, '../../..')

type Schema = Record<string, any>

const isObjectShape = (node: Schema): boolean =>
  node.properties !== undefined ||
  node.type === 'object' ||
  (Array.isArray(node.type) && node.type.includes('object'))

// 能当判别字段的：每个分支都是写在原处的对象、都必填这个字段、各自只取互不相同的几个字符串。
function discriminatorOf(branches: unknown[]): string | undefined {
  if (branches.length < 2) return undefined
  const first = branches[0] as Schema
  if (!first || typeof first !== 'object' || !first.properties) return undefined
  for (const name of Object.keys(first.properties)) {
    const seen = new Set<string>()
    const fits = branches.every((branch) => {
      const candidate = branch as Schema
      const tag = candidate?.properties?.[name]
      const values = tag?.enum ?? (tag?.const === undefined ? undefined : [tag.const])
      if (!Array.isArray(values) || !candidate.required?.includes(name)) return false
      return values.every((value) => {
        if (typeof value !== 'string' || seen.has(value)) return false
        seen.add(value)
        return true
      })
    })
    if (fits) return name
  }
  return undefined
}

// 封闭一份结构定义。flattened：这个结点是外层对象的一个分支，多出来的字段由外层管。
export function seal(node: unknown, flattened = false): unknown {
  if (Array.isArray(node)) return node.map((entry) => seal(entry))
  if (!node || typeof node !== 'object') return node
  const source = node as Schema
  const sealed: Schema = {}
  const shape = isObjectShape(source)
  for (const [key, value] of Object.entries(source)) {
    if (key === '$schema') continue
    if (key === 'properties' || key === 'definitions')
      sealed[key] = Object.fromEntries(
        Object.entries(value as Schema).map(([name, child]) => [name, seal(child)]),
      )
    else if (key === 'oneOf' || key === 'anyOf' || key === 'allOf')
      sealed[key] = (value as unknown[]).map((branch) =>
        seal(branch, shape && source.properties !== undefined),
      )
    else if (key === 'items' || key === 'additionalProperties' || key === 'not')
      sealed[key] = seal(value)
    else sealed[key] = value
  }
  if (shape && !flattened && !('additionalProperties' in source))
    sealed.unevaluatedProperties = false
  if (source.oneOf && !source.discriminator) {
    const tag = discriminatorOf(source.oneOf)
    if (tag && sealed.unevaluatedProperties === false) {
      // 校验库在同一层里先查“多出来的字段”、后按判别字段选分支：两样写在一起时，分支认的字段还没算进去，
      // 就全被当成多出来的。公共字段加分支的这种形状因此把分支挪进 allOf，分支认的字段会并回这一层。
      const branches = { oneOf: sealed.oneOf, discriminator: { propertyName: tag } }
      sealed.allOf = [...(sealed.allOf ?? []), branches]
      delete sealed.oneOf
    } else if (tag) sealed.discriminator = { propertyName: tag }
  }
  return sealed
}

// 勘误只许改名：把点名的那个分支里的字段名换掉，对不上就报错（上游修正之后要删掉这条勘误）。
function correct(file: string, schema: Schema): Schema {
  const path = join(protocolRoot, 'schema-corrections', `${version}.json`)
  if (!existsSync(path)) return schema
  for (const entry of JSON.parse(readFileSync(path, 'utf8')).corrections) {
    if (entry.file !== file) continue
    const branch = schema.definitions?.[entry.definition]?.oneOf?.find((candidate: Schema) =>
      candidate.properties?.type?.enum?.includes(entry.variant),
    )
    if (!branch) throw new Error(`勘误对不上：${file} 的 ${entry.definition}.${entry.variant}`)
    for (const [from, to] of Object.entries(entry.rename as Record<string, string>)) {
      if (!(from in branch.properties))
        throw new Error(`勘误对不上：${file} 的 ${entry.definition}.${entry.variant} 没有 ${from}`)
      branch.properties[to] = branch.properties[from]
      delete branch.properties[from]
      branch.required = branch.required?.map((name: string) => (name === from ? to : name))
    }
  }
  return schema
}

const files = new Map<string, string>()
const walk = (directory: string): void => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.name.endsWith('.json')) files.set(basename(entry.name, '.json'), path)
  }
}
walk(root)

const ajv = new Ajv2019({
  strict: false,
  allErrors: true,
  validateFormats: false,
  discriminator: true,
})
const loaded = new Map<string, Schema>()

// 装载上游的一个结构定义文件：勘误、封闭，登记给校验器，之后按“名字#路径”引用。
function upstream(name: string): Schema {
  let schema = loaded.get(name)
  if (schema) return schema
  const path = files.get(name)
  if (!path) throw new Error(`上游的结构定义里没有 ${name}`)
  const file = path.slice(root.length + 1)
  schema = seal(correct(file, JSON.parse(readFileSync(path, 'utf8')))) as Schema
  ajv.addSchema(schema, name)
  loaded.set(name, schema)
  return schema
}

const compiled = new Map<string, ValidateFunction>()
function validator(key: string, schema: () => Schema): ValidateFunction {
  let validate = compiled.get(key)
  if (!validate) {
    validate = ajv.compile(schema())
    compiled.set(key, validate)
  }
  return validate
}

// 联合类型文件（ServerNotification、ServerRequest、ClientRequest）的各个分支，和引用其中一个时的路径。
// 外层另有公共字段的（ServerNotification 的 emittedAtMs），分支在封闭时被挪进了 allOf（见 seal）。
function variantsOf(union: string): { branches: Schema[]; pointer: string } {
  const schema = upstream(union)
  if (schema.oneOf) return { branches: schema.oneOf, pointer: 'oneOf' }
  const last = schema.allOf.length - 1
  return { branches: schema.allOf[last].oneOf, pointer: `allOf/${last}/oneOf` }
}

// 联合类型文件里某个方法的参数。
function paramsOf(union: string, method: string): ValidateFunction | undefined {
  const { branches, pointer } = variantsOf(union)
  const index = branches.findIndex((variant) => variant.properties.method.enum.includes(method))
  if (index < 0) return undefined
  return validator(`${union}:${method}`, () => ({
    $ref: `${union}#/${pointer}/${index}/properties/params`,
  }))
}

export const upstreamHasNotification = (method: string): boolean =>
  variantsOf('ServerNotification').branches.some((variant) =>
    variant.properties.method.enum.includes(method),
  )

const methods = JSON.parse(
  readFileSync(join(protocolRoot, 'compat', `methods-${version}.json`), 'utf8'),
) as {
  clientRequests: Record<string, { response: string; experimental?: boolean }>
  serverRequests: Record<string, { response: string; experimental?: boolean }>
}

// 上游还在应答、但结构定义快照没有导出的旧方法，仓库里各补了一份定义（依据同版本官方的 TypeScript 定义）：
// 应答的形状要么写在那份定义里，要么指向上游的某个文件。protocol/extensions/ 里其余的是我们自己的扩展，不在这里。
const LEGACY_DEFINITIONS = [
  'get-auth-status.json',
  'git-diff-to-remote.json',
  'thread-rollback.json',
]
const legacy = new Map<string, Schema>()
for (const entry of LEGACY_DEFINITIONS) {
  const definition = JSON.parse(readFileSync(join(protocolRoot, 'extensions', entry), 'utf8'))
  legacy.set(definition.method, definition)
}

export const upstreamHasRequest = (method: string): boolean =>
  method in methods.clientRequests || legacy.has(method)

export const isExperimental = (method: string): boolean =>
  methods.clientRequests[method]?.experimental === true

function responseOf(method: string): ValidateFunction | undefined {
  const known = methods.clientRequests[method]
  const old = legacy.get(method)
  const inline = known && files.has(known.response) ? undefined : old?.response
  if (inline) return validator(`response:${method}`, () => inline)
  const name =
    known && files.has(known.response)
      ? known.response
      : old?.responseFile && basename(old.responseFile, '.json')
  if (!name) return undefined
  upstream(name)
  return validator(`response:${method}`, () => ({ $ref: `${name}#` }))
}

export interface Finding {
  /** 哪一类消息：通知、服务端请求、应答、错误应答，或者消息的外壳 */
  kind: 'notification' | 'serverRequest' | 'response' | 'error' | 'envelope'
  /** 方法名；外壳的出入这里是消息的类别 */
  method: string
  /** 出入在消息里的位置：数组下标写成 *，带 type 的对象后面附上它的 type */
  path: string
  problem: string
}

export const findingKey = (finding: Finding): string =>
  `${finding.kind} ${finding.method} ${finding.path || '/'} ${finding.problem}`

export type { ErrorObject, Schema }
export { ajv as strictAjv, methods as upstreamMethods, paramsOf, responseOf, upstream }
