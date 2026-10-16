// 模拟核心的终端：订阅列表和输出、开、写、改大小、改名、关、重开，背后是假 shell（mock-shell.mts）。
// 输出走的是和真的核心同一份缓冲与限量（device/terminal-stream.mts），所以界面跟不上时的略过、
// 回报进度之后才接着给，这些路径在浏览器里对着模拟核心也走得到。
// 设备是设备服务（完整模式）的，终端算属于设备的：可以“留在设备上”再接回来；别的设备上的随连接结束。
import { ChannelError, type Clock, type Commands, type Topic } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import { TerminalStream } from '../device/terminal-stream.mjs'
import type { DeviceView } from '../model.mjs'
import type {
  TerminalInfo,
  TerminalsAlive,
  TerminalsOp,
  TerminalsView,
} from '../model-terminal.mjs'
import { phrase } from '../phrase.mjs'
import { createFakeShell, type FakeShell } from './mock-shell.mjs'
import type { SampleLang } from './sample-text.mjs'

export interface MockTerminalsHost {
  clock: Clock
  /** 流式回答每一小块之间隔多久。假命令的“过一会儿”是它的倍数 */
  stepMs: number
  lang: SampleLang
  device(deviceId: string): DeviceView | undefined
  /** 工作区的根目录。没有这个工作区就是 null */
  workspaceRoot(deviceId: string, workspaceId: string): string | null
}

export interface MockTerminals {
  subscribe(topic: Extract<Topic, { kind: 'terminals' | 'terminal' }>, sink: HostSink): () => void
  /** 是终端的命令就处理；不是就返回 undefined，交给别处 */
  command(name: string, params: unknown): Promise<unknown> | undefined
  /** 还活着的终端有多少，和真的核心一个算法：留在设备上不看的不算 */
  alive(): TerminalsAlive
  /** 把开成标签、属于设备的都结束 */
  endAll(): void
}

interface MockTerm {
  info: TerminalInfo
  deviceId: string
  stream: TerminalStream
  shell: FakeShell | null
}

/** 模拟的设备上同时最多开这么多个，到了就拒绝：给界面试“到上限了”的提示 */
const LIMIT = 8

