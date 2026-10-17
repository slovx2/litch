// 用仓库固定的 Codex app-server JSON Schema 校验适配器发出的通知、应答与反向请求（与 dsh、Pi 的测试同一做法）。
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { Ajv } from 'ajv'
import { protocolDirectory } from '../../shared/src/protocol-path.mjs'

const root = resolve(process.env.CODEX_SCHEMA_DIR ?? protocolDirectory())
const files = new Map<string, string>()
function walk(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.name.endsWith('.json')) files.set(basename(entry.name, '.json'), path)
  }
}
walk(root)
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false })
const requests = JSON.parse(readFileSync(join(root, 'ClientRequest.json'), 'utf8'))
const validators = new Map<string, ReturnType<typeof ajv.compile>>()
const events = JSON.parse(readFileSync(join(root, 'ServerNotification.json'), 'utf8'))
const serverRequests = JSON.parse(readFileSync(join(root, 'ServerRequest.json'), 'utf8'))
export function assertServerRequest(method: string, value: unknown): void {
  const variant = serverRequests.oneOf.find((v: any) => v.properties.method.enum.includes(method))
  if (!variant) throw new Error(`缺少反向请求 schema: ${method}`)
  const key = `request:${method}`
  let validate = validators.get(key)
  if (!validate) {
    validate = ajv.compile({
      ...variant.properties.params,
      definitions: serverRequests.definitions,
    })
    validators.set(key, validate)
  }
  if (!validate(value)) throw new Error(`${method}: ${JSON.stringify(validate.errors)}`)
}
export function assertNotification(method: string, value: unknown): void {
  const variant = events.oneOf.find((v: any) => v.properties.method.enum.includes(method))
  if (!variant) return
  const key = `event:${method}`
  let validate = validators.get(key)
  if (!validate) {
    validate = ajv.compile({ ...variant.properties.params, definitions: events.definitions })
    validators.set(key, validate)
  }
  if (!validate(value)) throw new Error(`${method}: ${JSON.stringify(validate.errors)}`)
}
export function assertResponse(method: string, value: unknown): void {
  if (method === 'runtime/info') {
    let validate = validators.get(method)
    if (!validate) {
      const schema = JSON.parse(
        readFileSync(resolve(root, '../../../extensions/runtime-info.json'), 'utf8'),
      )
      // 共用的 runtime-info 结构里还没有 opencode 这一支（由集成那边加，形状和 dsh 一样：必有 nodeVersion，
      // cliBuild 是宿主 OpenCode 的版本号）。没有时照 dsh 那一支补一份再校验，加上之后用的就是正式的。
      const variants: any[] = schema.response.oneOf
      if (!variants.some((variant) => variant.properties?.engine?.const === 'opencode')) {
        const dsh = variants.find((variant) => variant.properties?.engine?.const === 'dsh')
        variants.push({ ...dsh, properties: { ...dsh.properties, engine: { const: 'opencode' } } })
        const engines: string[] = schema.response.properties.engine.enum
        if (!engines.includes('opencode')) engines.push('opencode')
      }
      validate = ajv.compile(schema.response)
      validators.set(method, validate)
    }
    if (!validate(value)) throw new Error(`${method}: ${JSON.stringify(validate.errors)}`)
    return
  }
  const variant = requests.oneOf.find((v: any) => v.properties.method.enum.includes(method))
  if (!variant) return
  const name = variant.properties.params?.$ref
    ?.split('/')
    .at(-1)
    ?.replace(/Params$/, 'Response')
  const path = files.get(name)
  if (!path) return
  let validate = validators.get(method)
  if (!validate) {
    validate = ajv.compile(JSON.parse(readFileSync(path, 'utf8')))
    validators.set(method, validate)
  }
  if (!validate(value)) throw new Error(`${method}: ${JSON.stringify(validate.errors)}`)
}
