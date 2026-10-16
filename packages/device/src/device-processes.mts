// 属于设备的进程（协议扩展 deviceProcesses，设计文档 03 第 6.3 节）：可重连的终端。
// 协议原本的进程属于发起它的连接，连接一断就结束。`process/spawn` 带了扩展参数的进程归这里管：
// 连接断了它接着跑，末尾一段输出留在缓冲里，别的连接（或者重连之后的同一个客户端）按句柄挂回去，
// 先回放留着的，再接着收新的。
//
// 进程本身还是 packages/shared 里那一份实现起的（伪终端的桥、结束、退出码都一样），只是登记在一个
// 不对应任何连接的名下，输出和退出不直接发给谁，先交到这里。
import { EXTENSION } from '../../protocol/src/device.mjs'
import {
  DEVICE_PROCESS_CHANGED,
  DEVICE_PROCESS_ERROR_CODE,
  DEVICE_PROCESS_FIELD,
  DEVICE_PROCESS_TAG_MAX_BYTES,
  type DeviceProcessAttachResponse,
  type DeviceProcessChangedNotification,
  type DeviceProcessErrorData,
  type DeviceProcessErrorReason,
  type DeviceProcessExitMark,
  type DeviceProcessInfo,
  type DeviceProcessListResponse,
  type DeviceProcessOutputMark,
  type DeviceProcessSize,
  type DeviceProcessSpawnResponse,
  type DeviceProcessTag,
} from '../../protocol/src/device-processes.mjs'
import {
  DEFAULT_SIZE,
  type ProcessExit,
  type ProcessRpc,
  type ProcessSink,
} from '../../shared/src/process-rpc.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import type { RpcPeer } from '../../shared/src/types.mjs'
import { nowSeconds } from '../../shared/src/util.mjs'
import type { ConnectionFlow } from './flow.mjs'
import { OutputRing, type OutputStream } from './output-ring.mjs'
import { isObject } from './wire.mjs'

export interface ProcessLimits {
  /** 每个进程留多少输出，字节 */
  bufferBytes: number
  /** 设备上同时最多几个这类进程在跑 */
  maxProcesses: number
  /** 没有连接挂着的进程留多久，毫秒；到点结束它。0 是不过期 */
  idleTimeoutMs: number
  /** 进程退出之后，它的记录（退出状态和末尾的输出）留多久，毫秒 */
  exitedRetentionMs: number
}

/**
 * 没有谁给的时候用的值。适配器主进程管着时用的是它那边设置的现行值（启动参数带一份，之后经控制通道推），
 * 它的默认值和这里写的是同一组数（cmd/codex-harness-adapter/settings_processes.go），端到端测试守着两边一致。
 */
export const DEFAULT_PROCESS_LIMITS: ProcessLimits = {
  bufferBytes: 2 * 1024 * 1024,
  maxProcesses: 32,
  idleTimeoutMs: 0,
  exitedRetentionMs: 10 * 60 * 1000,
}

/** 设备上的进程眼里的一条连接 */
export interface ProcessAudience {
  /** 连接的标识 */
  id: string
  /** 这条连接的流量控制：输出经它发，堵没堵着问它 */
  flow: ConnectionFlow
}

export interface DeviceProcessesHost {
  /** 起进程用的那一份实现，和连接自己的进程共用 */
  rpc: ProcessRpc
  /** 一开始的上限和期限。之后可以用 setLimits 换 */
  limits: ProcessLimits
  /** 发给所有握手时声明过这个扩展的连接 */
  announce(method: string, params: unknown, extension: string): void
  log(line: string): void
}

/** 这个扩展自己回的错误：原因在 `error.data.litch` */
export class DeviceProcessError extends Error {
  readonly code: number
  readonly data: DeviceProcessErrorData

  constructor(
    reason: DeviceProcessErrorReason,
    message: string,
    detail: Omit<DeviceProcessErrorData, 'litch'> = {},
  ) {
    super(message)
    this.code = DEVICE_PROCESS_ERROR_CODE[reason]
    this.data = { litch: reason, ...detail }
  }
}

/** 这个扩展自己的方法都在这个前缀下，由设备层处理，不转给任何运行时 */
export const DEVICE_PROCESS_PREFIX = 'litch/process/'

/** 这些进程登记在这个名下。不是任何连接的标识（连接的标识是 UUID） */
const OWNER = 'litch:device-processes'

