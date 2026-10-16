// 一台设备上的终端会话：开、写、改大小、关、列出、断线之后挂回，都在这里。界面只发命令、订阅列表和输出。
//
// 终端有两种，看对面（设计文档 02 第 2.7 节，线上的规矩在 protocol/extensions/device-processes.json）：
// - 对面是设备服务而且声明了可重连终端（deviceProcesses）：终端属于设备。这边断线、退出应用，进程都还在；
//   连回来之后按句柄挂回去，从手里已有的偏移往后补。应用重新打开时，设备上活着的终端按进程上带的标记恢复成标签。
// - 别的对面（某个 harness 自己的入口、原生 codex、旧版的设备服务）：用协议原有的 process/*，
//   终端随连接结束。断线之后标签和内容留着，标成没了，可以在同一个标签里重开。
//
// 大量输出怎么办（一条不停输出的命令不能把界面卡死，也不能拖住同一条连接上的对话）：
// 1. 输出先进 terminal-stream.mts 的缓冲，合并之后按界面处理得过来的速度往外交，缓冲只留末尾一段；
// 2. 属于设备的终端，积压过了线就先解除挂接：设备不再往这条连接上发它的输出（进程照跑，设备自己留着末尾），
//    等界面追上了再按手里的偏移挂回去，设备把留着的补过来，补不上的那段在输出里留一个记号。
//    解除期间协议原有的写输入对它不生效，所以有输入要写的时候先挂回去，写完一小会儿之内不解除；
// 3. 随连接结束的终端没有挂接可解除：核心照收（连接不停读），缓冲里旧的被顶掉，界面少的那段同样留记号。
// 没人看的终端也照第 2 条办：没人消费的输出攒到线就解除，有人来看再挂。所以应用刚打开时不会把每个终端
// 留着的输出都取一遍，只取看着的那个。
import {
  type ClientRequestMethod,
  type ClientRequests,
  type DeviceProcessInfo,
  isUnknownMethodError,
  type ServerNotifications,
} from '../../../protocol/src/index.mjs'
import { ChannelError, type Clock } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import { RpcAbortError, RpcError, type RpcRequestOptions } from '../connection/rpc.mjs'
import type {
  TerminalHave,
  TerminalInfo,
  TerminalState,
  TerminalsAlive,
  TerminalsOp,
  TerminalsView,
} from '../model-terminal.mjs'
import { phrase } from '../phrase.mjs'
import { base64Bytes, dropBase64Head } from '../text/bytes.mjs'
import {
  launchCommand,
  makeTag,
  parseTag,
  randomHandle,
  TERMINAL_ENV,
  type TerminalNotes,
  type TerminalNotesStore,
  usableDir,
} from './terminal-launch.mjs'
import { type StreamLimits, TerminalStream } from './terminal-stream.mjs'

export interface TerminalsHost {
  deviceId: string
  clock: Clock
  online(): boolean
  /** 对面有没有可重连的终端：它是设备服务，而且设备信息的 extensions 里列了 deviceProcesses */
  durable(): boolean
  /** 对面的系统（macos、linux、windows）。还不知道就是 null */
  platform(): string | null
  /** 设备的主目录。只有设备服务会报；别的对面是 null，工作目录全在对面定 */
  home(): string | null
  /** 这个工作区还在不在 */
  hasWorkspace(workspaceId: string): boolean
  /** 工作区的根目录。不认识这个工作区就是 null */
  workspaceRoot(workspaceId: string): string | null
  /** 根目录是这个的工作区。没有就是 null */
  workspaceByRoot(root: string): string | null
  request<M extends ClientRequestMethod>(
    method: M,
    params: ClientRequests[M]['params'],
    options?: RpcRequestOptions,
  ): Promise<ClientRequests[M]['result']>
  /** 请求没做成：换成给人看的错误 */
  fail(error: unknown): ChannelError
  log(line: string): void
  /** 记在这台电脑上的：改过的名字、留在设备上不看的。不给就不记 */
  notes?: TerminalNotesStore
  /** 生成句柄用的随机数，测试里换成定好的 */
  random?(): number
  limits?: StreamLimits
}

