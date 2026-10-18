// 看一个运行时上是不是有回合在跑。重启、停用一个 harness 之前要知道：有回合在跑就不擅自打断。
// 判断不了的时候一律按“有”。
//
// 做法是另开一条临时连接去问：回合也可能是官方桌面端经那个 harness 自己的入口发起的，
// 聚合面上的连接看不到，只有运行时自己知道。三个引擎都会在会话对象的 status 上如实报 active，
// 回合一开始会话就排到按更新时间倒序的最前面，所以看第一页就够了。
// 以后引擎要是提供更直接的问法，换成那个。
import { type Connector, isObject, type Wire } from './wire.mjs'

const PAGE = 100

export async function hasActiveTurn(
  connect: Connector,
  timeoutMs: number,
  version: string,
): Promise<boolean> {
  let wire: Wire | null = null
  let timer: NodeJS.Timeout | undefined
  // 等太久已经给出结论之后，才连上的那条连接没有人用了，要关掉
  let abandoned = false
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const fail = (error: Error) => {
    for (const entry of waiting.values()) entry.reject(error)
    waiting.clear()
  }
  let sequence = 0
  const call = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      waiting.set(id, { resolve, reject })
      wire?.send(JSON.stringify({ id, method, params }))
    })
  try {
    const ask = async (): Promise<boolean> => {
      wire = await connect({
        message(raw) {
          let frame: unknown
          try {
            frame = JSON.parse(raw)
          } catch {
            return
          }
          // 只认自己那两个请求的应答；对面主动发来的通知不管
          if (!isObject(frame) || typeof frame.method === 'string') return
          const entry = typeof frame.id === 'number' ? waiting.get(frame.id) : undefined
          if (!entry || typeof frame.id !== 'number') return
          waiting.delete(frame.id)
          if (frame.error) entry.reject(new Error('对面回了错误'))
          else entry.resolve(frame.result)
        },
        close: () => fail(new Error('连接断开了')),
      })
      if (abandoned) {
        wire.close()
        throw new Error('已经不用了')
      }
      await call('initialize', {
        clientInfo: { name: 'litch-device', title: null, version },
        capabilities: { experimentalApi: true, requestAttestation: false },
      })
      wire.send(JSON.stringify({ method: 'initialized' }))
      const result = await call('thread/list', {
        limit: PAGE,
        sortKey: 'updated_at',
        sortDirection: 'desc',
      })
      if (!isObject(result) || !Array.isArray(result.data)) throw new Error('应答的形状不对')
      return result.data.some(
        (thread) => isObject(thread) && isObject(thread.status) && thread.status.type === 'active',
      )
    }
    return await Promise.race([
      ask(),
      new Promise<boolean>((_, reject) => {
        timer = setTimeout(() => reject(new Error('超时')), timeoutMs)
      }),
    ])
  } catch {
    // 连不上、握手不成、它不认识这个问法、等太久：都判断不了，按有回合在跑处理
    return true
  } finally {
    abandoned = true
    clearTimeout(timer)
    fail(new Error('已经不用了'))
    ;(wire as Wire | null)?.close()
  }
}
