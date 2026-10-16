import { Ajv } from 'ajv'
import { jsonSchemaValidator } from './json-schema.mjs'

// Claude Code CLI 用 draft-07 的 Ajv 严格模式校验 --json-schema（2.1.286 的实现是
// new Ajv({ allErrors: true, validateFormats: false })，先 validateSchema 再 compile）。
// 声明了别的草案，或出现 draft-07 没有的关键字，CLI 启动即以 1 退出，回合只剩一句“进程退出”。
// 自定义的注解关键字同样会被拒绝。这里把 2019-09 / 2020-12 的写法换成 draft-07 的等价写法再
// 交给 CLI；换不了的不删，直接报出原因。回合结束时的结果仍按原模式和它声明的草案校验
// （见 native-runtime）。

const DRAFT_07 = 'http://json-schema.org/draft-07/schema'
const DRAFT_2019 = 'https://json-schema.org/draft/2019-09/schema'
const DRAFT_2020 = 'https://json-schema.org/draft/2020-12/schema'

type Schema = Record<string, unknown>

// 值是单个子模式、子模式数组、名字到子模式的映射的关键字；其余关键字的值不是模式，原样保留。
const single = new Set([
  'additionalProperties',
  'additionalItems',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'contentSchema',
  'unevaluatedItems',
  'unevaluatedProperties',
])
const lists = new Set(['allOf', 'anyOf', 'oneOf'])
const maps = new Set(['properties', 'patternProperties', '$defs', 'definitions'])
const dependencyKeywords = new Set(['dependencies', 'dependentRequired', 'dependentSchemas'])

const isRecord = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function convert(node: unknown, draft2020: boolean, root = false): unknown {
  if (!isRecord(node)) return node
  const each = (value: unknown) =>
    Array.isArray(value) ? value.map((entry) => convert(entry, draft2020)) : value
  const values = (value: unknown) =>
    isRecord(value)
      ? Object.fromEntries(
          Object.entries(value).map(([name, entry]) => [name, convert(entry, draft2020)]),
        )
      : value
  const out: Schema = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema') {
      if (!root) throw new Error('子模式里另行声明了 $schema')
    } else if (key === 'prefixItems' && draft2020) {
      out.items = each(value)
    } else if (key === 'items') {
      // 2020-12 里与 prefixItems 并用的 items 约束的是其余元素，即 draft-07 的 additionalItems。
      if (draft2020 && 'prefixItems' in node) out.additionalItems = convert(value, draft2020)
      else out.items = Array.isArray(value) ? each(value) : convert(value, draft2020)
    } else if (key === 'additionalItems' && draft2020) {
      throw new Error('2020-12 没有 additionalItems 关键字，请改用 prefixItems 与 items')
    } else if (dependencyKeywords.has(key)) {
      // 下面统一合并。
    } else if (single.has(key)) out[key] = convert(value, draft2020)
    else if (lists.has(key)) out[key] = each(value)
    else if (maps.has(key)) out[key] = values(value)
    else out[key] = value
  }
  // dependentRequired / dependentSchemas 合起来就是 draft-07 的 dependencies。
  const parts = new Map<string, unknown[]>()
  for (const keyword of dependencyKeywords) {
    const entries = node[keyword]
    if (!isRecord(entries)) continue
    for (const [name, entry] of Object.entries(entries))
      parts.set(name, [
        ...(parts.get(name) ?? []),
        Array.isArray(entry) ? entry : convert(entry, draft2020),
      ])
  }
  if (parts.size > 0)
    out.dependencies = Object.fromEntries(
      [...parts].map(([name, entries]) => [
        name,
        entries.length === 1
          ? entries[0]
          : { allOf: entries.map((entry) => (Array.isArray(entry) ? { required: entry } : entry)) },
      ]),
    )
  return out
}

// 返回可以交给 CLI 的模式；交不了时抛出带原因的错误。
export function cliOutputSchema(schema: unknown): Schema {
  if (!isRecord(schema)) throw new Error('outputSchema 必须是 JSON 对象')
  if (schema.$schema !== undefined && typeof schema.$schema !== 'string')
    throw new Error('outputSchema 的 $schema 必须是字符串')
  const declared = typeof schema.$schema === 'string' ? schema.$schema.replace(/#$/, '') : null
  if (declared !== null && ![DRAFT_07, DRAFT_2019, DRAFT_2020].includes(declared))
    throw new Error(
      `outputSchema 声明了不支持的 $schema：${schema.$schema}（支持 draft-07、2019-09、2020-12）`,
    )
  if (schema.$async) throw new Error('outputSchema 不支持 $async')
  try {
    // 先按它自己声明的草案确认是合法模式。
    jsonSchemaValidator(schema, { validateFormats: false, logger: false }).compile(schema)
  } catch (error) {
    throw new Error(`outputSchema 不是合法的 JSON Schema：${reason(error)}`)
  }
  try {
    const converted =
      declared === DRAFT_2019 || declared === DRAFT_2020
        ? (convert(schema, declared === DRAFT_2020, true) as Schema)
        : schema
    // 与 CLI 相同的校验，把它会在启动时拒绝的模式拦在这里。
    const ajv = new Ajv({ allErrors: true, validateFormats: false, logger: false })
    if (!ajv.validateSchema(converted)) throw new Error(ajv.errorsText(ajv.errors))
    ajv.compile(converted)
    return converted
  } catch (error) {
    throw new Error(
      `Claude Code 按 draft-07 严格校验输出格式，不接受这个 outputSchema：${reason(error)}`,
    )
  }
}

export function cliOutputFormat(outputFormat: unknown): unknown {
  if (!isRecord(outputFormat) || outputFormat.type !== 'json_schema') return outputFormat
  return { ...outputFormat, schema: cliOutputSchema(outputFormat.schema) }
}