export interface Terminals {
  /** 订阅这台设备的终端列表。先给快照，之后给增量；返回退订函数 */
  openList(sink: HostSink): () => void
  /** 订阅一个终端的输出。没有这个终端就抛 notFound */
  openStream(terminalId: string, have: TerminalHave | undefined, sink: HostSink): () => void
  /** 对面发来的通知是不是进程的。是就处理掉，返回 true */
  notification(method: string, params: unknown): boolean
  /** 连上并认出对面是谁了：把设备上活着的终端对一遍，该挂回的挂回 */
  resync(): void
  /** 连接断了 */
  offline(): void
  /** 工作区变了：终端归在哪一组可能跟着变 */
  regroup(): void
  open(workspaceId: string | null, cwd: string | null, rows: number, cols: number): Promise<string>
  write(terminalId: string, data: string): void
  resize(terminalId: string, rows: number, cols: number): void
  redraw(terminalId: string): void
  rename(terminalId: string, title: string): void
  close(terminalId: string, mode: 'end' | 'leave'): Promise<void>
  show(terminalId: string): void
  restart(terminalId: string, rows: number, cols: number): Promise<void>
  ack(terminalId: string, viewer: number, epoch: number, offset: number): void
  alive(): TerminalsAlive
  /** 把开成标签、属于设备、还在跑的终端都结束掉。退出应用时用户选了“结束”才调 */
  endAll(): Promise<void>
  /** 这台设备不要了：定时器都停掉 */
  dispose(): void
}

/** 没人消费的输出攒到这么多，就让设备先别往这条连接上发了 */
export const PARK_BYTES = 512 * 1024
/** 因为要写输入而挂回去之后，这么久之内不解除：免得刚敲完键又解除，下一个键又得等 */
const HOLD_MS = 1000
/** 挂回去之前攒着的输入最多这么多字节。再多就不收了 */
const INPUT_MAX = 1024 * 1024
/** 起进程要先在对面起伪终端的桥，给宽一点 */
const SPAWN_TIMEOUT_MS = 20_000
/** 退出应用时结束终端，最多等这么久 */
const END_TIMEOUT_MS = 3000

interface Size {
  rows: number
  cols: number
}

interface Term {
  id: string
  /** 现在这个进程的句柄。在同一个标签里重开会换一个 */
  handle: string
  /** 标记里记的工作区和它的根目录 */
  workspace: string | null
  root: string | null
  /** 上一次报给界面的归属：变了才重报 */
  group: string | null
  title: string | null
  seq: number
  order: number
  cwd: string | null
  state: TerminalState
  exitCode: number | null
  durable: boolean
  shown: boolean
  size: Size
  stream: TerminalStream
  /** 属于设备的终端：这条连接现在挂没挂着它 */
  link: 'attached' | 'parked' | 'attaching' | 'detaching'
  /** 手里的偏移是不是这个进程的。从设备上恢复的终端第一次挂上之前是 false */
  known: boolean
  /** 断过线：下次挂回去要在输出里说一声 */
  rejoining: boolean
  /**
   * 挂接的请求发出去之后、它的应答处理完之前到的输出和退出通知。
   * 设备先回应答、紧跟着就回放，两样可能在同一拍里到，而应答的后续要晚一步才跑：先留着，后续跑完再按原来的先后处理
   */
  early: (() => void)[]
  /** 挂回去之前攒着的输入，base64 */
  input: string[]
  inputBytes: number
  /** 这个时刻之前不解除挂接：刚写过输入 */
  holdUntil: number
  /** 界面要的行列数。和对面现在的不一样、又还没发出去的时候 dirty 为真 */
  want: Size
  dirty: boolean
  resizing: boolean
  /** 每次断线、重开换一个：在途的请求回来对不上就作废 */
  gen: number
}

const sizeOf = (rows: number, cols: number): Size => ({
  rows: Math.min(Math.max(Math.floor(rows) || 24, 1), 1000),
  cols: Math.min(Math.max(Math.floor(cols) || 80, 1), 1000),
})

const sameSize = (a: Size, b: Size): boolean => a.rows === b.rows && a.cols === b.cols

/** 设备说没有这个进程了，或者手里的偏移不是它的：这个终端在设备上已经不是原来那个了 */
function isGone(error: unknown): boolean {
  if (!(error instanceof RpcError)) return false
  const reason = (error.data as { litch?: unknown } | null | undefined)?.litch
  return reason === 'unknownProcess' || error.code === -32602
}

