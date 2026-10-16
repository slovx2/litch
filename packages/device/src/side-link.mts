// 设备进程自己另开的一条到运行时的临时连接：握手、问几个问题、关掉。
// 聚合面上的上游连接是每条客户端连接各有一组的，没有客户端连着的时候设备进程手里一条都没有；
// 设备层自己要读引擎的数据（导入现有的项目）时用这个。它不声明任何扩展，对引擎来说就是一个普通的客户端。
import { type Connector, isObject, UpstreamRpcError, type Wire } from './wire.mjs'

export interface SideLink {
  /** 上游回了错误时抛 UpstreamRpcError；没等到应答、连接断了抛普通的 Error */
  call(method: string, params: unknown): Promise<unknown>
  close(): void
}

interface Waiting {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

export async function openSideLink(
  connect: Connector,
  version: string,
  timeoutMs: number,
): Promise<SideLink> {
  const waiting = new Map<number, Waiting>()
  let sequence = 0
  let closed = false
  const fail = (error: Error) => {
    for (const entry of waiting.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    waiting.clear()
  }
  const wire: Wire = await connect({
    message(raw) {
      let frame: unknown
      try {
        frame = JSON.parse(raw)
      } catch {
        return
      }
      // 只认自己那些请求的应答。对面主动发来的通知不管；它发来要答复的请求也不答：
      // 这条连接马上就关，替用户答一个审批不是它该做的事
      if (!isObject(frame) || typeof frame.method === 'string') return
      const entry = typeof frame.id === 'number' ? waiting.get(frame.id) : undefined
      if (!entry || typeof frame.id !== 'number') return
      waiting.delete(frame.id)
      clearTimeout(entry.timer)
      const error = frame.error
      if (isObject(error))
        entry.reject(
          new UpstreamRpcError({
            code: typeof error.code === 'number' ? error.code : -32603,
            message: typeof error.message === 'string' ? error.message : '上游回了一个错误',
            data: error.data,
          }),
        )
      else entry.resolve(frame.result)
    },
    close: () => {
      closed = true
      fail(new Error('连接断开了'))
    },
  })
  const call = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error('连接已经关了'))
        return
      }
      const id = ++sequence
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error(`${method} 等了 ${timeoutMs} 毫秒没有应答`))
      }, timeoutMs)
      timer.unref()
      waiting.set(id, { resolve, reject, timer })
      wire.send(JSON.stringify({ id, method, params }))
    })
  const close = () => {
    if (closed) return
    closed = true
    fail(new Error('连接已经关了'))
    wire.close()
  }
  try {
    await call('initialize', {
      clientInfo: { name: 'litch-device', title: null, version },
      // 项目那组方法在上游协议里标着实验性
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    wire.send(JSON.stringify({ method: 'initialized' }))
  } catch (error) {
    close()
    throw error
  }
  return { call, close }
}