export function createMockTerminals(host: MockTerminalsHost): MockTerminals {
  const { clock } = host
  const terms = new Map<string, MockTerm>()
  const sinks = new Map<string, Set<HostSink>>()
  let seq = 0
  let lastOrder = 0

  const reach = (deviceId: string): DeviceView => {
    const device = host.device(deviceId)
    if (!device) throw new ChannelError('notFound', `没有这台设备：${deviceId}`)
    return device
  }
  const find = (deviceId: string, terminalId: string): MockTerm => {
    const term = terms.get(terminalId)
    if (!term || term.deviceId !== deviceId) {
      throw new ChannelError('notFound', `没有这个终端：${terminalId}`)
    }
    return term
  }
  const online = (deviceId: string): DeviceView => {
    const device = reach(deviceId)
    if (device.connection !== 'online') throw new ChannelError('offline', '设备没有连上')
    return device
  }
  const publish = (deviceId: string, ops: TerminalsOp[]) => {
    for (const sink of sinks.get(deviceId) ?? []) sink.delta(ops)
  }
  const announce = (term: MockTerm, patch: Partial<TerminalInfo> = {}) => {
    term.info = { ...term.info, ...patch }
    publish(term.deviceId, [{ op: 'terminal.upsert', terminal: term.info }])
  }
  const listOf = (deviceId: string): TerminalInfo[] =>
    [...terms.values()].filter((term) => term.deviceId === deviceId).map((term) => term.info)

  /** 起假 shell。它退出时把终端标成已退出 */
  const start = (term: MockTerm, device: DeviceView) => {
    term.shell = createFakeShell({
      clock,
      stepMs: host.stepMs,
      lang: host.lang,
      host: device.host,
      cwd: term.info.cwd ?? '~',
      size: () => ({ rows: term.info.rows, cols: term.info.cols }),
      out: (data, bytes) => term.stream.push(data, bytes),
      exit(code) {
        term.shell = null
        announce(term, { state: 'exited', exitCode: code })
      },
    })
  }

  const remove = (term: MockTerm) => {
    term.shell?.stop()
    term.stream.dispose()
    terms.delete(term.info.id)
    publish(term.deviceId, [{ op: 'terminal.remove', terminalId: term.info.id }])
  }

  const handlers: { [K in keyof Commands]?: (params: Commands[K]['params']) => unknown } = {
    'terminal.open'({ deviceId, workspaceId, cwd, rows, cols }) {
      const device = online(deviceId)
      const mine = listOf(deviceId)
      if (mine.filter((info) => info.state === 'running').length >= LIMIT) {
        throw new ChannelError(
          'rejected',
          '设备上同时开的终端到上限了',
          phrase('terminal.limit', { limit: LIMIT }),
        )
      }
      const group = workspaceId ?? null
      const used = new Set(
        mine.filter((info) => info.workspaceId === group).map((info) => info.seq),
      )
      let next = 1
      while (used.has(next)) next++
      lastOrder = Math.max(clock.now(), lastOrder + 1)
      const root = group ? host.workspaceRoot(deviceId, group) : null
      const term: MockTerm = {
        deviceId,
        stream: new TerminalStream({ clock }),
        shell: null,
        info: {
          id: `mock-term-${++seq}`,
          workspaceId: group,
          title: null,
          seq: next,
          cwd: cwd ?? root ?? '~',
          state: 'running',
          exitCode: null,
          // 设备服务上的终端属于设备；别的对面上的随连接结束
          durable: device.mode === 'full',
          shown: true,
          rows: Math.max(1, Math.floor(rows) || 24),
          cols: Math.max(1, Math.floor(cols) || 80),
          order: lastOrder,
        },
      }
      terms.set(term.info.id, term)
      announce(term)
      start(term, device)
      return { terminalId: term.info.id }
    },
    'terminal.write'({ deviceId, terminalId, data }) {
      const term = find(deviceId, terminalId)
      online(deviceId)
      if (!term.shell) {
        throw new ChannelError('rejected', '这个终端不在运行', phrase('terminal.notRunning'))
      }
      term.shell.input(data)
      return {}
    },
    'terminal.resize'({ deviceId, terminalId, rows, cols }) {
      const term = find(deviceId, terminalId)
      const next = { rows: Math.max(1, Math.floor(rows)), cols: Math.max(1, Math.floor(cols)) }
      if (next.rows === term.info.rows && next.cols === term.info.cols) return {}
      announce(term, next)
      term.shell?.resized()
      return {}
    },
    'terminal.redraw'({ deviceId, terminalId }) {
      find(deviceId, terminalId).shell?.resized()
      return {}
    },
    'terminal.rename'({ deviceId, terminalId, title }) {
      announce(find(deviceId, terminalId), { title: title.trim().slice(0, 120) || null })
      return {}
    },
    'terminal.close'({ deviceId, terminalId, mode }) {
      const term = find(deviceId, terminalId)
      if (mode === 'leave') {
        if (!term.info.durable || term.info.state !== 'running') {
          throw new ChannelError('rejected', '这个终端留不住：它不属于设备，或者已经结束了')
        }
        announce(term, { shown: false })
      } else remove(term)
      return {}
    },
    'terminal.show'({ deviceId, terminalId }) {
      announce(find(deviceId, terminalId), { shown: true })
      return {}
    },
    'terminal.restart'({ deviceId, terminalId, rows, cols }) {
      const term = find(deviceId, terminalId)
      const device = online(deviceId)
      if (term.info.state !== 'exited' && term.info.state !== 'lost') {
        throw new ChannelError('rejected', '这个终端还在运行')
      }
      term.stream.reset()
      announce(term, {
        state: 'running',
        exitCode: null,
        rows: Math.max(1, Math.floor(rows) || 24),
        cols: Math.max(1, Math.floor(cols) || 80),
      })
      start(term, device)
      return {}
    },
    'terminal.ack'({ deviceId, terminalId, viewer, epoch, offset }) {
      const term = terms.get(terminalId)
      if (term?.deviceId === deviceId) term.stream.ack(viewer, epoch, offset)
      return {}
    },
  }

  return {
    subscribe(topic, sink) {
      if (topic.kind === 'terminal') {
        return find(topic.deviceId, topic.terminalId).stream.attach(sink, topic.have)
      }
      const device = reach(topic.deviceId)
      const view: TerminalsView = {
        deviceId: topic.deviceId,
        // 没连着的设备：这次运行里还不知道它是哪一种
        durable: device.connection === 'online' ? device.mode === 'full' : null,
        terminals: listOf(topic.deviceId),
      }
      sink.snapshot(view)
      const set = sinks.get(topic.deviceId) ?? new Set<HostSink>()
      sinks.set(topic.deviceId, set)
      set.add(sink)
      return () => {
        set.delete(sink)
      }
    },

    command(name, params) {
      const handler = (handlers as Record<string, ((params: never) => unknown) | undefined>)[name]
      if (!handler) return undefined
      // 出错也走应答那条路，和别的命令一样
      return new Promise((resolve) => resolve(handler(params as never)))
    },

    alive() {
      const count: TerminalsAlive = { durable: 0, ephemeral: 0 }
      for (const { info } of terms.values()) {
        if (info.state !== 'running') continue
        if (!info.durable) count.ephemeral++
        else if (info.shown) count.durable++
      }
      return count
    },

    endAll() {
      for (const term of [...terms.values()]) {
        if (term.info.durable && term.info.shown && term.info.state === 'running') remove(term)
      }
    },
  }
}
