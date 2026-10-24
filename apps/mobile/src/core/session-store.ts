// 一个打开着的会话：订阅核心的会话主题，把增量落到视图上，再派生出对话区的行。
// 规矩：
// - 通知是唯一的数据来源（核心那一层已经这样做了），这里不轮询、不重读历史（J4、J5、S6）。
// - 一帧最多交给界面一次；只重算这一帧里动过的回合（J1、J3）。
// - 行按“新的在前”给出：对话区是倒置列表，第 0 行在最下面。
// - 正在流式的那条回答（切成的各块）和它下面的状态行单独作为“尾巴”交出去（splitTail 打开时）。尾巴每帧都在变，
//   列表的数据却不动：列表不用每帧重渲染、重算布局，只有正在长的那一块重画。
//   尾巴放在倒置列表的表头里（最底下），长高时上面的行跟着一起被顶上去，和原生的普通布局一样，同一帧完成。
import type {
  AgentMessageItem,
  AskAnswers,
  CoreChannel,
  SessionBackgroundView,
  SessionGoalView,
  SessionOp,
  SessionProposalView,
  SessionView,
  TurnStatus,
  UserMessageItem,
} from '@litch/core'
import { deriveBackground, gatherAnswers, parseAskReply, reduceSession } from '@litch/core'
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
   * 最后一个回合：标识、状态、里面的条目。输入线据此定“计划写好了，要不要执行”那一问（请求卡片的位置，
   * 判断用桌面的 composer/plan-ask.ts，条目的种类问 SessionStore.kindOf）。回合开始结束、请求来去时跟着换；
   * 计划条目在回合结束、请求到达之前就已经在了
   */
  lastTurn: { id: string; status: TurnStatus; itemIds: readonly string[] } | null
  /**
   * 对面不报后台任务的集合（can.backgroundTasks 为假）时，从已结束回合里还在跑的命令派生的那一份。
   * 报集合的是 null，用侧栏摘要上的 SessionSummary.background
   */
  derived: SessionBackgroundView | null
  /** 持续目标（harness 会才有）：输入框上方那一行用。达成了核心马上清掉，回答下面那一句在对话区的行里 */
  goal: SessionGoalView | null
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
  let size = 2
  if (experiment.tail === 'open') return live.open ? size : 0
  while (true) {
    const row = built[size]
    if (row?.type !== 'md' || row.itemId !== live.itemId) return size
    size += 1
  }
}

