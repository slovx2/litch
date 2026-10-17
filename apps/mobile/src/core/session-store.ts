// 一个打开着的会话：订阅核心的会话主题，把增量落到视图上，再派生出对话区的行。
// 规矩：
// - 通知是唯一的数据来源（核心那一层已经这样做了），这里不轮询、不重读历史（J4、J5、S6）。
// - 一帧最多交给界面一次；只重算这一帧里动过的回合（J1、J3）。
// - 行按“新的在前”给出：对话区是倒置列表，第 0 行在最下面。
// - 正在流式的那条回答（切成的各块）和它下面的状态行单独作为“尾巴”交出去（splitTail 打开时）。尾巴每帧都在变，
//   列表的数据却不动：列表不用每帧重渲染、重算布局，只有正在长的那一块重画。
//   尾巴放在倒置列表的表头里（最底下），长高时上面的行跟着一起被顶上去，和原生的普通布局一样，同一帧完成。
import type { CoreChannel, SessionOp, SessionView, TurnStatus } from '@litch/core'
import { reduceSession } from '@litch/core'
import { experiment } from '../experiment'
import { noteOpenStage, noteWork } from '../probe'
import { type Row, RowBuilder } from './rows'

export interface SessionSnapshot {
  /** 新的在前。splitTail 时不含尾巴 */
  rows: Row[]
  running: boolean
  error: string | null
  /** 什么时候交给界面的（performance.now()）：对话区提交后用它算 React 渲染加提交花了多久 */
  publishedAt: number
}

export interface TailSnapshot {
  /** 新的在前：[状态行, 正在长的那一块, 同一条回答已经封口的块…]，没有在流式的回答时是空的 */
  rows: Row[]
  publishedAt: number
}

/**
 * 会话层面的状态（不进对话区的行）：输入区、请求卡片、标题栏用。核心报了会话层面的增量（请求、排队、设置、用量、
 * 能不能发、会做哪些事）或者整份快照到了才换一份新的；数组是拷贝，组件拿到的永远是不可变的值
 */
export interface SessionMeta {
  title: SessionView['title']
  harness: string
  cwd: string
  live: boolean
  note: SessionView['note']
  requests: SessionView['requests']
  queued: SessionView['queued']
  settings: SessionView['settings']
  usage: SessionView['usage']
  can: SessionView['can']
  forkedFrom: string | null
  /** 有回合在跑 */
  running: boolean
  /**
   * 最后一个回合：标识、状态，和它里面最后一个计划条目（没有是 null）。输入线据此定“计划写好了，要不要执行”
   * 那一问（请求卡片的位置）。回合开始结束、请求来去时跟着换；计划条目在回合结束、请求到达之前就已经在了
   */
  lastTurn: { id: string; status: TurnStatus; planId: string | null } | null
}

const EMPTY: SessionSnapshot = { rows: [], running: false, error: null, publishedAt: 0 }
const NO_TAIL: TailSnapshot = { rows: [], publishedAt: 0 }

/**
 * 尾巴有几行（新的在前）：最新回合的状态行，加上正在流式的那条回答已经切出来的全部块。
 * experiment.tail 为 whole 时整条回答在流式期间都留在尾巴里，块封口时列表也不动，回答写完才一次并进列表；
 * 为 open 时只留正在长的那一块，块一封口就进列表
 */
function tailSize(built: Row[]): number {
  const live = built[1]
  // 看的是整条回答还在不在流式，不看最后一块：字刚好停在块的边上时，最后一块已经封口、新的一块还没开始
  if (built[0]?.type !== 'status' || live?.type !== 'md' || !live.live) return 0
  const item = live.key.slice(0, live.key.lastIndexOf(':'))
  let size = 2
  if (experiment.tail === 'open') return live.open ? size : 0
  while (true) {
    const row = built[size]
    if (row?.type !== 'md' || row.key.slice(0, row.key.lastIndexOf(':')) !== item) return size
    size += 1
  }
}

function lastTurnOf(view: SessionView): SessionMeta['lastTurn'] {
  const turn = view.turns[view.turns.length - 1]
  if (!turn) return null
  let planId: string | null = null
  // 从后往前找：Hermes 上新一点的数组方法不一定有（原型报告第六节）
  for (let index = turn.itemIds.length - 1; index >= 0 && !planId; index--) {
    const id = turn.itemIds[index]
    if (id && view.items[id]?.kind === 'plan') planId = id
  }
  return { id: turn.id, status: turn.status, planId }
}

const sameRows = (a: Row[], b: Row[]): boolean =>
  a.length === b.length && a.every((row, index) => row === b[index])

export class SessionStore {
  private snapshot: SessionSnapshot = EMPTY
  private tail: TailSnapshot = NO_TAIL
  private readonly tailListeners = new Set<() => void>()
  private split = false
  private view: SessionView | null = null
  private meta: SessionMeta | null = null
  private readonly metaListeners = new Set<() => void>()
  private metaDirty = false
  private readonly builder = new RowBuilder()
  private readonly listeners = new Set<() => void>()
  private readonly itemTurn = new Map<string, string>()
  private dirty: Set<string> | 'all' = new Set()
  private frame: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastPublish = 0
  private unsubscribe: (() => void) | null = null
  /** 给测量用：一共交给界面几次、最近一次花了多少毫秒 */
  readonly stats = { publishes: 0, lastBuildMs: 0, ops: 0 }

  constructor(
    private readonly channel: CoreChannel,
    readonly deviceId: string,
    readonly sessionId: string,
  ) {}