/**
 * 伪终端的输出很碎（一次往往只有一两千字节），发之前在这么短的窗口里并一并。
 * 歇了一阵之后来的第一块不等，立刻发：敲一个键的回显不因为它变慢。
 */
const COALESCE_MS = 2

/** 一帧 `process/outputDelta` 最多带这么多字节 */
const FRAME_BYTES = 64 * 1024

/** 一条连接挂在一个进程上 */
interface Attachment {
  audience: ProcessAudience
  /** 发到哪了：这个偏移之前的已经交给这条连接 */
  cursor: number
  /** 这个偏移之前的算回放 */
  replayUntil: number
  /** 落后太多、已经不在缓冲里的字节数，下一帧上告诉它 */
  missed: number
  /** 挂接的应答发出去之后才开始给它发 */
  live: boolean
  exitedSent: boolean
  /** 不再听这条连接“通了” */
  undrain: () => void
}

interface Entry {
  handle: string
  command: string[]
  cwd: string
  tty: boolean
  size: DeviceProcessSize | null
  tag: DeviceProcessTag
  startedAt: number
  /** starting：还没起来，占着句柄和名额，对外看不见 */
  state: 'starting' | 'running' | 'exited'
  exit: { exitCode: number; exitedAt: number } | null
  /** 退出通知的内容，进程退出时由底下的实现交来 */
  exited: ProcessExit | null
  /** 第几个退出的 */
  exitOrder: number
  ring: OutputRing
  /** 键是连接的标识 */
  attachments: Map<string, Attachment>
  /** 现在是不是按着不读它的输出 */
  held: boolean
  /** 退出之后不留记录 */
  discard: boolean
  lastPump: number
  pumpTimer: NodeJS.Timeout | null
  idleTimer: NodeJS.Timeout | null
  retentionTimer: NodeJS.Timeout | null
}

const handleOf = (fields: Record<string, unknown>): string => {
  const handle = fields.processHandle
  if (typeof handle !== 'string') throw new ProtocolError(-32602, 'processHandle 必须是字符串')
  return handle
}

export class DeviceProcesses {
  private readonly host: DeviceProcessesHost
  private readonly entries = new Map<string, Entry>()
  private readonly owner: RpcPeer = { id: OWNER, send: () => {}, close: () => {} }
  /** 现行的上限和期限 */
  private limits: ProcessLimits
  private exits = 0
  private closed = false

  constructor(host: DeviceProcessesHost) {
    this.host = host
    this.limits = { ...host.limits }
  }

