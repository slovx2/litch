import {
  HARNESS_CONFIG_ERROR_CODE,
  type HarnessConfigErrorData,
  type HarnessConfigErrorReason,
  type HarnessText,
} from '../../protocol/src/harness-config.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'

// harness 详情设置几个文件共用的：错误、给人看的字、进行中的登录。单放一个文件，免得几个文件互相引用时初始化顺序出错。

export const HARNESS_ID = 'opencode'

export const text = (zh: string, en: string): HarnessText => ({ 'zh-CN': zh, en })

export class HarnessError extends ProtocolError {
  readonly data: HarnessConfigErrorData
  constructor(reason: HarnessConfigErrorReason, message: HarnessText, key?: string) {
    super(HARNESS_CONFIG_ERROR_CODE, message['zh-CN'])
    this.data = { litch: reason, harness: HARNESS_ID, message, ...(key ? { key } : {}) }
  }
}

export const conflict = () =>
  new HarnessError(
    'versionConflict',
    text(
      '配置在别处被改过了，请重读后再改',
      'The configuration changed elsewhere; reload and try again',
    ),
  )

export const invalid = (key: string, zh: string, en: string) =>
  new HarnessError('invalidValue', text(zh, en), key)

export const notFound = (zh: string, en: string) => new HarnessError('notFound', text(zh, en))

/** OpenCode 的报错原样带上 */
export function opencodeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 进行中的一次登录 */
export interface Attempt {
  id: string
  providerId?: string
  mcpServer?: string
  /** provider 登录：OpenCode 里登录方式的序号 */
  index?: number
  /** 下一步等什么：inputs 是先填 OpenCode 的提示项；code 是粘贴授权码；waiting 是等 OpenCode 那边完成 */
  stage: 'inputs' | 'code' | 'waiting'
  abort: AbortController
}
