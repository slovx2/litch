import type { AbortSignalLike, Clock } from '../channel/protocol.mjs'
import { RpcAbortError } from '../connection/rpc.mjs'
import { isSessionRecovering } from './faults.mjs'

// 只重试订阅，六次退避累计 15.75 秒；不重发用户输入或其他写操作。
const DELAYS = [250, 500, 1000, 2000, 4000, 8000]

export async function resumeAfterRecovery<T>(
  request: () => Promise<T>,
  clock: Clock,
  signal: AbortSignalLike,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw new RpcAbortError('cancelled', '已取消')
    try {
      return await request()
    } catch (error) {
      const delay = DELAYS[attempt]
      if (!isSessionRecovering(error) || delay === undefined) throw error
      await new Promise<void>((resolve, reject) => {
        const stop = clock.setTimer(resolve, delay)
        signal.addEventListener(
          'abort',
          () => {
            stop()
            reject(new RpcAbortError('cancelled', '已取消'))
          },
          { once: true },
        )
      })
    }
  }
}