  start(): void {
    noteOpenStage('subscribe')
    this.unsubscribe = this.channel.subscribe(
      { kind: 'session', deviceId: this.deviceId, sessionId: this.sessionId },
      {
        snapshot: (data) => {
          noteOpenStage('snapshot')
          this.view = data
          this.itemTurn.clear()
          for (const turn of data.turns)
            for (const id of turn.itemIds) this.itemTurn.set(id, turn.id)
          this.dirty = 'all'
          this.metaDirty = true
          this.schedule()
        },
        delta: (ops) => {
          if (!this.view) return
          for (const op of ops) this.apply(this.view, op)
          this.schedule()
        },
        error: (error) => {
          this.snapshot = { ...this.snapshot, error: error.message, publishedAt: performance.now() }
          this.emit()
        },
      },
    )
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    if (this.timer !== null) clearTimeout(this.timer)
    this.frame = null
    this.timer = null
  }

  /** 展开或收起一组过程。只重算那一个回合 */
  toggle(groupKey: string): void {
    if (this.builder.expanded.has(groupKey)) this.builder.expanded.delete(groupKey)
    else this.builder.expanded.add(groupKey)
    const turnId = groupKey.slice(0, groupKey.indexOf(':p:'))
    if (this.dirty !== 'all') this.dirty.add(turnId)
    this.publish()
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): SessionSnapshot => this.snapshot

  readonly subscribeTail = (listener: () => void): (() => void) => {
    this.tailListeners.add(listener)
    return () => this.tailListeners.delete(listener)
  }

  readonly getTail = (): TailSnapshot => this.tail

  readonly subscribeMeta = (listener: () => void): (() => void) => {
    this.metaListeners.add(listener)
    return () => this.metaListeners.delete(listener)
  }

  /** 快照还没到时是 null */
  readonly getMeta = (): SessionMeta | null => this.meta

  /** 尾巴单独交出去（贴底时）还是并回列表（往上翻着看时：列表要靠数据变化来保持可见位置） */
  setSplitTail(split: boolean): void {
    if (this.split === split) return
    this.split = split
    this.publish()
  }

  private apply(view: SessionView, op: SessionOp): void {
    this.stats.ops++
    reduceSession(view, op)
    const mark = (turnId: string | undefined) => {
      if (turnId && this.dirty !== 'all') this.dirty.add(turnId)
    }
    switch (op.op) {
      case 'turn.add':
        for (const id of op.turn.itemIds) this.itemTurn.set(id, op.turn.id)
        mark(op.turn.id)
        // 新回合多半一来就是在跑的，还换了“最后一个回合”
        this.metaDirty = true
        return
      case 'turn.remove':
      case 'turn.status':
        mark(op.turnId)
        // 回合开始、结束改变“有回合在跑”
        this.metaDirty = true
        return
      case 'item.add':
        this.itemTurn.set(op.item.id, op.turnId)
        mark(op.turnId)
        return
      case 'item.remove':
        mark(op.turnId)
        return
      case 'item.appendText':
      case 'item.appendOutput':
      case 'item.status':
        mark(this.itemTurn.get(op.itemId))
        return
      default:
        // 会话层面的状态（排队、设置、用量、请求、能不能发）：不进行，换一份 meta
        this.metaDirty = true
        return
    }
  }

  /**
   * 下一帧交给界面。experiment.pace 大于 0 时，两次之间至少隔这么多毫秒：
   * 每交一次，正在长的那块就要整块重新排版（安卓的文字排版，在 JS 线程上），隔开一点能成倍省下 JS 线程
   */
  private schedule(): void {
    if (this.frame !== null || this.timer !== null) return
    const wait = this.lastPublish + experiment.pace - performance.now()
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.schedule()
      }, wait)
      return
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      this.lastPublish = performance.now()
      this.publish()
    })
  }

  private publish(): void {
    const view = this.view
    if (!view) return
    const started = performance.now()
    const built = this.builder.build(view, this.dirty).reverse()
    this.dirty = new Set()
    this.stats.lastBuildMs = performance.now() - started
    this.stats.publishes++
    noteWork('build', this.stats.lastBuildMs)
    noteOpenStage('built')
    const size = this.split ? tailSize(built) : 0
    const rows = size ? built.slice(size) : built
    const tail = size ? built.slice(0, size) : []
    const running = view.turns.some((turn) => turn.status === 'running')
    const now = performance.now()
    const listChanged =
      !sameRows(rows, this.snapshot.rows) ||
      running !== this.snapshot.running ||
      this.snapshot.error !== null
    const tailChanged = !sameRows(tail, this.tail.rows)
    if (tailChanged) this.tail = { rows: tail, publishedAt: now }
    if (listChanged) this.snapshot = { rows, running, error: null, publishedAt: now }
    const emitted = performance.now()
    // 两边都变时一起通知：React 把同一轮里的更新合成一次提交，块封口时尾巴缩回、列表多一行在同一帧
    if (tailChanged) for (const listener of this.tailListeners) listener()
    if (listChanged) this.emit()
    if (this.metaDirty) {
      this.metaDirty = false
      this.meta = {
        title: view.title,
        harness: view.harness,
        cwd: view.cwd,
        live: view.live,
        note: view.note,
        requests: [...view.requests],
        queued: [...view.queued],
        settings: { ...view.settings },
        usage: view.usage,
        can: { ...view.can },
        forkedFrom: view.forkedFrom,
        running,
        lastTurn: lastTurnOf(view),
      }
      for (const listener of this.metaListeners) listener()
    }
    noteWork('emit', performance.now() - emitted)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
