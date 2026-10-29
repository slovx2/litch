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
  AgentState,
  AgentThreadView,
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
import {
  agentStatesOf,
  deriveBackground,
  gatherAnswers,
  isAgentSpawn,
  parseAskReply,
  proposedBy,
  reduceSession,
} from '@litch/core'
import { type LatestTodo, latestTodo } from '../detail/todo/logic'
import { experiment } from '../experiment'
import { noteOpenStage, noteWork } from '../probe'
import { type Row, RowBuilder } from './rows'

export interface SessionSnapshot {
  /** 新的在前。splitTail 时不含尾巴 */
  rows: Row[]
  running: boolean
  error: string | null
  /**
   * 行是从上次留下的视图建的（core/view-cache.ts），核心的快照还没到：只读地摆着，快照到了整份换掉。
   * 这时 meta 还是 null（请求、设置都可能过时，不拿来用）
   */
  stale: boolean
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
  /** 引擎自己派出的子代理（会话开着时核心推来的 session.agents）：后台任务那一行和后台任务页算它们 */
  agents: readonly AgentThreadView[]
  /** 父会话的协作条目里报的各个子代理的状态（子线程说不出来时用）。没有子代理时是空的 */
  reported: ReadonlyMap<string, AgentState>
}

const NO_REPORTED: ReadonlyMap<string, AgentState> = new Map()

/** 协作条目（派出、等待、关闭子代理的那一次调用） */
const isAgentCall = (item: SessionView['items'][string] | undefined): boolean =>
  item?.kind === 'toolCall' && item.agents !== undefined

const EMPTY: SessionSnapshot = {
  rows: [],
  running: false,
  error: null,
  stale: false,
  publishedAt: 0,
}
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

/**
 * 列表最前面（最新、在最底下）有几行会自己长高：回合在跑时末尾的状态行，和它上面正在流的那一块。
 * 对话区往上翻着看时不拿它们当“保持可见位置”的锚点（detail/Transcript.tsx）
 */
