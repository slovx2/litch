import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Ajv, type ValidateFunction } from 'ajv'
import { protocolDirectory } from '../../../shared/src/protocol-path.mjs'

// 我们自己的协议扩展在测试里的两件事：握手时怎么声明，以及按仓库里的扩展定义校验线上内容。
// 定义的原文在仓库根目录 protocol/extensions/ 下，改形状要同步改它。
const extensions = resolve(
  process.env.CODEX_SCHEMA_DIR ?? protocolDirectory(),
  '../../../extensions',
)
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false })
const compiled = new Map<string, ValidateFunction>()

function definition(file: string): any {
  return JSON.parse(readFileSync(resolve(extensions, file), 'utf8'))
}

function check(key: string, schema: () => unknown, value: unknown, what: string): void {
  let validate = compiled.get(key)
  if (!validate) {
    validate = ajv.compile(schema() as object)
    compiled.set(key, validate)
  }
  if (!validate(value))
    throw new Error(`${what} 不符合扩展定义: ${JSON.stringify(validate.errors)}`)
}

// 握手时声明认识这些扩展。
export function declaring(...names: string[]): Record<string, unknown> {
  return { litchExtensions: names }
}

export function assertRuntimeInfo(value: unknown): void {
  check(
    'runtime/info',
    () => definition('runtime-info.json').response,
    value,
    'runtime/info 的应答',
  )
}

const note = definition('decline-with-note.json')
const part = (kind: string) => note.parts.find((entry: any) => entry.kind === kind)
const withDefinitions = (schema: object) => ({ ...schema, definitions: note.definitions })

// 声明了 declineWithNote 的连接上给 ProtocolClient.standardView 用：
// 审批请求里的扩展内容按扩展定义校验后去掉，剩下的部分照旧按标准 schema 校验；
// “拒绝并附说明”的应答按扩展定义校验，不过标准 schema。
export function declineWithNoteView(
  method: string,
  kind: 'Params' | 'Response',
  payload: any,
): unknown {
  const command = method === 'item/commandExecution/requestApproval'
  if (!command && method !== 'item/fileChange/requestApproval') return payload
  if (kind === 'Response') {
    const decision = payload?.decision
    if (!decision || typeof decision !== 'object' || !('declineWithNote' in decision))
      return payload
    check(
      'declineWithNote:response',
      () => withDefinitions(part('ResponseVariant').schema),
      payload,
      '拒绝并附说明的应答',
    )
    return undefined
  }
  check(
    'declineWithNote:listed',
    () => withDefinitions(part('EnumValue').schema),
    payload.availableDecisions,
    `${method} 的 availableDecisions`,
  )
  const { availableDecisions, ...rest } = payload
  return command
    ? {
        ...rest,
        availableDecisions: availableDecisions.filter(
          (decision: unknown) => decision !== 'declineWithNote',
        ),
      }
    : rest
}
