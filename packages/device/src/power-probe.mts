// 电源观察只在启动/重连时恢复已加载会话；周期只核对已知工作，不扫描历史，不发现外部新回合。
import { type Connector, isObject, type Wire } from './wire.mjs'

export interface PowerHarness {
  id: string
  connect: Connector
  running: boolean
  native?: boolean
}

export interface PowerProbeResult {
  active: Set<string>
  /** null 表示该会话的后台工作无法确认，不能当成已结束 */
  background: Map<string, boolean | null>
  /** 已加载清单查全了才可据“没出现”确认旧来源已结束 */
  complete: boolean
  unread: Set<string>
}

export async function probePower(
  harness: PowerHarness,
  options: {
    signal: AbortSignal
    timeoutMs: number
    version: string
    mode: 'recover' | 'known'
    knownThreads?: string[]
  },
): Promise<PowerProbeResult> {
  if (options.mode === 'known' && !options.knownThreads?.length)
    return { active: new Set(), background: new Map(), complete: true, unread: new Set() }
  let wire: Wire | null = null
  let ended = false
  let sequence = 0
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const abort = () => {
    if (ended) return
    ended = true
    for (const entry of waiting.values()) entry.reject(new Error('电源活动探测已结束'))
    waiting.clear()
    wire?.close()
  }
  const controller = new AbortController()
  const canceled = () => controller.abort()
  options.signal.addEventListener('abort', canceled, { once: true })
  controller.signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  const call = (method: string, params: unknown): Promise<unknown> => {
    if (ended) return Promise.reject(new Error('电源活动探测已结束'))
    return new Promise((resolve, reject) => {
      const id = ++sequence
      waiting.set(id, { resolve, reject })
      wire?.send(JSON.stringify({ id, method, params }))
    })
  }
  try {
    if (options.signal.aborted) throw new Error('电源活动探测已取消')
    // Connector 本身没有取消接口；迟到的连接必须当场关闭，调用方不能一直等它。
    await new Promise<void>((resolve, reject) => {
      const canceled = () => reject(new Error('电源活动探测已取消'))
      controller.signal.addEventListener('abort', canceled, { once: true })
      harness
        .connect({
          message(raw) {
            let frame: unknown
            try {
              frame = JSON.parse(raw)
            } catch {
              return
            }
            if (
              !isObject(frame) ||
              typeof frame.method === 'string' ||
              typeof frame.id !== 'number'
            )
              return
            const entry = waiting.get(frame.id)
            if (!entry) return
            waiting.delete(frame.id)
            if (frame.error) entry.reject(new Error('引擎拒绝电源活动查询'))
            else entry.resolve(frame.result)
          },
          close: () => controller.abort(),
        })
        .then(
          (connected) => {
            controller.signal.removeEventListener('abort', canceled)
            if (ended) {
              connected.close()
              return
            }
            wire = connected
            resolve()
          },
          (error: unknown) => {
            controller.signal.removeEventListener('abort', canceled)
            reject(error)
          },
        )
    })
    await call('initialize', {
      clientInfo: { name: 'litch-power-observer', title: null, version: options.version },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    })
    ;(wire as Wire | null)?.send(JSON.stringify({ method: 'initialized' }))
    const result: PowerProbeResult = {
      active: new Set(),
      background: new Map(),
      complete: true,
      unread: new Set(),
    }
    if (!harness.native) {
      // 自有引擎提供内存只读查询；没有公开协议扩展，不扫描历史，也不订阅或启动会话。
      const known = options.mode === 'known' ? new Set(options.knownThreads ?? []) : null
      const response = await call(
        'litch/internal/power/activity',
        known ? { threadIds: [...known] } : {},
      )
      if (!isObject(response) || !Array.isArray(response.threads))
        throw new Error('内部电源活动应答形状不对')
      for (const row of response.threads) {
        if (
          !isObject(row) ||
          typeof row.threadId !== 'string' ||
          typeof row.active !== 'boolean' ||
          typeof row.background !== 'boolean' ||
          result.background.has(row.threadId) ||
          (known && !known.has(row.threadId))
        )
          throw new Error('内部电源活动线程形状不对')
        if (row.active) result.active.add(row.threadId)
        result.background.set(row.threadId, row.background)
      }
      if (known)
        for (const thread of known) if (!result.background.has(thread)) result.unread.add(thread)
      return result
    }
    const read = async (thread: unknown) => {
      if (!isObject(thread) || typeof thread.id !== 'string' || !isObject(thread.status))
        throw new Error('会话活动状态缺失')
      if (!['active', 'idle', 'notLoaded', 'systemError'].includes(String(thread.status.type)))
        throw new Error('无法识别会话活动状态')
      if (thread.status.type === 'active') result.active.add(thread.id)
      else result.active.delete(thread.id)
      const background = isObject(thread.litchBackground) ? thread.litchBackground : null
      if (background && Array.isArray(background.tasks)) {
        result.background.set(
          thread.id,
          background.tasks.some((task: unknown) => isObject(task) && task.status === 'running'),
        )
      } else if (thread.status.type === 'notLoaded') result.background.set(thread.id, false)
      else {
        try {
          const tasks = await call('thread/backgroundTerminals/list', { threadId: thread.id })
          result.background.set(
            thread.id,
            isObject(tasks) && Array.isArray(tasks.data) ? tasks.data.length > 0 : null,
          )
        } catch {
          if (ended) throw new Error('电源活动探测已结束')
          result.background.set(thread.id, null)
        }
      }
    }
    // 恢复只看运行时已加载集合；周期核对不允许读取全局清单，避免发现绕过设备路由的新回合。
    const loaded = new Set(options.knownThreads ?? [])
    if (options.mode === 'recover')
      try {
        const cursors = new Set<string>()
        let cursor: string | undefined
        do {
          const page = await call('thread/loaded/list', {
            limit: 100,
            ...(cursor ? { cursor } : {}),
          })
          if (
            !isObject(page) ||
            !Array.isArray(page.data) ||
            page.data.some((id: unknown) => typeof id !== 'string')
          )
            throw new Error('已加载会话清单形状不对')
          for (const id of page.data) loaded.add(id as string)
          if (page.nextCursor != null && typeof page.nextCursor !== 'string')
            throw new Error('已加载会话游标形状不对')
          cursor =
            typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined
          if (cursor && cursors.has(cursor)) throw new Error('已加载会话分页游标重复')
          if (cursor) cursors.add(cursor)
        } while (cursor)
      } catch {
        if (ended) throw new Error('电源活动探测已结束')
        result.complete = false
      }
    for (const threadId of loaded) {
      if (result.background.has(threadId)) continue
      try {
        const response = await call('thread/read', { threadId, includeTurns: false })
        if (!isObject(response) || !isObject(response.thread) || response.thread.id !== threadId)
          throw new Error('只读会话应答形状不对')
        await read(response.thread)
      } catch {
        if (ended) throw new Error('电源活动探测已结束')
        result.unread.add(threadId)
      }
    }
    return result
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', canceled)
    abort()
  }
}