function lastTurnOf(view: SessionView): SessionMeta['lastTurn'] {
  const turn = view.turns[view.turns.length - 1]
  return turn ? { id: turn.id, status: turn.status, itemIds: [...turn.itemIds] } : null
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
  /**
   * 这个会话上的全部提案（建议任务）。手机上会话只经这里订阅、核心的数据副本不开会话，副本里的 keys.proposals 是空的，
   * 列表页、“改了再开始”从这里取。快照还没到是 undefined
   */
  private proposals: readonly SessionProposalView[] | undefined = undefined
  private readonly proposalListeners = new Set<() => void>()
  private proposalsDirty = false
  /** 这个会话里收到过的答复（模型边干活边问的题）：题目标识 → 答了什么。问题卡片据此显示“已答” */
  private answers: AskAnswers = {}
  private readonly answerListeners = new Set<() => void>()
  private answersDirty = false
  private readonly builder = new RowBuilder()
  private readonly listeners = new Set<() => void>()
  private readonly itemTurn = new Map<string, string>()
  private dirty: Set<string> | 'all' = new Set()
  private frame: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastPublish = 0
  private unsubscribe: (() => void) | null = null
  private readonly dataListeners = new Set<() => void>()
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
          this.proposalsDirty = true
          this.recountAnswers(data)
          for (const listener of this.dataListeners) listener()
          this.schedule()
        },
        delta: (ops) => {
          if (!this.view) return
          for (const op of ops) this.apply(this.view, op)
          for (const listener of this.dataListeners) listener()
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

  /** 展开或收起一样东西（一组过程、其中一步、一段思考）。只重算它所在的那一个回合 */
  toggle(key: string, turnId: string): void {
    if (this.builder.expanded.has(key)) this.builder.expanded.delete(key)
    else this.builder.expanded.add(key)
    if (this.dirty !== 'all') this.dirty.add(turnId)
    this.publish()
  }

  /** 一个回合开头的那条用户消息（分叉、回退、复制用）。回合不在了或者没有就是 null */
  userMessage(turnId: string): UserMessageItem | null {
    const turn = this.view?.turns.find((each) => each.id === turnId)
    for (const id of turn?.itemIds ?? []) {
      const item = this.view?.items[id]
      if (item?.kind === 'userMessage') return item
    }
    return null
  }

  /** 一个条目是什么种类。条目的种类定了就不变，现取就行 */
  readonly kindOf = (itemId: string): string | undefined => this.view?.items[itemId]?.kind

  /** 一条助手消息上带的题（模型边干活边问）。题目在条目一开始就有、不再变，现取就行；不是带题的消息是 undefined */
  readonly questionsOf = (itemId: string): AgentMessageItem['questions'] => {
    const item = this.view?.items[itemId]
    return item?.kind === 'agentMessage' ? item.questions : undefined
  }

  /** 一个条目在哪个回合里 */
  readonly turnOf = (itemId: string): string | undefined => this.itemTurn.get(itemId)

  /** 这一回合最后一条回答的全文（行里只有切出来的一块）；没有回答时是计划 */
  answerText(turnId: string): string | null {
    const turn = this.view?.turns.find((each) => each.id === turnId)
    let plan: string | null = null
    for (const id of (turn?.itemIds ?? []).toReversed()) {
      const item = this.view?.items[id]
      if (item?.kind === 'agentMessage' && item.text) return item.text
      if (item?.kind === 'plan' && item.text) plan ??= item.text
    }
    return plan
  }

  /** 一条回答的全文（加评论时选字用）。不是回答、或者已经不在了是 null */
  itemText(itemId: string): string | null {
    const item = this.view?.items[itemId]
    return item?.kind === 'agentMessage' ? item.text : null
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): SessionSnapshot => this.snapshot

  /**
   * 收到数据（快照、增量）就叫，不等下一帧交给界面；配着 runningNow 用。
   * 离开详情页后留着的存储靠它（store-cache.ts）：交给界面要等帧，应用在后台时帧不来
   */
  readonly subscribeData = (listener: () => void): (() => void) => {
    this.dataListeners.add(listener)
    return () => this.dataListeners.delete(listener)
  }

  /** 照收到的数据现算有没有回合在跑 */
  readonly runningNow = (): boolean =>
    this.view?.turns.some((turn) => turn.status === 'running') ?? false

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

  readonly subscribeProposals = (listener: () => void): (() => void) => {
    this.proposalListeners.add(listener)
    return () => this.proposalListeners.delete(listener)
  }

  readonly getProposals = (): readonly SessionProposalView[] | undefined => this.proposals

  readonly subscribeAnswers = (listener: () => void): (() => void) => {
    this.answerListeners.add(listener)
    return () => this.answerListeners.delete(listener)
  }

  readonly getAnswers = (): AskAnswers => this.answers

  /** 答复表照会话里现有的条目重算 */
  private recountAnswers(view: SessionView): void {
    const ordered = view.turns.flatMap((turn) => turn.itemIds.flatMap((id) => view.items[id] ?? []))
    this.answers = gatherAnswers({}, ordered)
    this.answersDirty = true
  }

  /** 尾巴单独交出去（贴底时）还是并回列表（往上翻着看时：列表要靠数据变化来保持可见位置） */
  setSplitTail(split: boolean): void {
    if (this.split === split) return
    this.split = split
    this.publish()
  }

  private apply(view: SessionView, op: SessionOp): void {
    this.stats.ops++
    const before = op.op === 'session.proposals' ? view.proposals : null
    const removed = op.op === 'item.remove' ? view.items[op.itemId] : undefined
    const reachedBefore = op.op === 'session.goalReached' ? view.goalReached?.turnId : undefined
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
      case 'item.add': {
        this.itemTurn.set(op.item.id, op.turnId)
        mark(op.turnId)
        // 命令的状态决定不报集合的会话有没有后台任务在跑（meta.derived）
        if (op.item.kind === 'command') this.metaDirty = true
        const answers = gatherAnswers(this.answers, [op.item])
        if (answers !== this.answers) {
          this.answers = answers
          this.answersDirty = true
        }
        return
      }
      case 'item.remove':
        mark(op.turnId)
        // 拿掉的是一份答复（插话没插成，退回了队列）：答复表照剩下的条目重算
        if (removed?.kind === 'userMessage' && parseAskReply(removed.text))
          this.recountAnswers(view)
        return
      case 'item.status':
        mark(this.itemTurn.get(op.itemId))
        if (view.items[op.itemId]?.kind === 'command') this.metaDirty = true
        return
      case 'item.appendText':
      case 'item.appendOutput':
        mark(this.itemTurn.get(op.itemId))
        return
      case 'session.proposals':
        // 提案变了（新提、开始、不要、撤回、过期）：画着它们的那几个回合重算。
        // 没记着提在哪次调用里的旧提案只能按提案号去找 start 那一条，不知道在哪个回合，全部重算
        for (const proposal of [...(before ?? []), ...op.proposals]) {
          if (!proposal.callId) this.dirty = 'all'
          else mark(this.itemTurn.get(proposal.callId))
        }
        this.proposalsDirty = true
        return
      case 'session.goalReached':
        // 目标达成那一句挪了（写上、设新目标后拿掉）：前后两个回合重算
        mark(reachedBefore)
        mark(op.reached?.turnId)
        return
      case 'request.add':
      case 'request.remove':
        // 有没有待答的请求决定回合末尾那一行写不写“运行中”：在跑的回合重算
        for (const turn of view.turns) if (turn.status === 'running') mark(turn.id)
        this.metaDirty = true
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
        derived: view.can.backgroundTasks ? null : deriveBackground(view.turns, view.items),
        goal: view.goal ?? null,
      }
      for (const listener of this.metaListeners) listener()
    }
    if (this.proposalsDirty) {
      this.proposalsDirty = false
      this.proposals = view.proposals
      for (const listener of this.proposalListeners) listener()
    }
    if (this.answersDirty) {
      this.answersDirty = false
      for (const listener of this.answerListeners) listener()
    }
    noteWork('emit', performance.now() - emitted)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
