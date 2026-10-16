import { Ajv, type Options } from 'ajv'
import { Ajv2019 } from 'ajv/dist/2019.js'
import { Ajv2020 } from 'ajv/dist/2020.js'

// 客户端下发的 schema 可能声明 2019-09/2020-12 草案（如 Codex Desktop 的动态工具），
// 默认 Ajv 只认识 draft-07，按 $schema 选择对应实现，否则整轮会以“no schema with key or ref”失败。
const drafts: Record<string, new (options: Options) => Ajv> = {
  'https://json-schema.org/draft/2020-12/schema': Ajv2020,
  'https://json-schema.org/draft/2019-09/schema': Ajv2019,
}

export function jsonSchemaValidator(schema: Record<string, unknown>, options: Options = {}) {
  const declared = typeof schema.$schema === 'string' ? schema.$schema.replace(/#$/, '') : ''
  const Implementation = drafts[declared] ?? Ajv
  return new Implementation({ strict: false, ...options })
}
