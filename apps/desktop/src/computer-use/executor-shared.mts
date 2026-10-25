// 执行器两半（executor.mts、executor-win.mts）共用的几样：助手的接口、会话键、文字答复。
import type { ClientToolCallResponse } from '../../../../packages/protocol/src/client-tools.mjs'
import type { HelperHello } from './wire.mjs'

/** 执行器要的助手能力（看护者实现它；测试里用桩） */
export interface HelperAccess {
  client(): Promise<HelperRequester>
  /** 重启助手（macOS 屏幕录制授权后要重启进程才生效） */
  restart(): Promise<void>
  readonly connected: HelperRequester | null
}

export interface HelperRequester {
  /** 握手的结果（Windows 上看助手的完整性级别） */
  readonly hello?: HelperHello | null
  request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<unknown>
}

/** 动作和取状态最多等多久 */
export const CALL_TIMEOUT = 60_000

export function sessionKey(invocation: { device: { id: string }; threadId: string }): string {
  return `${invocation.device.id}/${invocation.threadId}`
}

export function text(value: string): ClientToolCallResponse {
  return { success: true, contentItems: [{ type: 'inputText', text: value }] }
}
