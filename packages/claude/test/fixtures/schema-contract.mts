import { readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { Ajv, type ValidateFunction } from 'ajv'
import { protocolDirectory } from '../../../shared/src/protocol-path.mjs'

const root = resolve(process.env.CODEX_SCHEMA_DIR ?? protocolDirectory())
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false })
const validators = new Map<string, ValidateFunction>()
const definitions = new Map<string, { schema: any; params: any; direction: string }>()
const files = new Map<string, string>()

function loadContracts(): void {
  if (definitions.size) return
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.json')) files.set(basename(entry.name, '.json'), path)
    }
  }
  walk(root)
  for (const direction of [
    'ClientRequest',
    'ServerRequest',
    'ServerNotification',
    'ClientNotification',
  ]) {
    const schema = JSON.parse(readFileSync(join(root, `${direction}.json`), 'utf8'))
    for (const variant of schema.oneOf) {
      for (const method of variant.properties.method.enum)
        definitions.set(method, { schema, params: variant.properties.params, direction })
    }
  }
  // 旧 Desktop 入口由适配层保留；响应仍严格采用当前 Thread 的原生 schema。
  definitions.set('thread/rollback', {
    schema: {},
    params: {
      type: 'object',
      required: ['threadId', 'numTurns'],
      properties: { threadId: { type: 'string' }, numTurns: { type: 'integer', minimum: 0 } },
    },
    direction: 'ClientRequest',
  })
}

// 从固定 CLI 生成的 union 索引协议，未登记的方法不能静默绕过 schema 检查。
export function validatePayload(
  method: string,
  kind: 'Params' | 'Response',
  payload: unknown,
): void {
  loadContracts()
  const contract = definitions.get(method)
  if (!contract) throw new Error(`缺少协议 schema: ${method}`)
  const key = `${method}:${kind}`
  let validator = validators.get(key)
  if (!validator) {
    if (kind === 'Params') {
      validator = ajv.compile({ ...contract.params, definitions: contract.schema.definitions })
    } else {
      const name =
        method === 'thread/rollback'
          ? 'ThreadReadResponse'
          : method === 'account/rateLimits/read'
            ? 'GetAccountRateLimitsResponse'
            : method === 'config/mcpServer/reload'
              ? 'McpServerRefreshResponse'
              : method === 'config/value/write' || method === 'config/batchWrite'
                ? 'ConfigWriteResponse'
                : contract.params?.$ref
                    ?.split('/')
                    .at(-1)
                    ?.replace(/Params$/, 'Response')
      const file = files.get(name)
      if (!file) throw new Error(`缺少响应 schema: ${method} (${name})`)
      validator = ajv.compile(JSON.parse(readFileSync(file, 'utf8')))
    }
    validators.set(key, validator)
  }
  if (!validator(payload))
    throw new Error(`协议 schema 不匹配 ${method} ${kind}: ${JSON.stringify(validator.errors)}`)
}