export function growingRows(snapshot: SessionSnapshot): number {
  if (!snapshot.running) return 0
  const { rows } = snapshot
  let count = rows[0]?.type === 'status' ? 1 : 0
  const block = rows[count]
  if (block?.type === 'md' && block.open) count += 1
  return count
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
  /** view 是 seed 摆上的旧视图，核心的快照还没到 */
  private stale = false
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
  /** 会话里最近的一份待办（输入框上方那个小按钮和它的浮窗用）。待办整份换、回合开始结束时重找 */
  private todo: LatestTodo | null = null
  private readonly todoListeners = new Set<() => void>()
  private todoDirty = false
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
          this.stale = false
          this.itemTurn.clear()
          for (const turn of data.turns)
            for (const id of turn.itemIds) this.itemTurn.set(id, turn.id)
          this.dirty = 'all'
          this.metaDirty = true
          this.proposalsDirty = true
          this.todoDirty = true
          this.recountAnswers(data)
          for (const listener of this.dataListeners) listener()
          this.schedule()
        },
        delta: (ops) => {
          if (!this.view || this.stale) return
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

  /**
   * 核心的快照到之前先摆上上次留下的视图（core/view-cache.ts），同步建好行，打开会话的第一帧就有内容。
   * 已经有视图了（快照先到了）就不用
   */
  seed(view: SessionView): void {
    if (this.view) return
    this.view = view
    this.stale = true
    this.itemTurn.clear()
    for (const turn of view.turns) for (const id of turn.itemIds) this.itemTurn.set(id, turn.id)
    this.dirty = 'all'
    this.publish()
  }

  /** 核心给的、现在的视图（留一份用）。还没收到快照（包括只摆着旧视图时）是 null */
  currentView(): SessionView | null {
    return this.stale ? null : this.view
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
    this.builder.toggle(key, turnId)
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

  /**
   * 回合进行中插进这一回合的一条用户消息（不是回合的第一个条目，和核心认的一样）。
   * 是的话返回它，回合不在了、不是用户消息、是回合开头那条的都是 null
   */
  steeredMessage(turnId: string, itemId: string): UserMessageItem | null {
    const turn = this.view?.turns.find((each) => each.id === turnId)
    const item = this.view?.items[itemId]
    if (!turn || item?.kind !== 'userMessage' || turn.itemIds.indexOf(itemId) < 1) return null
    return item
  }

  /** 这一回合里 itemId 后面那条自己插进来的话（分叉带到它之前）；别的会话发来的、只是一条系统提示的不算 */
  nextSteer(turnId: string, itemId: string): string | null {
    const ids = this.view?.turns.find((each) => each.id === turnId)?.itemIds ?? []
    const at = ids.indexOf(itemId)
    if (at < 0) return null
    for (const id of ids.slice(at + 1)) {
      const item = this.view?.items[id]
      if (item?.kind === 'userMessage' && !item.peer && (!item.event || item.text)) return id
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

  readonly subscribeTodo = (listener: () => void): (() => void) => {
    this.todoListeners.add(listener)
    return () => this.todoListeners.delete(listener)
  }

  readonly getTodo = (): LatestTodo | null => this.todo

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
        this.todoDirty = true
        return
      case 'turn.remove':
      case 'turn.status':
        mark(op.turnId)
        // 回合开始、结束改变“有回合在跑”，也改变待办那个小按钮出不出
        this.metaDirty = true
        this.todoDirty = true
        return
      case 'turn.retry':
        mark(op.turnId)
        return
      case 'item.add': {
        this.itemTurn.set(op.item.id, op.turnId)
        mark(op.turnId)
        // 命令的状态决定不报集合的会话有没有后台任务在跑（meta.derived）
        // 子代理的状态也在条目上报（派出、等待的协作条目）
        if (op.item.kind === 'command' || isAgentCall(op.item)) this.metaDirty = true
        // 待办改了一次：整份换掉
        if (op.item.kind === 'todo') this.todoDirty = true
        const answers = gatherAnswers(this.answers, [op.item])
        if (answers !== this.answers) {
          this.answers = answers
          this.answersDirty = true
        }
        return
      }
      case 'item.remove':
        mark(op.turnId)
        if (removed?.kind === 'todo') this.todoDirty = true
        // 拿掉的是一份答复（插话没插成，退回了队列）：答复表照剩下的条目重算
        if (removed?.kind === 'userMessage' && parseAskReply(removed.text))
          this.recountAnswers(view)
        return
      case 'item.status':
        mark(this.itemTurn.get(op.itemId))
        if (view.items[op.itemId]?.kind === 'command' || isAgentCall(view.items[op.itemId]))
          this.metaDirty = true
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
          else {
            // callId 是协议条目号，索引键是“显示回合号:条目号”，与画卡片时用同一套对应关系。
            for (const [itemId, turnId] of this.itemTurn)
              if (proposedBy(proposal, itemId)) mark(turnId)
          }
        }
        this.proposalsDirty = true
        return
      case 'session.goalReached':
        // 目标达成那一句挪了（写上、设新目标后拿掉）：前后两个回合重算
        mark(reachedBefore)
        mark(op.reached?.turnId)
        return
      case 'session.agents':
        // 子代理的列表变了（子线程开始、结束了）：画着子代理那一行的回合重算，子代理页的标题跟着换
        for (const turn of view.turns)
          if (turn.itemIds.some((id) => isAgentSpawn(view.items[id]))) mark(turn.id)
        this.metaDirty = true
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
    const stale = this.stale
    const listChanged =
      !sameRows(rows, this.snapshot.rows) ||
      running !== this.snapshot.running ||
      stale !== this.snapshot.stale ||
      this.snapshot.error !== null
    const tailChanged = !sameRows(tail, this.tail.rows)
    if (tailChanged) this.tail = { rows: tail, publishedAt: now }
    if (listChanged) this.snapshot = { rows, running, error: null, stale, publishedAt: now }
    const emitted = performance.now()
    // 两边都变时一起通知：React 把同一轮里的更新合成一次提交，块封口时尾巴缩回、列表多一行在同一帧
    if (tailChanged) for (const listener of this.tailListeners) listener()
    if (listChanged) this.emit()
    // 旧视图上的会话层面状态（请求、设置、提案、待办）都可能过时：快照到了再交
    if (stale) {
      noteWork('emit', performance.now() - emitted)
      return
    }
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
        agents: view.agents,
        reported:
          view.agents.length > 0
            ? agentStatesOf(view.turns.flatMap((turn) => turn.itemIds.map((id) => view.items[id])))
            : NO_REPORTED,
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
    if (this.todoDirty) {
      this.todoDirty = false
      const todo = latestTodo(view)
      const prev = this.todo
      if (todo?.item !== prev?.item || todo?.running !== prev?.running) {
        this.todo = todo
        for (const listener of this.todoListeners) listener()
      }
    }
    noteWork('emit', performance.now() - emitted)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
