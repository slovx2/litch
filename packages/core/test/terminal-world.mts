// 终端这一组测试共用的搭建：一个真的核心，对面是假的聚合面（fake-device.mts）加假进程（fake-processes.mts）；
// “界面那一头”经真的通道订阅终端的列表和输出，像界面那样把增量落下来、回报处理进度。
import {
  type ChannelError,
  type Clock,
  type CoreHost,
  connectChannel,
  createCore,
  decodeBase64,
  decodeUtf8,
  type Port,
  serveChannel,
  type TerminalInfo,
  type TerminalMark,
  type TerminalNotes,
  type TerminalStreamView,
  type TerminalsOp,
  type TerminalsView,
} from '../src/index.mjs'
import { fakeDevice, harness } from './fake-device.mjs'
import { fakeProcesses } from './fake-processes.mjs'
import { fakeOpener, type Handler } from './fake-server.mjs'
import { project } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'

const never = { aborted: false, addEventListener() {} }

interface End {
  handler: ((message: unknown) => void) | null
  closed: boolean
}

/** 同线程的一对端口，发出的那一刻按 JSON 取值：通道上传不了的东西（字节数组之类）在这里就会露出来 */
function jsonPorts(): [Port, Port] {
  const make = (self: End, peer: End): Port => ({
    post(message) {
      if (!self.closed && !peer.closed) peer.handler?.(JSON.parse(JSON.stringify(message)))
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

/** 只管通道那一帧的时钟：run 的时候把到现在为止设下的一起触发 */
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

export interface TerminalWorldOptions {
  /** 设备信息里声明的扩展。默认带可重连的终端 */
  extensions?: string[]
  /** 设备给每个进程留多少字节的输出 */
  keep?: number
  /** 这台电脑上记着的名字和“留在设备上不看的” */
  notes?: TerminalNotes | null
  extra?: Record<string, Handler>
}

/** 完整模式：对面是设备服务，有一个工作区（w1，根目录 /work/app） */
export function terminalWorld(options: TerminalWorldOptions = {}) {
  const fake = fakeDevice([harness('pi')])
  fake.device.extensions = options.extensions ?? ['harness', 'deviceProcesses']
  const time = fakeClock()
  const procs = fakeProcesses(() => peer.last(), options.keep ?? 64)
  const peer = fakeOpener({
    ...fake.handlers,
    'project/list': () => ({ data: [project('w1', '应用', '/work/app')], nextCursor: null }),
    ...procs.handlers,
    ...options.extra,
  })
  const logs: string[] = []
  const saved: TerminalNotes[] = []
  let notes: TerminalNotes | null = options.notes ?? null
  const store = {
    load: () => ({ localWire: null, remotes: [] }),
    save() {},
    snapshot: () => ({ load: () => null, save() {} }),
    forget() {},
    terminals: () => ({
      load: () => notes,
      save(next: TerminalNotes) {
        notes = structuredClone(next)
        saved.push(notes)
      },
    }),
  }
  const build = () =>
    createCore({
      clock: time.clock,
      version: '9.9.9',
      log: (line) => logs.push(line),
      store,
      devices: [
        {
          id: 'local',
          name: '本机',
          host: 'dev@mac',
          kind: 'local',
          target: null,
          wire: 'green',
          open: peer.open,
        },
      ],
    })
  let core = build()

  const command = (name: string, params: object = {}) =>
    core.command(name, { deviceId: 'local', ...params }, never)

  /** 等连接层和假对端之间来回的消息送完 */
  const idle = async (rounds = 3) => {
    for (let at = 0; at < rounds; at++) await settle()
  }

  return {
    get core() {
      return core
    },
    fake,
    procs,
    peer,
    time,
    logs,
    saved,
    command,
    idle,
    /** 开始连接，等到认出对面、对完账 */
    async start() {
      core.start()
      await idle(6)
    },
    /** 开一个终端并等它起来。返回它的标识（一开始就是进程的句柄） */
    async open(workspaceId: string | null = 'w1', cwd?: string): Promise<string> {
      const result = (await command('terminal.open', {
        workspaceId,
        ...(cwd === undefined ? {} : { cwd }),
        rows: 24,
        cols: 80,
      })) as { terminalId: string }
      await idle()
      return result.terminalId
    },
    /** 对面收到过的某个方法的参数，按到达顺序。只看现在这条连接 */
    sent(method: string) {
      return peer
        .last()
        .seen.filter((entry) => entry.method === method)
        .map((entry) => entry.params as Record<string, unknown>)
    },
    /** 断线：对面这一头断开，属于这条连接的进程跟着没了 */
    async drop() {
      procs.dropped()
      peer.last().drop()
      await idle()
    },
    /** 等它自己连回来、对完账 */
    async back() {
      time.advance(60_000)
      await idle(6)
      // 挂回之后补来的输出和前面的记号挨得太近，要等合并输出的那一小会儿过去
      time.advance(8)
      await idle(1)
    },
    /** 只断不连：之后的重连都失败 */
    async disconnect() {
      procs.dropped()
      for (let at = 0; at < 20; at++) peer.failures.push(new Error('连不上'))
      peer.last().drop()
      await idle()
    },
    /** 应用重开：核心换一份新的，设备和这台电脑上记着的东西都还在 */
    async relaunch() {
      core.stop()
      procs.dropped()
      await idle()
      core = build()
      core.start()
      await idle(6)
    },
  }
}

export type TerminalWorld = ReturnType<typeof terminalWorld>

/** 订阅一台设备的终端列表，像界面那样落成一张表 */
export function watchTerminals(core: CoreHost, deviceId = 'local') {
  const state = {
    durable: null as boolean | null,
    terminals: new Map<string, TerminalInfo>(),
    ops: [] as TerminalsOp[],
  }
  const close = core.subscribe(
    { kind: 'terminals', deviceId },
    {
      snapshot(data) {
        const view = data as TerminalsView
        state.durable = view.durable
        state.terminals = new Map(view.terminals.map((entry) => [entry.id, entry]))
      },
      delta(ops) {
        for (const op of ops as TerminalsOp[]) {
          state.ops.push(op)
          if (op.op === 'terminal.upsert') state.terminals.set(op.terminal.id, op.terminal)
          else if (op.op === 'terminal.remove') state.terminals.delete(op.terminalId)
          else state.durable = op.durable
        }
      },
      error() {},
    },
  )
  return {
    state,
    close,
    get(id: string): TerminalInfo {
      const found = state.terminals.get(id)
      if (!found) throw new Error(`列表里没有这个终端：${id}`)
      return found
    },
    /** 开成标签的那些，按顺序 */
    shown: () =>
      [...state.terminals.values()]
        .filter((entry) => entry.shown)
        .sort((a, b) => a.order - b.order),
  }
}

/**
 * 订阅一个终端的输出，经真的通道。autoAck：收到就回报处理完了（界面跟得上）；
 * 关掉它就是界面一点都不处理，要测积压的时候用，之后自己调 ack()
 */
export function watchTerminal(
  core: CoreHost,
  terminalId: string,
  options: { autoAck?: boolean; have?: { epoch: number; offset: number }; deviceId?: string } = {},
) {
  const deviceId = options.deviceId ?? 'local'
  const frames = manualFrames()
  const [uiPort, corePort] = jsonPorts()
  serveChannel(corePort, core, { clock: frames.clock })
  const channel = connectChannel(uiPort)
  const state = {
    view: null as TerminalStreamView | null,
    snapshots: 0,
    epoch: 0,
    /** 处理到的偏移 */
    offset: 0,
    bytes: [] as Uint8Array[],
    marks: [] as { at: number; mark: TerminalMark }[],
    /** 每条输出增量的范围，按到达的先后 */
    ranges: [] as [number, number][],
    resets: 0,
    errors: [] as ChannelError[],
    autoAck: options.autoAck ?? true,
  }
  const ack = () => {
    if (!state.view) return
    void channel
      .command('terminal.ack', {
        deviceId,
        terminalId,
        viewer: state.view.viewer,
        epoch: state.epoch,
        offset: state.offset,
      })
      .catch(() => {})
  }
  const close = channel.subscribe(
    { kind: 'terminal', deviceId, terminalId, ...(options.have ? { have: options.have } : {}) },
    {
      snapshot(data) {
        state.view = data
        state.snapshots++
        state.epoch = data.epoch
        state.offset = data.from
      },
      delta(ops) {
        for (const op of ops) {
          if (op.op === 'output') {
            for (const chunk of op.chunks) state.bytes.push(decodeBase64(chunk))
            state.ranges.push([op.from, op.to])
            state.offset = op.to
          } else if (op.op === 'mark') {
            state.marks.push({ at: op.at, mark: op.mark })
            state.offset = op.at + op.mark.missed
          } else {
            state.resets++
            state.epoch = op.epoch
            state.offset = 0
            state.bytes = []
          }
        }
        if (state.autoAck) ack()
      },
      error: (error) => state.errors.push(error),
    },
  )
  const text = (): string => {
    const total = state.bytes.reduce((sum, piece) => sum + piece.length, 0)
    const joined = new Uint8Array(total)
    let at = 0
    for (const piece of state.bytes) {
      joined.set(piece, at)
      at += piece.length
    }
    return decodeUtf8(joined)
  }
  return {
    state,
    close,
    ack,
    /** 把排在通道里的这一帧发出来 */
    frame: () => frames.run(),
    /** 到现在为止收到的字 */
    get text() {
      frames.run()
      return text()
    },
    get received() {
      frames.run()
      return state.bytes.reduce((sum, piece) => sum + piece.length, 0)
    },
    get marks() {
      frames.run()
      return state.marks.map((entry) => entry.mark)
    },
    get view() {
      frames.run()
      return state.view
    },
    get errors() {
      frames.run()
      return state.errors
    },
  }
}
