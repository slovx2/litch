// harness 详情设置（harnessConfig 扩展）测试共用的：按 protocol/extensions/harness-config.json 校验线上的形状
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Ajv } from 'ajv'
import { REPO } from './helpers.mjs'

export const HC = JSON.parse(
  readFileSync(join(REPO, 'protocol/extensions/harness-config.json'), 'utf8'),
)
const ajv = new Ajv({ strict: false, allErrors: true })

function part(kind: string, method?: string): any {
  const found = HC.parts.find(
    (item: any) => item.kind === kind && (method === undefined || item.method === method),
  )
  if (!found) throw new Error(`harness-config.json 里没有 ${kind} ${method ?? ''}`)
  return found
}

function check(schema: unknown, value: unknown, what: string): void {
  const validate = ajv.compile({ ...(schema as object), definitions: HC.definitions })
  if (!validate(value))
    throw new Error(`${what} 和 harness-config.json 对不上：${JSON.stringify(validate.errors)}`)
}

/** 某个方法的应答对得上定义 */
export const assertHcResponse = (method: string, value: unknown) =>
  check(part('ClientRequest', method).response, value, `${method} 的应答`)
/** 某个方法的参数对得上定义 */
export const assertHcParams = (method: string, value: unknown) =>
  check(part('ClientRequest', method).params, value, `${method} 的参数`)
export const assertHcNotification = (method: string, value: unknown) =>
  check(part('ServerNotification', method).params, value, `${method} 的参数`)
export const assertHcError = (value: unknown) => check(part('Error').data, value, 'error.data')

export const CHANGED = 'litch/harness/config/changed'
export const AUTH_UPDATED = 'litch/harness/auth/updated'
