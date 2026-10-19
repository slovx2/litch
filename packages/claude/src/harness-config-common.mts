// harness 详情设置（harnessConfig 扩展）几处共用的：harness 的 id、带 data 的错误、中英文的字。
import type {
  HarnessConfigErrorData,
  HarnessConfigErrorReason,
  HarnessText,
} from '../../protocol/src/harness-config.mjs'
import { HARNESS_CONFIG_ERROR_CODE } from '../../protocol/src/harness-config.mjs'
import { NativeFileError } from './claude-native-files.mjs'
import { ProtocolError } from './protocol-contract.mjs'

export const CLAUDE_HARNESS_ID = 'claude-code'

export class HarnessConfigError extends ProtocolError {
  readonly data: HarnessConfigErrorData
  constructor(reason: HarnessConfigErrorReason, message: HarnessText, key?: string) {
    super(HARNESS_CONFIG_ERROR_CODE, message['zh-CN'])
    this.data = {
      litch: reason,
      harness: CLAUDE_HARNESS_ID,
      ...(key === undefined ? {} : { key }),
      message,
    }
  }
}

export function text(zh: string, en: string): HarnessText {
  return { 'zh-CN': zh, en }
}

// 读原生文件出错（JSON 坏了之类）统一报 unavailable，说清是哪个文件
export function fileError(error: unknown): never {
  if (error instanceof HarnessConfigError) throw error
  if (error instanceof NativeFileError)
    throw new HarnessConfigError('unavailable', text(error.message, `Cannot read ${error.path}`))
  const message = error instanceof Error ? error.message : String(error)
  throw new HarnessConfigError('unavailable', text(message, message))
}
