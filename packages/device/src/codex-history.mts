import { setTimeout as delay } from 'node:timers/promises'
import { isObject, UpstreamRpcError } from './wire.mjs'

export function readsCodexHistory(method: string, params: unknown): boolean {
  return (
    method === 'thread/turns/list' ||
    method === 'thread/resume' ||
    (method === 'thread/read' && isObject(params) && params.includeTurns === true)
  )
}

/**
 * Codex 0.163.0 的分页校验会在 SQLite 元数据尚不可见时回 list_turns 不支持；
 * thread/read、resume 内部也会走它。只重试这一条明确错误，不重建历史、不换游标，
 * 不重放新建、分叉或回合操作。永久不支持仍返回原错，总用时不超过原请求期限。
 */
export async function readCodexHistory<T>(
  method: string,
  params: unknown,
  timeoutMs: number,
  ask: (timeoutMs: number) => Promise<T>,
): Promise<T> {
  const deadline = performance.now() + timeoutMs
  const pauses = [50, 100, 200]
  for (let attempt = 0; ; attempt++) {
    try {
      return await ask(Math.max(1, Math.ceil(deadline - performance.now())))
    } catch (error) {
      const pause = pauses[attempt]
      if (
        !readsCodexHistory(method, params) ||
        !(error instanceof UpstreamRpcError) ||
        error.code !== -32601 ||
        error.message !== 'list_turns is not supported yet' ||
        pause === undefined ||
        performance.now() + pause >= deadline
      )
        throw error
      await delay(pause)
      if (performance.now() >= deadline) throw error
    }
  }
}
