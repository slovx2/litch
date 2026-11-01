import type { CoreChannel } from '../channel/client.mjs'
import type { Clock, CommandName } from '../channel/protocol.mjs'

export interface SessionInteraction {
  deviceId: string
  sessionId: string
  at: number
}

export interface SidebarActivity {
  channel: CoreChannel
  visit(deviceId: string, sessionId: string): void
  time(deviceId: string, sessionId: string): number
  subscribe(listener: (deviceId: string) => void): () => void
  flush(): void
}

/** 明确由用户操作的命令。读取、预取、已读清除和设备通知不在这里。 */
const INTERACTIONS = new Set<CommandName>([
  'session.send',
  'session.create',
  'session.configure',
  'session.fork',
  'session.sideChat',
  'session.rollback',
  'session.edit',
  'session.compact',
  'session.implementPlan',
  'session.goal.set',
  'session.goal.clear',
  'session.questions.ignore',
  'session.rename',
  'session.archive',
  'session.delete',
  'session.unarchive',
  'session.place',
  'session.move',
  'session.interrupt',
  'session.recover',
  'session.dismissRecovery',
  'session.stopBackground',
  'session.steer',
  'session.unqueue',
  'session.resumeQueue',
  'session.respond',
  'session.spawn',
  'session.detach',
  'session.report.set',
  'session.proposal.accept',
  'session.proposal.dismiss',
  'session.proposal.answer',
  'session.proposal.here',
  'session.queuedNotes.deliver',
])

export interface ActivityStorage {
  load(): unknown
  save(entries: readonly SessionInteraction[]): void
}

/**
 * 只包住界面使用的通道：核心内部的定时任务、自动续跑不经过这里。
 * 存储由外壳注入，手机可复用；不依赖 DOM，也不向设备添加读写请求。
 */
export function createSidebarActivity(
  channel: CoreChannel,
  clock: Clock,
  storage?: ActivityStorage,
): SidebarActivity {
  const times = new Map<string, Map<string, SessionInteraction>>()
  const listeners = new Set<(deviceId: string) => void>()
  let latest = 0
  let lastVisit: SessionInteraction | null = null
  let cancelSave: (() => void) | null = null
  const put = (entry: SessionInteraction) => {
    let device = times.get(entry.deviceId)
    if (!device) times.set(entry.deviceId, (device = new Map()))
    device.set(entry.sessionId, entry)
    latest = Math.max(latest, entry.at)
  }
  try {
    const saved = storage?.load()
    if (Array.isArray(saved)) {
      for (const row of saved) {
        if (
          row &&
          typeof row.deviceId === 'string' &&
          typeof row.sessionId === 'string' &&
          typeof row.at === 'number' &&
          Number.isFinite(row.at) &&
          row.at > 0
        )
          put(row)
      }
    }
  } catch {
    /* 存储不可用不影响当前窗口。 */
  }

  const flush = () => {
    if (!cancelSave) return
    cancelSave()
    cancelSave = null
    try {
      storage?.save([...times.values()].flatMap((device) => [...device.values()]))
    } catch {
      /* 存储不可用不影响当前窗口。 */
    }
  }
  const stamp = () => (latest = Math.max(clock.now(), latest + 1))
  const record = (deviceId: string, sessionId: string, at: number) => {
    if ((times.get(deviceId)?.get(sessionId)?.at ?? 0) >= at) return
    put({ deviceId, sessionId, at })
    if (storage && !cancelSave) cancelSave = clock.setTimer(flush, 1000)
    for (const listener of listeners) listener(deviceId)
  }
  return {
    channel: {
      async command(name, params, options) {
        // 以用户发起的时刻排序；较慢的应答不能盖过其后发生的查看。
        const at = INTERACTIONS.has(name) ? stamp() : 0
        const result = await channel.command(name, params, options)
        if (INTERACTIONS.has(name) && 'deviceId' in params) {
          const target = params as { deviceId: string; sessionId?: string; parentId?: string }
          const id = target.sessionId ?? target.parentId
          if (id) record(target.deviceId, id, at)
          // 新建/分叉/派出成功时，返回的会话也有一次主动交互。
          if (
            result &&
            typeof result === 'object' &&
            'sessionId' in result &&
            typeof result.sessionId === 'string' &&
            result.sessionId !== id
          ) {
            record(target.deviceId, result.sessionId, at)
          }
        }
        return result
      },
      subscribe: (topic, sink) => channel.subscribe(topic, sink),
      close() {
        flush()
        channel.close()
      },
    },
    visit(deviceId, sessionId) {
      const now = clock.now()
      if (
        lastVisit?.deviceId === deviceId &&
        lastVisit.sessionId === sessionId &&
        now >= lastVisit.at &&
        now - lastVisit.at < 1000
      )
        return
      lastVisit = { deviceId, sessionId, at: now }
      record(deviceId, sessionId, stamp())
    },
    time: (deviceId, sessionId) => times.get(deviceId)?.get(sessionId)?.at ?? 0,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    flush,
  }
}
