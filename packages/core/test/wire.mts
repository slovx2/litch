// 测试里“界面那一头”的搭法：经真的通道订阅会话，不绕过它。
//
// 通道把增量排一帧再发，排队期间核心还在接着干活。测试辅助要是在核心交出增量的当下就取值，
// 这一段时序就没有人测：流式文字在界面上出现两遍的毛病就是这样漏过去的。
// 所以这里用真的 serveChannel 和 connectChannel，帧由辅助自己掌握：读结果的那一刻才过帧。
// 这比真的一帧排得还久，这期间到的改动全都有机会坏事，够严。
import {
  type ChannelError,
  type Clock,
  type CoreHost,
  connectChannel,
  type Port,
  reduceSession,
  type SessionView,
  serveChannel,
} from '../src/index.mjs'

interface End {
  handler: ((message: unknown) => void) | null
  closed: boolean
}

/** 同线程的一对端口：发出的那一刻取值，当场送到对面。读结果时不用再等一轮事件循环 */
function syncPorts(): [Port, Port] {
  const make = (self: End, peer: End): Port => ({
    post(message) {
      if (!self.closed && !peer.closed) peer.handler?.(structuredClone(message))
    },
    listen(handler) {
      self.handler = handler
    },
    close() {
      self.closed = true
    },
  })
  const a: End = { handler: null, closed: false }
  const b: End = { handler: null, closed: false }
  return [make(a, b), make(b, a)]
}

/** 只管通道那一帧的时钟：定时器不会自己到点，run 的时候把到现在为止设下的一起触发 */
function manualFrames() {
  const due = new Set<() => void>()
  const clock: Clock = {
    now: () => 0,
    setTimer(callback) {
      due.add(callback)
      return () => {
        due.delete(callback)
      }
    },
  }
  return {
    clock,
    run() {
      for (const callback of [...due]) {
        due.delete(callback)
        callback()
      }
    },
  }
}

/**
 * 订阅一个会话，并像界面那样把快照和增量落成一份视图。
 * seen 里的东西每次读都先过一帧：排在通道里的增量这时才发出来、才取值
 */
export function watchSession(core: CoreHost, sessionId = 'a', deviceId = 'local') {
  const frames = manualFrames()
  const [uiPort, corePort] = syncPorts()
  serveChannel(corePort, core, { clock: frames.clock })
  const channel = connectChannel(uiPort)
  const state = {
    view: null as SessionView | null,
    snapshots: 0,
    errors: [] as ChannelError[],
  }
  const close = channel.subscribe(
    { kind: 'session', deviceId, sessionId },
    {
      snapshot(data) {
        state.view = data
        state.snapshots++
      },
      delta(ops) {
        for (const op of ops) if (state.view) reduceSession(state.view, op)
      },
      error: (error) => state.errors.push(error),
    },
  )
  const seen = {
    get view() {
      frames.run()
      return state.view
    },
    get snapshots() {
      frames.run()
      return state.snapshots
    },
    get errors() {
      frames.run()
      return state.errors
    },
  }
  /** 每个回合里各条目的文字；没有文字的条目给它的种类 */
  const texts = () => {
    const view = seen.view
    return (view?.turns ?? []).map((entry) =>
      entry.itemIds.map((id) => {
        const item = view?.items[id]
        return item && 'text' in item ? item.text : item?.kind
      }),
    )
  }
  return { seen, close, texts }
}
