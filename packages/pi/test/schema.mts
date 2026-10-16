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
