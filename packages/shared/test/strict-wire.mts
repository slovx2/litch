// 服务端发来的一条消息与上游结构的出入。应答、通知、服务端请求和它们的外壳都查，
// 结果是一组“在哪、差什么”，写法不带具体的标识和下标，同一种出入每次得到同一条。
import type { ValidateFunction } from 'ajv'
import {
  type ErrorObject,
  type Finding,
  paramsOf,
  responseOf,
  strictAjv,
  upstream,
} from './strict-schema.mjs'

const tagOf = (value: unknown): string =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  typeof (value as any).type === 'string'
    ? `<${(value as any).type}>`
    : ''

// 沿着校验器给的位置走一遍实例：数组下标写成 *，带 type 的对象后面附上它的 type。
function locate(instance: unknown, pointer: string): { path: string; value: unknown } {
  let value = instance
  let path = tagOf(value)
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    const index = Array.isArray(value)
    value = (value as any)?.[key]
    path += `/${index ? '*' : key}${tagOf(value)}`
  }
  return { path, value }
}

const brief = (value: unknown): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text === undefined ? 'undefined' : text.length > 60 ? `${text.slice(0, 60)}…` : text
}

// 把校验器报的错整理成出入。联合类型没对上时每个旁支都会报一遍“类型不对”，
// 同一处或它里面已经有别的出入的，那些“类型不对”是旁支的，不算。
export function describe(
  errors: ErrorObject[],
  instance: unknown,
): Array<{ path: string; problem: string }> {
  const found = new Map<string, { path: string; problem: string }>()
  const add = (pointer: string, problem: string): void => {
    const { path } = locate(instance, pointer)
    found.set(`${path} ${problem}`, { path, problem })
  }
  const substantive: string[] = []
  const mistyped = new Map<string, Set<string>>()
  for (const error of errors) {
    const pointer = error.instancePath
    const { value } = locate(instance, pointer)
    if (error.keyword === 'anyOf' || error.keyword === 'oneOf') continue
    if (error.keyword === 'type') {
      const types = mistyped.get(pointer) ?? new Set<string>()
      for (const type of [error.params.type].flat()) types.add(String(type))
      mistyped.set(pointer, types)
      continue
    }
    substantive.push(pointer)
    if (error.keyword === 'unevaluatedProperties')
      add(pointer, `多出字段 ${error.params.unevaluatedProperty}`)
    else if (error.keyword === 'additionalProperties')
      add(pointer, `多出字段 ${error.params.additionalProperty}`)
    else if (error.keyword === 'required') add(pointer, `缺少字段 ${error.params.missingProperty}`)
    else if (error.keyword === 'enum' || error.keyword === 'const')
      add(pointer, `取值不在上游的枚举里：${brief(value)}`)
    else if (error.keyword === 'discriminator')
      add(
        pointer,
        error.params.error === 'mapping'
          ? `未知的 ${error.params.tag} 取值：${brief(error.params.tagValue)}`
          : `缺少字段 ${error.params.tag}`,
      )
    else add(pointer, `不符合 ${error.keyword}`)
  }
  for (const [pointer, types] of mistyped) {
    if (substantive.some((other) => other === pointer || other.startsWith(`${pointer}/`))) continue
    add(pointer, `类型不符，应为 ${[...types].sort().join(' 或 ')}`)
  }
  return [...found.values()]
}

function mismatches(
  validate: ValidateFunction,
  instance: unknown,
): Array<{ path: string; problem: string }> {
  if (validate(instance)) return []
  const described = describe(validate.errors ?? [], instance)
  return described.length ? described : [{ path: '', problem: '不符合上游的任何一种形状' }]
}

const envelopes = new Map<string, ValidateFunction>()
function envelope(name: string): ValidateFunction {
  let validate = envelopes.get(name)
  if (!validate) {
    upstream(name)
    validate = strictAjv.compile({ $ref: `${name}#` })
    envelopes.set(name, validate)
  }
  return validate
}

export type WireKind = 'notification' | 'serverRequest' | 'response' | 'error'

export function kindOf(message: any): WireKind | undefined {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined
  if (typeof message.method === 'string') return 'id' in message ? 'serverRequest' : 'notification'
  if ('error' in message) return 'error'
  if ('result' in message) return 'response'
  return undefined
}

/**
 * 服务端发来的一条消息与上游结构的出入。requested：这条应答对应的请求是哪个方法（按 id 查），
 * 只有应答用得到。消息必须是线上的样子（经过一次 JSON 序列化），不是进程里的对象。
 */
export function inspect(
  message: any,
  requested: (id: unknown) => string | undefined = () => undefined,
): Finding[] {
  const kind = kindOf(message)
  if (!kind)
    return [{ kind: 'envelope', method: 'unknown', path: '', problem: '认不出是哪一种消息' }]
  const findings: Finding[] = []
  const outer = (name: string, value: unknown): void => {
    for (const found of mismatches(envelope(name), value))
      findings.push({ kind: 'envelope', method: kind, ...found })
  }
  if (kind === 'notification') {
    // 上游的通知外壳上另有一个可选的发出时间
    const { emittedAtMs, ...rest } = message
    if (emittedAtMs !== undefined && !Number.isInteger(emittedAtMs))
      findings.push({
        kind: 'envelope',
        method: kind,
        path: '/emittedAtMs',
        problem: '类型不符，应为 integer',
      })
    outer('JSONRPCNotification', rest)
    const validate = paramsOf('ServerNotification', message.method)
    if (!validate)
      return [...findings, { kind, method: message.method, path: '', problem: '上游没有这个通知' }]
    for (const found of mismatches(validate, message.params))
      findings.push({ kind, method: message.method, ...found })
    return findings
  }
  if (kind === 'serverRequest') {
    outer('JSONRPCRequest', message)
    const validate = paramsOf('ServerRequest', message.method)
    if (!validate)
      return [
        ...findings,
        { kind, method: message.method, path: '', problem: '上游没有这个服务端请求' },
      ]
    for (const found of mismatches(validate, message.params))
      findings.push({ kind, method: message.method, ...found })
    return findings
  }
  if (kind === 'error') {
    outer('JSONRPCError', message)
    return findings
  }
  outer('JSONRPCResponse', message)
  const method = requested(message.id)
  if (!method)
    return [
      ...findings,
      { kind: 'envelope', method: kind, path: '/id', problem: '应答对不上任何请求' },
    ]
  const validate = responseOf(method)
  if (!validate)
    return [...findings, { kind, method, path: '', problem: '没有可用来校验这个应答的结构定义' }]
  for (const found of mismatches(validate, message.result))
    findings.push({ kind, method, ...found })
  return findings
}

/** 客户端发出去的请求参数是否符合上游结构（不封闭：新版客户端多带的字段服务端本来就该忽略） */
export function requestParamsProblems(method: string, params: unknown): string[] {
  const validate = paramsOf('ClientRequest', method)
  if (!validate) return []
  if (validate(params)) return []
  // 这里只关心缺字段和类型不对，多出来的字段不算
  return describe(validate.errors ?? [], params)
    .filter((found) => !found.problem.startsWith('多出字段'))
    .map((found) => `${found.path || '/'} ${found.problem}`)
}
