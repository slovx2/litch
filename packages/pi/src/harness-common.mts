// harness 详情设置几处共用的东西：错误、版本号、读文件、通知。不引用各块的实现，免得互相引用时初始化出错。
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EXTENSION } from '../../protocol/src/device.mjs'
import {
  HARNESS_CONFIG_ERROR_CODE,
  HARNESS_CONFIG_NOTIFICATION,
  type HarnessConfigChangedNotification,
  type HarnessConfigErrorData,
  type HarnessConfigErrorReason,
  type HarnessText,
} from '../../protocol/src/harness-config.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import { getAgentDir, ModelRuntime } from './sdk.mjs'
import type { PiServer } from './server.mjs'

export const HARNESS = 'pi'

export const t = (zh: string, en: string): HarnessText => ({ 'zh-CN': zh, en })

/** 协议约定的错误：code 是 -32000，data 里 litch 说是哪一种（server.mts 把 data 原样带上） */
export class HarnessConfigError extends ProtocolError {
  readonly data: HarnessConfigErrorData
  constructor(reason: HarnessConfigErrorReason, message: HarnessText, key?: string) {
    super(HARNESS_CONFIG_ERROR_CODE, message['zh-CN'])
    this.data = { litch: reason, harness: HARNESS, ...(key ? { key } : {}), message }
  }
}

export function fail(
  reason: HarnessConfigErrorReason,
  zh: string,
  en: string,
  key?: string,
): never {
  throw new HarnessConfigError(reason, t(zh, en), key)
}

/** 文件内容的哈希，当作不透明的版本号；文件不存在是空串 */
export const hashOf = (...contents: Array<string | undefined>): string =>
  contents.every((content) => content === undefined)
    ? ''
    : createHash('sha256')
        .update(contents.map((content) => content ?? '\u0000').join('\u0001'))
        .digest('hex')
        .slice(0, 32)

export async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error: any) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/** 读一个 JSON 对象文件（Pi 的几份配置都是），不存在当空对象；坏了报 unavailable，不覆盖它 */
export function parseObject(text: string | undefined, path: string): Record<string, any> {
  if (text === undefined || !text.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    fail(
      'unavailable',
      `${path} 不是合法的 JSON（${reason}），先修好它`,
      `${path} is not valid JSON (${reason}); fix it first`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    fail('unavailable', `${path} 的顶层应当是对象`, `The top level of ${path} must be an object`)
  return parsed as Record<string, any>
}

export function checkVersion(expected: unknown, actual: string): void {
  if (expected !== actual)
    fail(
      'versionConflict',
      '配置在别处被改过了，重新读一遍再改',
      'The configuration was changed elsewhere; read it again before editing',
    )
}

export const agentPath = (name: string): string => join(getAgentDir(), name)

/** 告诉声明了 harnessConfig 的连接：这一块经这套接口被改了，该重读 */
export function changed(s: PiServer, part: HarnessConfigChangedNotification['part']): void {
  s.notifyExtension(EXTENSION.harnessConfig, HARNESS_CONFIG_NOTIFICATION.changed, {
    harness: HARNESS,
    part,
  } satisfies HarnessConfigChangedNotification)
}

/** 和 model/list 一样从代理目录的 auth.json、models.json 建一份模型运行时（不联网） */
export const modelRuntime = () =>
  ModelRuntime.create({ authPath: agentPath('auth.json'), modelsPath: agentPath('models.json') })