  /**
   * 换上新的上限和期限（设置改了，适配器主进程经控制通道推过来）。不为这个重启设备进程——那样正在跑的终端
   * 和所有连接都没了——当场换，而且只管之后的事，不去动已经在跑的进程：
   * - 缓冲的大小：之后新起的进程按新的，已经在跑的照原来的；
   * - 数量上限：之后起进程时按新的查，调小了也不结束已经在跑的；
   * - 退出后的记录留多久：之后退出的进程按新的，已经留着的记录照原来的期限；
   * - 没人挂着留多久：这时没人挂着的进程从现在起按新的期限重新计（改成 0 就是不再计）。
   * 不成样子的值（不是非负整数）不收，那一项保持原样。
   */
  setLimits(next: Partial<ProcessLimits>): void {
    const before = this.limits
    const merged = { ...before }
    for (const key of Object.keys(before) as (keyof ProcessLimits)[]) {
      const value = next[key]
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
        merged[key] = value
    }
    const changed = (Object.keys(before) as (keyof ProcessLimits)[]).filter(
      (key) => merged[key] !== before[key],
    )
    if (changed.length === 0) return
    this.limits = merged
    this.host.log(
      `属于设备的进程的上限和期限换了：${changed.map((key) => `${key} ${before[key]} → ${merged[key]}`).join('，')}`,
    )
    if (!changed.includes('idleTimeoutMs')) return
    for (const entry of this.entries.values()) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer)
      entry.idleTimer = null
      if (entry.attachments.size === 0) this.idle(entry)
    }
  }

  /** 这条连接是不是挂着这个句柄的进程：标准的 process/* 方法按这个决定落到哪一边 */
  attached(connectionId: string, handle: unknown): boolean {
    if (typeof handle !== 'string') return false
    return this.entries.get(handle)?.attachments.has(connectionId) ?? false
  }

  /** 现在在跑（包括正在起）的有几个 */
  get running(): number {
    let count = 0
    for (const entry of this.entries.values()) if (entry.state !== 'exited') count++
    return count
  }

  /** `process/spawn` 带了扩展参数：起一个属于设备的进程，发起的这条连接顺带挂上 */
  async spawn(
    audience: ProcessAudience,
    fields: Record<string, unknown>,
    option: unknown,
  ): Promise<DeviceProcessSpawnResponse> {
    const tag = tagOf(option)
    const handle = handleOf(fields)
    // 和底下的实现报的一样
    if (!handle) throw new ProtocolError(-32600, 'processHandle must not be empty')
    if (this.entries.has(handle))
      throw new DeviceProcessError(
        'processHandleInUse',
        `设备上已经有一个句柄是 ${JSON.stringify(handle)} 的进程（还在跑，或者退出后的记录还留着）`,
        { processHandle: handle },
      )
    // 这条连接自己名下有同名的进程：对它来说这个句柄已经在用，和协议原有的重复句柄一样报
    if (this.host.rpc.has(audience.id, 'process', handle))
      throw new ProtocolError(-32600, `duplicate active process handle: ${JSON.stringify(handle)}`)
    const { maxProcesses } = this.limits
    if (this.running >= maxProcesses)
      throw new DeviceProcessError(
        'processLimitReached',
        `设备上属于设备的进程已经有 ${maxProcesses} 个在跑，到上限了。先结束几个再开`,
        { processHandle: handle, limit: maxProcesses },
      )
    const entry: Entry = {
      handle,
      command: [],
      cwd: '',
      tty: false,
      size: null,
      tag,
      startedAt: nowSeconds(),
      state: 'starting',
      exit: null,
      exited: null,
      exitOrder: 0,
      ring: new OutputRing(this.limits.bufferBytes),
      attachments: new Map(),
      held: false,
      discard: false,
      lastPump: 0,
      pumpTimer: null,
      idleTimer: null,
      retentionTimer: null,
    }
    this.entries.set(handle, entry)
    const sink: ProcessSink = {
      output: (stream, chunk, capReached) => this.output(entry, stream, chunk, capReached),
      exited: (exit) => {
        entry.exited = exit
        if (entry.state === 'running') this.finish(entry)
      },
    }
    try {
      // 属于设备的进程一律流式输出：留着的输出和回放靠的就是它
      await this.host.rpc.start(
        this.owner,
        'process',
        { ...fields, streamStdoutStderr: true },
        sink,
      )
    } catch (error) {
      if (this.entries.get(handle) === entry) this.entries.delete(handle)
      throw error
    }
    // 到这里参数已经由底下的实现验过了
    entry.command = [...(fields.command as string[])]
    entry.cwd = fields.cwd as string
    entry.tty = fields.tty === true
    entry.size = entry.tty ? sizeOf(fields.size) : null
    entry.state = 'running'
    // 等起进程的这一会儿设备进程在关、或者发起的连接断了：进程照样算起来了，只是没人挂着
    if (this.closed) return { litchDevice: this.info(entry) }
    if (audience.flow.open) this.join(entry, audience, 0, 0)
    else this.idle(entry)
    this.changed(entry, 'started')
    if (entry.exited) this.finish(entry)
    return { litchDevice: this.info(entry) }
  }

  list(): DeviceProcessListResponse {
    // 登记的先后就是启动的先后
    const data: DeviceProcessInfo[] = []
    for (const entry of this.entries.values())
      if (entry.state !== 'starting') data.push(this.info(entry))
    return { data }
  }

  /** 按句柄挂接。已经挂着的再调一次，是从新给的位置重新回放 */
  attach(audience: ProcessAudience, fields: Record<string, unknown>): DeviceProcessAttachResponse {
    const entry = this.find(handleOf(fields))
    // 这条连接自己名下有同名的进程：挂上之后同一个句柄指两个进程，分不清
    if (this.host.rpc.has(audience.id, 'process', entry.handle))
      throw new ProtocolError(
        -32600,
        `duplicate active process handle: ${JSON.stringify(entry.handle)}`,
      )
    const { ring } = entry
    const wanted = offsetOf(fields.fromOffset)
    if (wanted !== null && wanted > ring.to)
      throw new ProtocolError(
        -32602,
        `fromOffset 超出了这个进程已有的输出（一共 ${ring.to} 字节）：手里的位置不是这个进程的`,
      )
    const replayFrom = Math.max(wanted ?? ring.from, ring.from)
    const fresh = !entry.attachments.has(audience.id)
    this.join(entry, audience, replayFrom, ring.to)
    if (fresh) this.changed(entry, 'updated')
    return {
      process: this.info(entry),
      replayFrom,
      replayTo: ring.to,
      missedBytes: replayFrom - (wanted ?? 0),
    }
  }

  /** 解除挂接，不结束进程 */
  detach(connectionId: string, fields: Record<string, unknown>): Record<string, never> {
    const entry = this.find(handleOf(fields))
    if (this.leave(entry, connectionId)) this.left(entry)
    return {}
  }

  /** 按句柄结束，不要求挂着。已经退出的算成功 */
  kill(fields: Record<string, unknown>): Record<string, never> {
    const entry = this.find(handleOf(fields))
    const remove = fields.remove ?? false
    if (typeof remove !== 'boolean') throw new ProtocolError(-32602, 'remove 必须是布尔值')
    if (entry.state === 'exited') {
      if (remove) this.drop(entry)
      return {}
    }
    if (remove) entry.discard = true
    this.terminate(entry)
    return {}
  }

  /** 把已经退出的那条记录清掉 */
  remove(fields: Record<string, unknown>): Record<string, never> {
    const entry = this.find(handleOf(fields))
    if (entry.state !== 'exited')
      throw new DeviceProcessError(
        'processRunning',
        `进程 ${JSON.stringify(entry.handle)} 还在跑，先结束它`,
        { processHandle: entry.handle },
      )
    this.drop(entry)
    return {}
  }

  /** 标准的 process/writeStdin 落在挂着的设备进程上：谁挂着谁都能写 */
  write(fields: Record<string, unknown>): Promise<unknown> {
    return this.host.rpc.followup(this.owner, 'process', 'write', fields)
  }

  /** 标准的 process/resizePty 落在挂着的设备进程上：几条连接都改的话，以最后一次为准 */
  async resize(fields: Record<string, unknown>): Promise<unknown> {
    const result = await this.host.rpc.followup(this.owner, 'process', 'resize', fields)
    const entry = this.entries.get(handleOf(fields))
    const size = sizeOf(fields.size)
    if (entry?.size && (entry.size.rows !== size.rows || entry.size.cols !== size.cols)) {
      entry.size = size
      // 别的窗口里挂着同一个终端的，要知道现在是多大
      this.changed(entry, 'updated')
    }
    return result
  }

  /** 标准的 process/kill 落在挂着的设备进程上 */
  killAttached(fields: Record<string, unknown>): Promise<unknown> {
    return this.host.rpc.followup(this.owner, 'process', 'kill', fields)
  }

  /** 一条连接断了：它挂着的都解除，进程不动 */
  closeConnection(connectionId: string): void {
    for (const entry of [...this.entries.values()])
      if (this.leave(entry, connectionId)) this.left(entry)
  }

  /** 设备进程要退出了。进程本身由底下那一份实现一并结束，这里只把定时器收掉 */
  close(): void {
    this.closed = true
    for (const entry of this.entries.values()) {
      this.clearTimers(entry)
      for (const attachment of entry.attachments.values()) attachment.undrain()
      entry.attachments.clear()
    }
  }

  // ---------- 一个进程的记录 ----------

  private find(handle: string): Entry {
    const entry = this.entries.get(handle)
    if (!entry || entry.state === 'starting')
      throw new DeviceProcessError(
        'unknownProcess',
        `设备上没有句柄是 ${JSON.stringify(handle)} 的属于设备的进程`,
        { processHandle: handle },
      )
    return entry
  }

  private info(entry: Entry): DeviceProcessInfo {
    return {
      processHandle: entry.handle,
      command: entry.command,
      cwd: entry.cwd,
      tty: entry.tty,
      size: entry.size,
      startedAt: entry.startedAt,
      running: entry.state !== 'exited',
      exit: entry.exit,
      attached: entry.attachments.size,
      tag: entry.tag,
      retained: { from: entry.ring.from, to: entry.ring.to },
    }
  }

  private changed(entry: Entry, change: DeviceProcessChangedNotification['change']): void {
    if (this.closed) return
    const params: DeviceProcessChangedNotification = {
      processHandle: entry.handle,
      change,
      process: change === 'removed' ? null : this.info(entry),
    }
    this.host.announce(DEVICE_PROCESS_CHANGED, params, EXTENSION.deviceProcesses)
  }

  private clearTimers(entry: Entry): void {
    for (const timer of [entry.pumpTimer, entry.idleTimer, entry.retentionTimer])
      if (timer) clearTimeout(timer)
    entry.pumpTimer = null
    entry.idleTimer = null
    entry.retentionTimer = null
  }

  private terminate(entry: Entry): void {
    // 进程刚好在这一刻自己退出了的话底下会说“没有这个进程”，那正是想要的结果
    this.host.rpc
      .followup(this.owner, 'process', 'kill', { processHandle: entry.handle })
      .catch(() => {})
  }

  /** 记录没了：过了保留期、被清掉，或者结束时说了不留 */
  private drop(entry: Entry): void {
    if (this.entries.get(entry.handle) !== entry) return
    this.clearTimers(entry)
    for (const attachment of entry.attachments.values()) attachment.undrain()
    entry.attachments.clear()
    this.entries.delete(entry.handle)
    this.changed(entry, 'removed')
  }

  // ---------- 挂接 ----------

  private join(entry: Entry, audience: ProcessAudience, cursor: number, replayUntil: number): void {
    this.leave(entry, audience.id)
    const attachment: Attachment = {
      audience,
      cursor,
      replayUntil,
      missed: 0,
      live: false,
      exitedSent: false,
      // 这条连接从堵着变成通了：接着给它发
      undrain: audience.flow.onDrain(() => this.pump(entry)),
    }
    entry.attachments.set(audience.id, attachment)
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = null
    // 这一次请求的应答要先到：等它发出去之后再开始给这条连接发输出
    setImmediate(() => {
      if (entry.attachments.get(audience.id) !== attachment) return
      attachment.live = true
      this.pump(entry)
    })
  }

  private leave(entry: Entry, connectionId: string): boolean {
    const attachment = entry.attachments.get(connectionId)
    if (!attachment) return false
    attachment.undrain()
    entry.attachments.delete(connectionId)
    return true
  }

  /** 少了一条挂着的连接之后 */
  private left(entry: Entry): void {
    // 走的可能正是唯一堵着的那条：重新看要不要按住，缓冲也该裁了
    this.settle(entry)
    if (entry.attachments.size === 0) this.idle(entry)
    this.changed(entry, 'updated')
  }

  /** 没有连接挂着了：配了期限的话开始计时，到点结束它 */
  private idle(entry: Entry): void {
    const { idleTimeoutMs } = this.limits
    if (entry.state !== 'running' || idleTimeoutMs <= 0 || entry.idleTimer) return
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null
      if (entry.state !== 'running' || entry.attachments.size > 0) return
      this.host.log(
        `属于设备的进程 ${JSON.stringify(entry.handle)} 已经 ${idleTimeoutMs} 毫秒没有连接挂着，结束它`,
      )
      this.terminate(entry)
    }, idleTimeoutMs)
  }

  // ---------- 输出 ----------

  /** 进程出了一块输出 */
  private output(entry: Entry, stream: OutputStream, chunk: Buffer, capReached: boolean): void {
    if (this.closed) return
    entry.ring.push(stream, chunk, capReached)
    if (entry.attachments.size === 0) {
      // 没有连接挂着：不发，只进缓冲
      entry.ring.trim(entry.ring.to)
      return
    }
    if (entry.pumpTimer) return
    const wait = COALESCE_MS - (performance.now() - entry.lastPump)
    if (wait <= 0) this.pump(entry)
    else entry.pumpTimer = setTimeout(() => this.pump(entry), wait)
  }

  /** 把缓冲里各条连接还没拿到的发给它们，然后看要不要按住进程 */
  private pump(entry: Entry): void {
    if (entry.pumpTimer) clearTimeout(entry.pumpTimer)
    entry.pumpTimer = null
    if (this.closed) return
    entry.lastPump = performance.now()
    for (const attachment of entry.attachments.values()) this.feed(entry, attachment, false)
    this.settle(entry)
  }

  /**
   * 给一条连接发它还没拿到的输出，发到它堵上为止；进程已经退出、输出也发完了，就发退出通知。
   * closing：这条记录马上要没了，输出发不完也把退出通知发了。
   */
  private feed(entry: Entry, attachment: Attachment, closing: boolean): void {
    if (!attachment.live && !closing) return
    const { ring } = entry
    const { flow } = attachment.audience
    while (!flow.congested) {
      if (attachment.cursor < ring.from) {
        // 落后太多，中间那段已经被新的输出挤出缓冲了
        attachment.missed += ring.from - attachment.cursor
        attachment.cursor = ring.from
      }
      const replay = attachment.cursor < attachment.replayUntil
      const piece = ring.read(
        attachment.cursor,
        replay ? attachment.replayUntil : ring.to,
        FRAME_BYTES,
      )
      if (!piece) break
      const mark: DeviceProcessOutputMark = { offset: attachment.cursor }
      if (replay) mark.replay = true
      if (attachment.missed) mark.missedBytes = attachment.missed
      flow.send({
        method: 'process/outputDelta',
        params: {
          processHandle: entry.handle,
          stream: piece.stream,
          deltaBase64: piece.data.toString('base64'),
          capReached: piece.capReached,
          [DEVICE_PROCESS_FIELD]: mark,
        },
      })
      attachment.cursor += piece.data.length
      attachment.missed = 0
    }
    if (entry.state !== 'exited' || !entry.exited || attachment.exitedSent) return
    if (attachment.cursor < ring.to && !closing) return
    attachment.exitedSent = true
    const mark: DeviceProcessExitMark = { offset: ring.to }
    // 退出通知很小，不看积压
    flow.send({
      method: 'process/exited',
      params: { processHandle: entry.handle, ...entry.exited, [DEVICE_PROCESS_FIELD]: mark },
    })
  }

  /**
   * 流量控制在这里取舍：挂着的连接全都堵着，才按住进程不读它的输出（管道写满，进程自己停下）；
   * 只要有一条跟得上就不按，进程照常跑，落后的那些等通了之后从缓冲里补，落后得超过缓冲的那一段
   * 就丢掉并告诉它丢了多少。一条慢连接因此拖不住别的连接；只有一条连接时是不丢数据的背压。
   */
  private settle(entry: Entry): void {
    let fastest = -1
    let live = 0
    let congested = 0
    for (const attachment of entry.attachments.values()) {
      fastest = Math.max(fastest, attachment.cursor)
      if (!attachment.live) continue
      live++
      if (attachment.audience.flow.congested) congested++
    }
    const hold = entry.state === 'running' && live > 0 && congested === live
    if (hold !== entry.held) {
      entry.held = hold
      this.host.rpc.hold(OWNER, 'process', entry.handle, hold)
    }
    // 跑得最快的那条还没拿到的不丢；没人挂着就只留末尾那一段
    entry.ring.trim(fastest < 0 ? entry.ring.to : fastest)
  }

  /** 进程退出了 */
  private finish(entry: Entry): void {
    if (entry.state === 'exited' || !entry.exited) return
    entry.state = 'exited'
    entry.exit = { exitCode: entry.exited.exitCode, exitedAt: nowSeconds() }
    entry.exitOrder = ++this.exits
    entry.held = false
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = null
    if (this.closed) return
    if (entry.discard) {
      // 结束时说了不留记录：挂着的连接照样要知道它结束了
      for (const attachment of entry.attachments.values()) this.feed(entry, attachment, true)
      this.drop(entry)
      return
    }
    this.pump(entry)
    this.changed(entry, 'exited')
    entry.retentionTimer = setTimeout(() => this.drop(entry), this.limits.exitedRetentionMs)
    // 退出后的记录不能越攒越多（一直在起很快就退出的进程）：最多留和同时在跑的上限一样多，先清退出得早的
    const exited = [...this.entries.values()]
      .filter((item) => item.state === 'exited')
      .sort((a, b) => a.exitOrder - b.exitOrder)
    for (const old of exited.slice(0, Math.max(0, exited.length - this.limits.maxProcesses)))
      this.drop(old)
  }
}

function tagOf(option: unknown): DeviceProcessTag {
  if (!isObject(option)) throw new ProtocolError(-32602, `${DEVICE_PROCESS_FIELD} 必须是对象`)
  if (option.tag === undefined) return null
  const bytes = Buffer.byteLength(JSON.stringify(option.tag))
  if (bytes > DEVICE_PROCESS_TAG_MAX_BYTES)
    throw new ProtocolError(
      -32602,
      `${DEVICE_PROCESS_FIELD}.tag 写成 JSON 之后不能超过 ${DEVICE_PROCESS_TAG_MAX_BYTES} 字节，收到的有 ${bytes} 字节`,
    )
  return option.tag as DeviceProcessTag
}

/** 行列数。调用之前底下的实现已经验过形状；没给就是默认的大小 */
function sizeOf(value: unknown): DeviceProcessSize {
  if (!isObject(value)) return { ...DEFAULT_SIZE }
  return { rows: value.rows as number, cols: value.cols as number }
}

function offsetOf(value: unknown): number | null {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new ProtocolError(-32602, 'fromOffset 必须是非负整数')
  return value
}