export function createTerminals(host: TerminalsHost): Terminals {
  const { clock } = host
  const terms = new Map<string, Term>()
  const byHandle = new Map<string, Term>()
  const sinks = new Set<HostSink>()
  /** 这台设备上新开的终端是不是属于设备的。null：还没连上过 */
  let durable: boolean | null = null
  /** 每次断开换一个代号，在途的列表请求回来对不上就作废 */
  let epoch = 0
  let lastOrder = 0
  const notes: TerminalNotes = host.notes?.load() ?? { titles: {}, hidden: [] }

  const saveNotes = () => {
    try {
      host.notes?.save({ titles: { ...notes.titles }, hidden: [...notes.hidden] })
    } catch (error) {
      host.log(`记终端的名字失败：${String(error)}`)
    }
  }

  const publish = (ops: TerminalsOp[]) => {
    for (const sink of sinks) sink.delta(ops)
  }

  /** 这个终端归在哪个工作区下：标记里的工作区还在就用它，不在了按根目录找，都没有就是设备主目录的那一组 */
  const groupOf = (term: Term): string | null => {
    if (term.workspace && host.hasWorkspace(term.workspace)) return term.workspace
    return term.root ? host.workspaceByRoot(term.root) : null
  }

  const infoOf = (term: Term): TerminalInfo => ({
    id: term.id,
    workspaceId: term.group,
    title: term.title,
    seq: term.seq,
    cwd: term.cwd ?? term.root ?? host.home(),
    state: term.state,
    exitCode: term.exitCode,
    durable: term.durable,
    shown: term.shown,
    rows: term.size.rows,
    cols: term.size.cols,
    order: term.order,
  })

  const announce = (term: Term) => {
    term.group = groupOf(term)
    publish([{ op: 'terminal.upsert', terminal: infoOf(term) }])
  }

  const find = (terminalId: string): Term => {
    const term = terms.get(terminalId)
    if (!term) throw new ChannelError('notFound', `没有这个终端：${terminalId}`)
    return term
  }

  const nextOrder = (): number => {
    lastOrder = Math.max(clock.now(), lastOrder + 1)
    return lastOrder
  }

  /** 这一组里没用过的最小序号 */
  const nextSeq = (group: string | null): number => {
    const used = new Set<number>()
    for (const term of terms.values()) if (term.group === group) used.add(term.seq)
    let seq = 1
    while (used.has(seq)) seq++
    return seq
  }

  const makeTerm = (fields: {
    handle: string
    workspace: string | null
    root: string | null
    title: string | null
    seq: number
    order: number
    cwd: string | null
    state: TerminalState
    durable: boolean
    shown: boolean
    size: Size
    /** 从设备上恢复的：偏移要等第一次挂上才知道 */
    restored: boolean
  }): Term => {
    const term: Term = {
      id: fields.handle,
      handle: fields.handle,
      workspace: fields.workspace,
      root: fields.root,
      group: null,
      title: fields.title,
      seq: fields.seq,
      order: fields.order,
      cwd: fields.cwd,
      state: fields.state,
      exitCode: null,
      durable: fields.durable,
      shown: fields.shown,
      size: fields.size,
      stream: new TerminalStream({
        clock,
        pending: fields.restored,
        changed: () => settle(term),
        ...(host.limits ? { limits: host.limits } : {}),
      }),
      link: fields.restored ? 'parked' : 'attached',
      known: !fields.restored,
      rejoining: false,
      early: [],
      input: [],
      inputBytes: 0,
      holdUntil: 0,
      want: fields.size,
      dirty: false,
      resizing: false,
      gen: 0,
    }
    term.group = groupOf(term)
    terms.set(term.id, term)
    byHandle.set(term.handle, term)
    lastOrder = Math.max(lastOrder, term.order)
    return term
  }

  const drop = (term: Term) => {
    term.gen++
    term.stream.dispose()
    terms.delete(term.id)
    if (byHandle.get(term.handle) === term) byHandle.delete(term.handle)
    const hadNote = term.handle in notes.titles || notes.hidden.includes(term.handle)
    delete notes.titles[term.handle]
    notes.hidden = notes.hidden.filter((handle) => handle !== term.handle)
    if (hadNote) saveNotes()
    publish([{ op: 'terminal.remove', terminalId: term.id }])
  }

  /** 按设备报的样子更新：在不在跑、退出码、行列数。有变化才告诉界面 */
  const absorb = (term: Term, process: DeviceProcessInfo) => {
    let changed = false
    if (term.state !== 'starting') {
      const state: TerminalState = process.running ? 'running' : 'exited'
      if (term.state !== state) {
        term.state = state
        changed = true
      }
    }
    const code = process.exit?.exitCode ?? null
    if (term.exitCode !== code) {
      term.exitCode = code
      changed = true
    }
    if (process.size) {
      const size = sizeOf(process.size.rows, process.size.cols)
      if (!sameSize(size, term.size)) {
        term.size = size
        changed = true
      }
    }
    if (changed) announce(term)
  }

  const send = (term: Term, data: string) => {
    host
      .request('process/writeStdin', { processHandle: term.handle, deltaBase64: data })
      .catch((error: unknown) => host.log(`往终端里写输入失败：${String(error)}`))
  }

  /** 把界面要的行列数告诉对面。同时只发一个；发的过程中又变了，发完再发一次 */
  const flushSize = (term: Term) => {
    if (!term.dirty || term.resizing || !host.online() || term.state !== 'running') return
    if (term.durable && term.link !== 'attached') return
    const size = term.want
    term.dirty = false
    if (sameSize(size, term.size)) return
    term.resizing = true
    const mine = term.gen
    host.request('process/resizePty', { processHandle: term.handle, size }).then(
      () => {
        if (mine !== term.gen) return
        term.resizing = false
        if (!sameSize(term.size, size)) {
          term.size = size
          announce(term)
        }
        flushSize(term)
      },
      (error: unknown) => {
        if (mine !== term.gen) return
        term.resizing = false
        host.log(`改终端的行列数失败：${String(error)}`)
      },
    )
  }

  /** 按手里的偏移挂回去：设备先把留着的补过来，再接着发新的 */
  const attach = async (term: Term) => {
    term.link = 'attaching'
    const mine = term.gen
    const fresh = !term.known
    try {
      const reply = await host.request('litch/process/attach', {
        processHandle: term.handle,
        ...(fresh ? {} : { fromOffset: term.stream.head }),
      })
      if (mine !== term.gen) return
      term.link = 'attached'
      if (fresh) {
        // 第一次挂上：从设备留着的最早那个字节开始。更早的不算“缺了”，本来就没见过
        term.known = true
        term.stream.begin(reply.replayFrom)
      } else if (term.rejoining) {
        term.stream.mark({
          kind: 'rejoined',
          missed: reply.missedBytes,
          replayed: reply.replayTo - reply.replayFrom,
        })
      } else if (reply.missedBytes > 0) {
        term.stream.mark({ kind: 'backlog', missed: reply.missedBytes })
      }
      term.rejoining = false
      for (const run of term.early.splice(0)) run()
      absorb(term, reply.process)
      const input = term.input
      term.input = []
      term.inputBytes = 0
      // 挂回来是为了写这些输入：写完一小会儿之内不解除
      if (input.length > 0) term.holdUntil = clock.now() + HOLD_MS
      for (const data of input) send(term, data)
      flushSize(term)
    } catch (error) {
      if (mine !== term.gen) return
      term.link = 'parked'
      term.early = []
      term.input = []
      term.inputBytes = 0
      if (isGone(error)) {
        term.state = 'lost'
        announce(term)
        return
      }
      host.log(`挂回终端 ${term.handle} 失败：${String(error)}`)
      return
    }
    settle(term)
  }

  /** 让设备先别往这条连接上发它的输出。进程照跑 */
  const detach = async (term: Term) => {
    term.link = 'detaching'
    const mine = term.gen
    try {
      await host.request('litch/process/detach', { processHandle: term.handle })
    } catch (error) {
      if (mine !== term.gen) return
      host.log(`解除终端 ${term.handle} 的挂接失败：${String(error)}`)
    }
    if (mine !== term.gen) return
    term.link = 'parked'
    settle(term)
  }

  /** 没人消费的输出攒够了，而且眼下没有输入要写：该让设备先别发了 */
  const overdue = (term: Term): boolean => {
    const busy = term.input.length > 0 || clock.now() < term.holdUntil
    return !busy && term.stream.lag() >= PARK_BYTES
  }

  /** 属于设备的终端：看一眼现在该挂着还是该解除。积压变了、有人来看或走了、有输入要写的时候都会来 */
  function settle(term: Term): void {
    if (!term.durable || !host.online()) return
    if (term.state !== 'running' && term.state !== 'exited') return
    if (term.link === 'attaching' || term.link === 'detaching') return
    if (term.link === 'attached') {
      if (overdue(term)) void detach(term)
      return
    }
    // 没挂着：有输入要写，或者有人在看而且已经把手上的处理完了，才挂回去
    const watched = term.shown && term.stream.viewers > 0 && (!term.known || term.stream.caughtUp())
    if (term.input.length > 0 || watched) void attach(term)
  }

  const output = (note: ServerNotifications['process/outputDelta']) => {
    const term = byHandle.get(note.processHandle)
    if (!term || typeof note.deltaBase64 !== 'string') return
    if (term.durable && term.link === 'attaching') {
      term.early.push(() => output(note))
      return
    }
    let data = note.deltaBase64
    let bytes = base64Bytes(data)
    const at = note.litchDevice?.offset
    if (!term.durable || typeof at !== 'number') {
      // 随连接结束的终端：对面不报偏移，自己数
      term.stream.push(data, bytes)
      return
    }
    // 没挂着的时候到的不要：挂回去时按偏移补，要了反而对不上。
    // 正在解除的时候到的也不要：设备上留着，挂回去时从手里的位置接着补；收下来只会把界面还没拿走的顶掉
    if (!term.known || term.link !== 'attached') return
    const head = term.stream.head
    if (at < head) {
      // 和手里的有重叠：只要后面没见过的那一截
      const overlap = head - at
      if (overlap >= bytes) return
      data = dropBase64Head(data, overlap)
      bytes -= overlap
    } else if (at > head) {
      term.stream.mark({ kind: 'backlog', missed: at - head })
    }
    term.stream.push(data, bytes)
    // 积压到了量就当场解除，不等下一次合并交付：补回来的输出是一口气涌过来的，等那一小会儿缓冲就被顶穿了。
    // （收下这一块的时候可能正好赶上一次交付，那边已经解除过了）
    if (term.link === 'attached' && overdue(term)) void detach(term)
  }

  const exited = (note: ServerNotifications['process/exited']) => {
    const term = byHandle.get(note.processHandle)
    if (!term) return
    if (term.durable && term.link === 'attaching') {
      term.early.push(() => exited(note))
      return
    }
    const total = note.litchDevice?.offset
    // 正在解除的时候不算在听：那期间到的输出没收，剩下的等挂回去再补，不能当成丢了
    const listening = term.known && term.link === 'attached'
    if (term.durable && typeof total === 'number' && listening && total > term.stream.head) {
      // 进程一共输出了这么多，而手里的不到：最后那一截设备没发过来
      term.stream.mark({ kind: 'backlog', missed: total - term.stream.head })
    }
    if (term.state === 'exited' && term.exitCode === note.exitCode) return
    term.state = 'exited'
    term.exitCode = typeof note.exitCode === 'number' ? note.exitCode : null
    announce(term)
  }

  /** 设备上有一个我们没记着的终端：收进来。不是终端（标记不是我们的）就不管 */
  const adopt = (process: DeviceProcessInfo): Term | null => {
    const tag = parseTag(process.tag)
    if (!tag || !process.tty) return null
    const handle = process.processHandle
    const term = makeTerm({
      handle,
      workspace: tag.workspace,
      root: tag.root,
      title: notes.titles[handle] ?? tag.title,
      seq: tag.seq,
      order: tag.order || process.startedAt * 1000,
      cwd: tag.cwd,
      state: process.running ? 'running' : 'exited',
      durable: true,
      shown: !notes.hidden.includes(handle),
      size: process.size ? sizeOf(process.size.rows, process.size.cols) : sizeOf(24, 80),
      restored: true,
    })
    term.exitCode = process.exit?.exitCode ?? null
    announce(term)
    return term
  }

  const changed = (note: ServerNotifications['litch/process/changed']) => {
    const term = byHandle.get(note.processHandle)
    if (note.change === 'removed') {
      // 记录没了：别处把它结束了，或者退出之后留到期了。标签跟着没
      if (term) drop(term)
      return
    }
    if (!note.process) return
    if (!term) {
      // 只认“新起了一个”：别的变化要是也收，刚关掉的终端会被它后面跟来的通知带回来
      if (note.change === 'started') adopt(note.process)
      return
    }
    if (term.durable) absorb(term, note.process)
  }

  /** 没起来的原因换成给人看的 */
  const spawnFailure = (error: unknown): ChannelError => {
    if (error instanceof RpcError) {
      const data = error.data as { litch?: unknown; limit?: unknown } | null | undefined
      if (data?.litch === 'processLimitReached') {
        const limit = typeof data.limit === 'number' ? data.limit : 0
        return new ChannelError('rejected', error.message, phrase('terminal.limit', { limit }))
      }
      // 对面不会起进程。-32600 同时也是别的错的码，所以原话里要点到“不认识”才算
      if (
        data?.litch === undefined &&
        isUnknownMethodError(error.code) &&
        /unknown variant|method not found/i.test(error.message)
      ) {
        return new ChannelError('unsupported', error.message, phrase('terminal.unsupported'))
      }
    }
    return host.fail(error)
  }

  /** 在对面把进程起起来。属于设备还是随连接结束，看对面收没收下那个扩展参数 */
  const launch = async (term: Term) => {
    const mine = term.gen
    // 起的时候用的是这一刻要的大小。起的过程中界面可能又改了（量准了字宽、面板被拖了），那一次攒在 want 里
    const asked = term.want
    const result = await host.request(
      'process/spawn',
      {
        command: launchCommand([term.cwd, term.root]),
        processHandle: term.handle,
        // 这里只要一个肯定在的目录：真正去哪由启动脚本在对面一个个试
        cwd: host.home() ?? '/',
        tty: true,
        size: asked,
        env: TERMINAL_ENV,
        // 不给这两个 null 的话，协议默认 10 秒后结束进程、每路输出到 1 MiB 就不再读
        timeoutMs: null,
        outputBytesCap: null,
        // 对面没声明这项扩展时连参数都不带
        ...(term.durable
          ? {
              litchDevice: {
                tag: makeTag({
                  workspace: term.workspace,
                  root: term.root,
                  title: term.title,
                  seq: term.seq,
                  order: term.order,
                  cwd: term.cwd,
                }),
              },
            }
          : {}),
      },
      { timeoutMs: SPAWN_TIMEOUT_MS },
    )
    if (mine !== term.gen) return
    const started = result?.litchDevice
    // 应答里没有它，说明那个参数没生效：这个进程属于这条连接
    term.durable = started !== undefined
    term.link = 'attached'
    term.state = 'running'
    term.size = started?.size ? sizeOf(started.size.rows, started.size.cols) : asked
    announce(term)
    // 起的过程中改过大小的：那时候发不了，现在补发。不补的话对面的伪终端一直是起的时候估的那个大小，
    // 界面却以为已经告诉过了，全屏的程序（less、vim）就按错的行数画
    flushSize(term)
  }

  const offlineError = () => new ChannelError('offline', '设备没有连上')

  return {
    openList(sink) {
      const view: TerminalsView = {
        deviceId: host.deviceId,
        durable,
        terminals: [...terms.values()].map(infoOf),
      }
      sink.snapshot(view)
      sinks.add(sink)
      return () => {
        sinks.delete(sink)
      }
    },

    openStream(terminalId, have, sink) {
      return find(terminalId).stream.attach(sink, have)
    },

    notification(method, params) {
      if (method === 'process/outputDelta') {
        output(params as ServerNotifications['process/outputDelta'])
      } else if (method === 'process/exited') {
        exited(params as ServerNotifications['process/exited'])
      } else if (method === 'litch/process/changed') {
        changed(params as ServerNotifications['litch/process/changed'])
      } else return false
      return true
    },

    resync() {
      const mine = epoch
      const now = host.durable()
      if (durable !== now) {
        durable = now
        publish([{ op: 'terminals.durable', durable }])
      }
      if (!now) {
        // 对面现在没有可重连的终端：之前属于设备的那些接不回来了
        for (const term of terms.values()) {
          if (!term.durable || term.state === 'lost' || term.state === 'exited') continue
          term.state = 'lost'
          announce(term)
        }
        return
      }
      void (async () => {
        try {
          const { data } = await host.request('litch/process/list', {})
          if (mine !== epoch) return
          const seen = new Set<string>()
          for (const process of data) {
            seen.add(process.processHandle)
            const term = byHandle.get(process.processHandle)
            if (!term) adopt(process)
            else if (term.durable) {
              absorb(term, process)
              settle(term)
            }
          }
          // 手里记着、设备上却没有了的：设备服务重启过，或者记录被清掉了
          for (const term of [...terms.values()]) {
            if (!term.durable || seen.has(term.handle)) continue
            if (term.state === 'lost' || term.state === 'starting') continue
            term.state = 'lost'
            announce(term)
          }
          // 名字和“不看了”的记录里，设备上已经没有的清掉
          const before = notes.hidden.length + Object.keys(notes.titles).length
          notes.hidden = notes.hidden.filter((handle) => seen.has(handle))
          for (const handle of Object.keys(notes.titles)) {
            if (!seen.has(handle)) delete notes.titles[handle]
          }
          if (notes.hidden.length + Object.keys(notes.titles).length !== before) saveNotes()
        } catch (error) {
          if (mine !== epoch) return
          host.log(`取设备上的终端失败：${String(error)}`)
        }
      })()
    },

    offline() {
      epoch++
      for (const term of terms.values()) {
        term.gen++
        term.link = 'parked'
        term.early = []
        term.input = []
        term.inputBytes = 0
        term.holdUntil = 0
        // 发到一半的改行列数不知道成没成：挂回去之后再对一遍
        if (term.resizing) term.dirty = true
        term.resizing = false
        const live = term.state === 'running' || term.state === 'starting'
        if (term.durable && term.known) term.rejoining = true
        if (!live) continue
        // 属于设备的还在设备上跑着；随连接结束的这一下就没了
        term.state = term.durable ? 'away' : 'lost'
        announce(term)
      }
    },

    regroup() {
      for (const term of terms.values()) {
        if (groupOf(term) !== term.group) announce(term)
      }
    },

    async open(workspaceId, cwd, rows, cols) {
      if (!host.online()) throw offlineError()
      if (host.platform() === 'windows') {
        throw new ChannelError(
          'unsupported',
          'Windows 设备上还开不了终端',
          phrase('terminal.windows'),
        )
      }
      const group = workspaceId && host.hasWorkspace(workspaceId) ? workspaceId : null
      const term = makeTerm({
        handle: randomHandle(host.random),
        workspace: group,
        root: group ? host.workspaceRoot(group) : null,
        title: null,
        seq: nextSeq(group),
        order: nextOrder(),
        cwd: usableDir(cwd),
        state: 'starting',
        durable: host.durable(),
        shown: true,
        size: sizeOf(rows, cols),
        restored: false,
      })
      announce(term)
      try {
        await launch(term)
      } catch (error) {
        if (terms.get(term.id) === term) drop(term)
        throw spawnFailure(error)
      }
      return term.id
    },

    write(terminalId, data) {
      const term = find(terminalId)
      if (typeof data !== 'string' || data.length === 0) return
      if (!host.online()) throw offlineError()
      if (term.state !== 'running') {
        throw new ChannelError('rejected', '这个终端不在运行', phrase('terminal.notRunning'))
      }
      term.holdUntil = clock.now() + HOLD_MS
      if (!term.durable || term.link === 'attached') {
        send(term, data)
        return
      }
      // 没挂着的时候协议原有的写输入落不到它上面：先攒着，挂回去之后按先后写
      const bytes = base64Bytes(data)
      if (term.inputBytes + bytes > INPUT_MAX) {
        throw new ChannelError('rejected', '终端还没接回来，攒着的输入太多了')
      }
      term.input.push(data)
      term.inputBytes += bytes
      settle(term)
    },

    resize(terminalId, rows, cols) {
      const term = find(terminalId)
      term.want = sizeOf(rows, cols)
      term.dirty = true
      flushSize(term)
    },

    redraw(terminalId) {
      const term = find(terminalId)
      if (!host.online() || term.state !== 'running') return
      if (term.durable && term.link !== 'attached') return
      // 行列数没变的话程序收不到“窗口变了”的信号：先差一行，再改回来
      const size = term.size
      const nudged = sizeOf(size.rows > 1 ? size.rows - 1 : size.rows + 1, size.cols)
      const mine = term.gen
      const handle = term.handle
      host
        .request('process/resizePty', { processHandle: handle, size: nudged })
        .then(() => {
          if (mine !== term.gen) return undefined
          return host.request('process/resizePty', { processHandle: handle, size })
        })
        .catch((error: unknown) => host.log(`让终端重画失败：${String(error)}`))
    },

    rename(terminalId, title) {
      const term = find(terminalId)
      const name = typeof title === 'string' ? title.trim().slice(0, 120) : ''
      term.title = name || null
      // 设备上的标记改不了，名字记在这台电脑上
      if (term.durable) {
        if (name) notes.titles[term.handle] = name
        else delete notes.titles[term.handle]
        saveNotes()
      }
      announce(term)
    },

    async close(terminalId, mode) {
      const term = find(terminalId)
      if (mode === 'leave') {
        if (!term.durable || (term.state !== 'running' && term.state !== 'away')) {
          throw new ChannelError('rejected', '这个终端留不住：它不属于设备，或者已经结束了')
        }
        term.shown = false
        if (!notes.hidden.includes(term.handle)) notes.hidden.push(term.handle)
        saveNotes()
        announce(term)
        if (host.online() && term.link === 'attached') void detach(term)
        return
      }
      const live = term.state === 'running' || term.state === 'starting' || term.state === 'away'
      if (live) {
        // 设备没连着的时候结束不了它：不关标签，免得人以为它已经停了
        if (!host.online()) {
          throw new ChannelError(
            'offline',
            '设备没有连上，结束不了这个终端',
            phrase('terminal.endOffline'),
          )
        }
        try {
          if (term.durable) {
            await host.request('litch/process/kill', { processHandle: term.handle, remove: true })
          } else {
            await host.request('process/kill', { processHandle: term.handle })
          }
        } catch (error) {
          // 对面说没有这个进程：它已经自己结束了，目的达到了。连接上的问题才算没结束成
          if (error instanceof RpcAbortError) throw host.fail(error)
          if (!(error instanceof RpcError)) throw host.fail(error)
        }
      } else if (term.state === 'exited' && term.durable && host.online()) {
        // 退出之后设备上还留着它的记录：一起清掉
        host.request('litch/process/remove', { processHandle: term.handle }).catch(() => {})
      }
      if (terms.get(term.id) === term) drop(term)
    },

    show(terminalId) {
      const term = find(terminalId)
      if (term.shown) return
      term.shown = true
      notes.hidden = notes.hidden.filter((handle) => handle !== term.handle)
      saveNotes()
      announce(term)
      settle(term)
    },

    async restart(terminalId, rows, cols) {
      const term = find(terminalId)
      if (term.state !== 'exited' && term.state !== 'lost') {
        throw new ChannelError('rejected', '这个终端还在运行')
      }
      if (!host.online()) throw offlineError()
      const before = term.handle
      if (term.durable && term.state === 'exited') {
        host.request('litch/process/remove', { processHandle: before }).catch(() => {})
      }
      // 换一个句柄：用过的句柄在设备上要等记录清掉才能再用
      if (byHandle.get(before) === term) byHandle.delete(before)
      term.handle = randomHandle(host.random)
      byHandle.set(term.handle, term)
      const named = notes.titles[before]
      delete notes.titles[before]
      term.gen++
      term.stream.reset()
      term.durable = host.durable()
      if (named !== undefined) {
        if (term.durable) notes.titles[term.handle] = named
        saveNotes()
      }
      term.known = true
      term.rejoining = false
      term.link = 'attached'
      term.early = []
      term.input = []
      term.inputBytes = 0
      term.resizing = false
      term.dirty = false
      term.want = sizeOf(rows, cols)
      term.size = term.want
      term.state = 'starting'
      term.exitCode = null
      announce(term)
      try {
        await launch(term)
      } catch (error) {
        if (terms.get(term.id) === term) {
          term.state = 'lost'
          announce(term)
        }
        throw spawnFailure(error)
      }
    },

    ack(terminalId, viewer, epoch, offset) {
      terms.get(terminalId)?.stream.ack(viewer, epoch, offset)
    },

    alive() {
      const count: TerminalsAlive = { durable: 0, ephemeral: 0 }
      for (const term of terms.values()) {
        if (term.state !== 'running') continue
        if (!term.durable) count.ephemeral++
        // 已经说了“留在设备上”的那些不再问
        else if (term.shown) count.durable++
      }
      return count
    },

    async endAll() {
      if (!host.online()) return
      const doomed = [...terms.values()].filter(
        (term) => term.durable && term.shown && term.state === 'running',
      )
      await Promise.all(
        doomed.map((term) =>
          host
            .request(
              'litch/process/kill',
              { processHandle: term.handle, remove: true },
              { timeoutMs: END_TIMEOUT_MS },
            )
            .then(
              () => {
                if (terms.get(term.id) === term) drop(term)
              },
              (error: unknown) => host.log(`结束终端 ${term.handle} 失败：${String(error)}`),
            ),
        ),
      )
    },

    dispose() {
      for (const term of terms.values()) term.stream.dispose()
      terms.clear()
      byHandle.clear()
      sinks.clear()
    },
  }
}
