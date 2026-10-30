// 会话视图 → 对话区的行。规矩（对着验证原型里查出来的“飘”和“卡”的原因定的）：
// - 行的标识只由回合、条目、块号决定，流式和定稿之间不变；内容没变的行原样复用同一个对象，单元格不重画。
// - 分块和桌面端共用核心的 bucketItems：过程里按时间排说明段、步骤组、启动子代理那一行；思考是步骤组里的一步，不把组断开。
//   步骤组收起时是一行高度固定的摘要；展开时每一步各是一行，排在摘要的下面，最后再一行“收起”
//  （照桌面端往下展开；被点的摘要不动由 detail/keep-place.ts 管）。
// - 过程告一段落（回合结束，或最终回答写完了）后按用户补充的位置分段收起（process），照桌面端：用户在这一回合里展开过某一组、某一步，
//   或者还有子代理没做完时不自动收；点那一行开合。
// - 启动子代理的那次调用不进步骤组，单独一行，每个子代理一条（照桌面端）；等待、发输入这些协作调用还是组里的一步。
// - 每个回合末尾一行状态，从回合开始到结束一直在，只换字不换高度。回合在跑时写“{name} 正在工作”和已用的时间，只在正文出字、等人答复时留空（workingShown）。
// - 建议任务的卡片（收尾带的、start 提的）和收尾留的问题排在回合最下方（回答下面、状态行上面），过程里调用的位置只留一步；
//   offer 卡挂在回合中间等人选，不挪。没字的思考不画。
// - 行里放条目对象本身（单元格从它取要画的东西），再加上条目里会被原地改掉的那几项（核心对文字、状态是原地改的，
//   对 item.add 是整个换掉）：这样逐项比一遍（sameRow）就知道内容变没变。
import type {
  AgentState,
  AgentThreadView,
  CommandItem,
  CompactionItem,
  FileChangeItem,
  ItemView,
  NoticeItem,
  PeerView,
  ProcessPart,
  ReasoningItem,
  SessionMentionView,
  SessionNoteView,
  SessionProposalView,
  SessionView,
  SpawnedView,
  SystemMessageView,
  Text,
  TodoStep,
  ToolCallItem,
  TurnOrigin,
  TurnRetryView,
  TurnView,
  UserAttachment,
  WebSearchItem,
} from '@litch/core'
import {
  agentRunState,
  agentStatesOf,
  agentsUnfinished,
  blockInput,
  bucketItems,
  goalReachedIn,
  parseAskReply,
  processDuration,
  processFolded,
  processSegments,
  processSettled,
  processTally,
  spanFrom,
  spanOf,
  thoughtShown,
  turnAddition,
  workingShown,
} from '@litch/core'
import { questionItemOf } from '../../../../packages/ui/src/transcript/ask-ids.ts'
import { cardsOf, eventKind, handOffOf, isOfferCall } from '../detail/proposals/logic'
import { type ChunkState, chunkText, emptyChunks } from './blocks'

export type StepItem = CommandItem | FileChangeItem | ToolCallItem | WebSearchItem | NoticeItem

/** declined：用户或策略拒绝了 */
export type StepState = 'running' | 'done' | 'failed' | 'declined'

export type Row =
  /** 会话最上面一行：从哪个会话分叉出来的 */
  | { type: 'forked'; key: string; from: string }
  | {
      type: 'user'
      key: string
      turnId: string
      text: string
      attachments: UserAttachment[]
      /** 别的会话发来的消息（peerMessages 扩展、litch_sessions.send）：气泡上面写是谁发来的，正文先收成几行 */
      peer?: PeerView
      /** 别的会话发来的那种点开了全文 */
      expanded?: boolean
      /** 提到的会话：正文里的 ＠[标题] 画成能点的字（核心认出来的 UserMessageItem.sessions） */
      sessions?: SessionMentionView[]
      /** 发送的时刻（回合开始的时刻），只有回合开头那条有：插进来的话条目上不带时刻 */
      sentAt?: number
      /** 同一回合进行中补充的用户输入。 */
      addition?: boolean
    }
  /**
   * Litch 替用户发的话（核心认出来的 UserMessageItem.system：定时任务、子会话的简报、在这里做）：画成系统卡片，
   * 一行来源和类型、两行简略内容，点开看全文（text 是发给模型的原文）
   */
  | {
      type: 'system'
      key: string
      turnId: string
      text: string
      system: SystemMessageView
      expanded: boolean
    }
  /**
   * 不是用户发起的回合开头那一行（后台任务跑完后 harness 自己接着做的……），放在用户气泡的位置。
   * 叫醒它的任务由单元格对着后台集合找（startedAt 用来找）
   */
  | {
      type: 'origin'
      key: string
      turnId: string
      origin: Exclude<TurnOrigin, 'user'>
      startedAt: number | null
    }
  /**
   * 设备进程注入在用户消息开头的那一段（<litch-session-event>）：子会话的回报、唤醒、没调收尾时的提醒。
   * 画成一条轻的提示，不画成用户说的话
   */
  | {
      type: 'event'
      key: string
      turnId: string
      kind: ReturnType<typeof eventKind>
      body?: string
      summary?: string
      notes: SessionNoteView[]
    }
  /**
   * 一张提案卡（建议任务）：收尾调用带的一条建议，或者 litch_sessions.start 降成的提案。一条调用几张卡就几行。
   * proposal 为 null：start 的结果里有提案号、列表里还没有它，照调用时给的（spawned）画。
   * offer：start 带 initiation offer 的那张（“新会话 / 在这里做”）
   */
  | {
      type: 'proposal'
      key: string
      turnId: string
      itemId: string
      proposal: SessionProposalView | null
      spawned: SpawnedView | null
      offer: boolean
    }
  /**
   * 收尾（wrap_up）留给用户的问题和回复按钮，排在回合最下方的卡片前面。能不能答由单元格对着会话的最后一个回合算
   */
  | {
      type: 'wrapAsk'
      questionSource?: string
      key: string
      turnId: string
      itemId: string
      ask: string
      actions: readonly { label: string; message?: string }[]
    }
  /**
   * 问用户的工具（AskUserQuestion 等，核心的 ToolCallItem.asked）画成的问答卡片，露在过程外面。
   * item 换了（核心对 item.add 整个换掉）才换
   */
  | { type: 'asked'; key: string; turnId: string; item: ToolCallItem }
  /**
   * litch_sessions.hand_off：做到一半的任务交给了分叉会话。threadId 是起出来的那个，还没有结果是 null。
   * running：调用还没完
   */
  | {
      type: 'handoff'
      key: string
      turnId: string
      itemId: string
      title: string
      threadId: string | null
      running: boolean
    }
  /**
   * 回答或计划的一块。open：这一块还在长；live：这条回答还在流式（它的块都算，哪怕最后一块刚好封了口）；
   * plan：计划条目，first 的那一块上面写“计划”
   */
  | {
      type: 'md'
      key: string
      turnId: string
      itemId: string
      text: string
      open: boolean
      live: boolean
      plan: boolean
      first: boolean
    }
  /** 收起时只有最后一行字，点开是全文 */
  | {
      type: 'reasoning'
      key: string
      turnId: string
      text: string
      expanded: boolean
    }
  /**
   * 告一段落后整段过程收成的那一行（核心的 processTally）：几段说明、几步、几个子代理，被拒的、失败的子代理标红。
   * status、durationMs 是回合的：回合结束了才写用时，出错、中断标红
   */
  | {
      type: 'process'
      key: string
      turnId: string
      expanded: boolean
      notes: number
      steps: number
      agents: number
      declined: number
      agentsFailed: number
      status: TurnView['status']
      durationMs: number | null
      /** 整段过程里各条目的标识（空格隔开）：回合结束后单元格拿它对着后台集合数还有几个在跑 */
      ids: string
    }
  /**
   * 一组过程的摘要。current：正在跑的那一步说的是什么（回合在跑时才有：回合结束后还 inProgress 的是后台命令）。
   * thinking：正在跑的是一段思考，current 是它的第一行。count、failed 不算思考
   * ids：这一组各步的条目标识（空格隔开），回合结束了（ended）时单元格拿它对着后台集合数还有几个在跑
   */
  | {
      type: 'group'
      key: string
      turnId: string
      count: number
      failed: number
      /** 这一组从第一条开始到最后一条结束用了多久（条目上记的 span）。没记过是 null */
      durationMs: number | null
      current: Text | null
      thinking: boolean
      /** 有一步在跑时这一组最早开始的时刻（本机的钟），单元格从它一秒一秒地算累计用时；没在跑、没记过是 null */
      since: number | null
      running: boolean
      expanded: boolean
      ids: string
      ended: boolean
    }
  /** 展开的一组末尾那一行“收起”。group 是那一组的键 */
  | { type: 'groupEnd'; key: string; turnId: string; group: string }
  /**
   * 启动子代理的那一次调用（collab.spawnAgent）：每个子代理一条，点了看它。
   * threads 是会话上的子代理列表（view.agents，换了才换）；states 是条目里每个子代理现在的状态（空格隔开，
   * 先后同 item.agents），按核心的 agentRunState 取：子线程自己的回合优先，其次同一回合里协作条目报的，最后是派出时的快照
   */
  | {
      type: 'agents'
      key: string
      turnId: string
      item: ToolCallItem
      threads: AgentThreadView[]
      states: string
    }
  /** 展开的一组里的一步。output、tail、exitCode、durationMs 是命令条目上会原地变的几项 */
  | {
      type: 'step'
      key: string
      turnId: string
      item: StepItem
      state: StepState
      output: string
      tail: string
      exitCode: number | null
      durationMs: number | null
      expanded: boolean
    }
  /** 待办：平时一行（做到第几步、正在做哪一步），点开在原处展开整份；最近那份另在输入框上方有个小按钮 */
  | {
      type: 'todo'
      key: string
      turnId: string
      note: string | null
      steps: TodoStep[]
      running: boolean
      expanded: boolean
    }
  | { type: 'notice'; key: string; label: Text; detail: string | null }
  /** 上下文压缩：一条分隔线，不进过程组（照桌面端）。startedAt：这边看着它开始的时刻，压久了多写一句 */
  | {
      type: 'compaction'
      key: string
      status: CompactionItem['status']
      source: CompactionItem['source']
      startedAt: number | null
    }
  /**
   * 达成目标的那一轮：最后一条回答下面一行“目标已达成 · 用时 N”（核心的 goalReachedIn 定写不写）。
   * ms 是目标一共用了多久
   */
  | { type: 'goalReached'; key: string; turnId: string; ms: number; objective: string }
  /** 失败的回合带着的原因，排在状态行上面。被打断的回合不画（照桌面端） */
  | { type: 'error'; key: string; text: string }
  | {
      type: 'status'
      key: string
      turnId: string
      status: TurnView['status']
      durationMs: number | null
      /** 回合开始的时刻：“正在工作”后面写已经用了多久。对面没给是 null */
      startedAt: number | null
      /** 回合在跑、没有正文在出字、没有等人答复（核心的 workingShown）：这时写“正在工作”，别的时候留空 */
      working: boolean
      /** 回合在跑、模型请求在重试：状态行照写“正在工作”，后面接第几次和原因 */
      retry: TurnRetryView | null
      recovery?: TurnView['recovery']
    }

interface ItemCache {
  chunks: ChunkState
  text: string | null
}

/** 步骤组里的一条：一步，或者一段思考（照桌面端，思考是组里的一步，不把组断开） */
type GroupItem = StepItem | ReasoningItem

const GROUP_KINDS = new Set<ItemView['kind']>([
  'command',
  'fileChange',
  'toolCall',
  'webSearch',
  'notice',
  'reasoning',
])

const isGroupItem = (item: ItemView): item is GroupItem => GROUP_KINDS.has(item.kind)

const isRunning = (item: GroupItem): boolean =>
  item.kind === 'reasoning' ? item.status === 'inProgress' : stateOf(item) === 'running'

const NO_ACTIONS: readonly { label: string; message?: string }[] = []

/** 一个会话的行。跟着视图一起活，记着各条目切到哪了、上一次给出的行对象 */
export class RowBuilder {
  private readonly items = new Map<string, ItemCache>()
  private readonly rows = new Map<string, Row>()
  private readonly turnRows = new Map<string, Row[]>()
  /** 展开着的：过程组（组的键）、某一步（步的键）、思考（条目标识） */
  readonly expanded = new Set<string>()
  /** 手动展开过的键（收起了也留着）：回合里展开过某一组、某一步、某段思考，告一段落时不自动收起整段过程（照桌面端） */
  private readonly touched = new Set<string>()
  /** 点过的过程段：点成了开还是关（没点过的按 processFolded 自动定） */
  private readonly processOpen = new Map<string, boolean>()
  /** 上一次给出的过程段开没开着：点那一行时从它翻 */
  private readonly processShown = new Map<string, boolean>()

  /** 展开或收起一样东西。key 是整段过程那一行（`回合:process`）时翻它的开关，别的进出 expanded */
  toggle(key: string, turnId: string): void {
    if (key === `${turnId}:process` || key.startsWith(`${turnId}:process:`)) {
      this.processOpen.set(key, !(this.processShown.get(key) ?? false))
      return
    }
    if (this.expanded.delete(key)) return
    this.expanded.add(key)
    this.touched.add(key)
  }

  /** 这个回合里的组、步、思考有没有被手动展开过（待办、别的会话发来的消息展开了不算） */
  private touchedIn(turn: TurnView, items: ItemView[]): boolean {
    return items.some(
      (item) =>
        this.touched.has(`${turn.id}:p:${item.id}`) ||
        this.touched.has(`s:${item.id}`) ||
        (item.kind === 'reasoning' && this.touched.has(item.id)),
    )
  }

  /** 重算这些回合的行，其余的照旧；返回从旧到新的全部行 */
  build(view: SessionView, dirtyTurns: Set<string> | 'all'): Row[] {
    const all: Row[] = []
    if (view.forkedFrom)
      all.push(this.keep({ type: 'forked', key: 'forked', from: view.forkedFrom }))
    const alive = new Set<string>()
    for (const turn of view.turns) {
      alive.add(turn.id)
      let rows = this.turnRows.get(turn.id)
      if (!rows || dirtyTurns === 'all' || dirtyTurns.has(turn.id)) {
        rows = this.buildTurn(view, turn)
        this.turnRows.set(turn.id, rows)
      }
      for (const row of rows) all.push(row)
    }
    for (const id of [...this.turnRows.keys()]) if (!alive.has(id)) this.turnRows.delete(id)
    return all
  }

  private buildTurn(view: SessionView, turn: TurnView): Row[] {
    const out: Row[] = []
    const running = turn.status === 'running'
    const items = turn.itemIds.flatMap((id) => {
      const item = view.items[id]
      return item ? [item] : []
    })
    // 分块和桌面端是同一份（核心的 bucketItems）：过程里说明、步骤组、启动子代理那一行按时间排，思考是步骤组里的一步
    const blocks = bucketItems(
      items.map((item) => blockInput(item.id, item)),
      { turnRunning: running },
    )
    const first = items[0]
    // 提醒收尾的回合对用户透明（照桌面端）：那是设备进程替用户提醒模型补调一次收尾，提醒、模型顺口说的话、过程、
    // 状态行都不画，只留收尾带出来的卡片和问题（bucketItems 只给它留这些）
    const remind = first?.kind === 'userMessage' && first.event?.kind === 'remind'
    // 别的会话发来消息、定时任务开的回合：开头那条消息自己写着来源，不再另写一行
    if (turn.origin && turn.origin !== 'peer' && turn.origin !== 'schedule' && !remind)
      out.push(
        this.keep({
          type: 'origin',
          key: `${turn.id}:origin`,
          turnId: turn.id,
          origin: turn.origin,
          startedAt: turn.startedAt,
        }),
      )
    /** 这一回合里协作条目最后报的各个子代理的状态：有启动子代理的那一行时才算 */
    let reported: Map<string, AgentState> | null = null
    const reportedOf = () => {
      reported ??= agentStatesOf(items)
      return reported
    }
    // 整段过程告一段落（有最终回答、没被打断，规矩在核心的 processSettled）就收成一行，照桌面端：用户在这一回合里点开过某一组、某一步，
    // 或者还有子代理没做完时不自动收。点那一行翻转（expanded 里有它的键就和自动的相反）
    const answerId = blocks.find((block) => block.type === 'answer')?.itemId
    const answer = answerId ? view.items[answerId] : undefined
    const settled = processSettled(turn.status, answer ? [answer] : [], view.can.finalOnStart)
    const segments = processSegments(blocks)
    const firstSegment = segments.values().next().value
    const divided = items.some((item) => item.kind === 'userMessage' && turnAddition(turn, item.id))
    const autoOpen = !processFolded(
      settled,
      this.touchedIn(turn, items),
      agentsUnfinished(items, view.agents),
    )
    /** 最后一条回答的末尾在 out 里的位置：目标达成那一句插在这里 */
    let answerEnd = -1
    blocks.forEach((block) => {
      switch (block.type) {
        case 'user':
          this.userRows(out, turn, view, view.items[block.itemId])
          return
        case 'answer':
        case 'plan': {
          const item = view.items[block.itemId]
          if (item?.kind !== 'agentMessage' && item?.kind !== 'plan') return
          // 计划条目没有自己的状态：回合在跑就当它还在长
          const live = item.kind === 'plan' ? running : item.status === 'inProgress'
          out.push(...this.markdown(turn.id, item.id, item.text, live, item.kind === 'plan'))
          if (block.type === 'answer') answerEnd = out.length
          return
        }
        case 'todo': {
          const item = view.items[block.itemId]
          if (item?.kind !== 'todo') return
          out.push(
            this.keep({
              type: 'todo',
              key: item.id,
              turnId: turn.id,
              note: item.note,
              steps: item.steps,
              running,
              expanded: this.expanded.has(item.id),
            }),
          )
          return
        }
        case 'compaction': {
          const item = view.items[block.itemId]
          if (item?.kind !== 'compaction') return
          out.push(
            this.keep({
              type: 'compaction',
              key: item.id,
              status: item.status,
              source: item.source,
              startedAt: item.span?.from ?? null,
            }),
          )
          return
        }
        case 'card':
          this.outside(out, turn, view, block.itemId)
          return
        case 'notes':
          for (const id of block.itemIds) {
            const item = view.items[id]
            if (item?.kind === 'notice') out.push(this.notice(item))
          }
          return
        case 'tail':
          // 收尾区排在回合最后（下面单独排）
          return
        case 'process': {
          const segment = segments.get(block.key)!
          const processKey =
            segment === firstSegment ? `${turn.id}:process` : `${turn.id}:process:${segment.key}`
          const open = this.processOpen.get(processKey) ?? autoOpen
          if (settled) this.processShown.set(processKey, open)
          if (settled && block.key === segment.key)
            out.push(this.process(view, turn, processKey, open, segment.itemIds, divided))
          // 每段只在自己的第一块过程处显示摘要，开关互不影响。
          if (settled && !open) return
          for (const part of block.parts) this.part(out, view, turn, part, reportedOf)
          return
        }
      }
    })
    const reachedMs = goalReachedIn(view.goalReached, turn)
    if (reachedMs !== null && view.goalReached && answerEnd >= 0)
      out.splice(
        answerEnd,
        0,
        this.keep({
          type: 'goalReached',
          key: `${turn.id}:goal`,
          turnId: turn.id,
          ms: reachedMs,
          objective: view.goalReached.objective,
        }),
      )
    // 回合最下方的收尾区：收尾留的问题（最后一个）在前，收尾带的建议卡片在后（核心等回合结束才排进来）
    const tail = blocks.find((block) => block.type === 'tail')
    if (tail) out.push(...this.tail(view, turn, tail.itemIds))
    if (remind) return out
    if (turn.status === 'failed' && turn.error)
      out.push(this.keep({ type: 'error', key: `${turn.id}:error`, text: turn.error }))
    out.push(
      this.keep({
        type: 'status',
        key: `${turn.id}:status`,
        turnId: turn.id,
        status: turn.status,
        durationMs: turn.durationMs,
        startedAt: turn.startedAt,
        working: running && workingShown(running, items, view.requests.length),
        retry: running ? (turn.retry ?? null) : null,
        recovery: running ? (turn.recovery ?? null) : null,
      }),
    )
    return out
  }

  /** 回合开头（或插进来）的那条用户消息：设备进程注入的提示、系统卡片、用户气泡 */
  private userRows(
    out: Row[],
    turn: TurnView,
    view: SessionView,
    item: ItemView | undefined,
  ): void {
    if (item?.kind !== 'userMessage') return
    if (item.event)
      out.push(
        this.keep({
          type: 'event',
          key: `${item.id}:event`,
          turnId: turn.id,
          kind: eventKind(item.event),
          notes: item.event.notes,
          ...(item.event.body ? { body: item.event.body } : {}),
          ...(item.event.summary ? { summary: item.event.summary } : {}),
        }),
      )
    if (item.system)
      out.push(
        this.keep({
          type: 'system',
          key: item.id,
          turnId: turn.id,
          text: item.text,
          system: item.system,
          expanded: this.expanded.has(item.id),
        }),
      )
    // 唤醒、提醒的回合没有用户自己说的话：只有上面那条提示。
    // 整段是一份答复、问题那一条都还在会话里的：答案并进问题卡（AskSheet），不另画气泡
    else if (
      (item.text || item.attachments.length > 0 || !item.event) &&
      !(item.attachments.length === 0 && foldedReply(view, item.text, item.peer !== undefined))
    )
      out.push(
        this.keep({
          type: 'user',
          key: item.id,
          turnId: turn.id,
          text: item.text,
          attachments: item.attachments,
          ...(turnAddition(turn, item.id) ? { addition: true } : {}),
          ...(item.peer ? { peer: item.peer, expanded: this.expanded.has(item.id) } : {}),
          ...(item.sessions ? { sessions: item.sessions } : {}),
          ...(!turnAddition(turn, item.id) && turn.startedAt !== null
            ? { sentAt: turn.startedAt }
            : {}),
        }),
      )
  }

  /** 露在过程外面的卡片：带题的助手消息、问用户的工具、start 派出的子会话和提的提案、offer 卡 */
  private outside(out: Row[], turn: TurnView, view: SessionView, itemId: string): void {
    const item = view.items[itemId]
    if (item?.kind === 'agentMessage') {
      out.push(...this.markdown(turn.id, item.id, item.text, item.status === 'inProgress', false))
      return
    }
    if (item?.kind !== 'toolCall') return
    if (item.asked) {
      out.push(this.keep({ type: 'asked', key: `${item.id}:asked`, turnId: turn.id, item }))
      return
    }
    const cards = cardsOf(item, view.proposals)
    // start 直接派出的子会话：没有提案卡，照一步画
    if (cards) out.push(...this.proposals(turn, item, cards))
    else this.pushGroup(out, turn, [item])
  }

  private proposals(
    turn: TurnView,
    item: ToolCallItem,
    cards: (SessionProposalView | null)[],
  ): Row[] {
    const offer = isOfferCall(item)
    return cards.map((proposal) =>
      this.keep<Row>({
        type: 'proposal',
        key: `${item.id}:${proposal?.id ?? 'call'}`,
        turnId: turn.id,
        itemId: item.id,
        proposal,
        spawned: item.spawned ?? null,
        offer,
      }),
    )
  }

  /** 回合最下方的收尾区：收尾问题的答复记录在前，建议卡片在后。 */
  private tail(view: SessionView, turn: TurnView, itemIds: string[]): Row[] {
    const asks: Row[] = []
    const cards: Row[] = []
    for (const id of itemIds) {
      const item = view.items[id]
      if (item?.kind !== 'toolCall') continue
      cards.push(...this.proposals(turn, item, cardsOf(item, view.proposals) ?? []))
      if (item.wrapUp?.ask)
        asks.push(
          this.keep({
            type: 'wrapAsk',
            ...(item.questionSource ? { questionSource: item.questionSource } : {}),
            key: `${item.id}:ask`,
            turnId: turn.id,
            itemId: item.id,
            ask: item.wrapUp.ask,
            actions: item.wrapUp.actions ?? NO_ACTIONS,
          }),
        )
    }
    return [...asks, ...cards]
  }

  /** 整段过程告一段落后收成的那一行（照桌面端的收起行）：几段说明、几步、几个子代理，被拒、失败的子代理、回合出错 */
  private process(
    view: SessionView,
    turn: TurnView,
    key: string,
    open: boolean,
    ids: string[],
    divided: boolean,
  ): Row {
    const tally = processTally(
      ids.flatMap((id) => {
        const item = view.items[id]
        return item ? [item] : []
      }),
      view.agents,
    )
    return this.keep({
      type: 'process',
      key,
      turnId: turn.id,
      expanded: open,
      notes: tally.notes,
      steps: tally.steps,
      agents: tally.agents,
      declined: tally.declined,
      agentsFailed: tally.agentsFailed,
      status: turn.status,
      durationMs: processDuration(
        turn,
        ids.flatMap((id) => view.items[id] ?? []),
        divided,
      ),
      ids: ids.join(' '),
    })
  }

  /** 过程里的一段：说明按正文画，启动子代理那一行，步骤组 */
  private part(
    out: Row[],
    view: SessionView,
    turn: TurnView,
    part: ProcessPart,
    reported: () => Map<string, AgentState>,
  ): void {
    if (part.type === 'note') {
      const item = view.items[part.itemId]
      if (item?.kind === 'agentMessage')
        out.push(...this.markdown(turn.id, item.id, item.text, item.status === 'inProgress', false))
      return
    }
    if (part.type === 'card') {
      const item = view.items[part.itemId]
      if (item?.kind === 'toolCall') out.push(this.agents(turn.id, item, view.agents, reported()))
      return
    }
    // 交接（hand_off）单独一行，把步骤组从它那里断开
    let steps: GroupItem[] = []
    const flush = () => {
      if (steps.length > 0) this.steps(out, turn, steps)
      steps = []
    }
    for (const id of part.itemIds) {
      const item = view.items[id]
      if (!item) continue
      const handOff = item.kind === 'toolCall' ? handOffOf(item) : null
      if (handOff && item.kind === 'toolCall') {
        flush()
        out.push(
          this.keep({
            type: 'handoff',
            key: `${item.id}:handoff`,
            turnId: turn.id,
            itemId: item.id,
            title: handOff.title,
            threadId: handOff.threadId,
            running: item.status === 'inProgress',
          }),
        )
      } else if (isGroupItem(item)) steps.push(item)
    }
    flush()
  }

  /**
   * 一个步骤组（照桌面端的 Steps）：思考是组里的一步。没字的思考不画；只剩有字的思考时不收成摘要，每条一行；
   * 只有说明的一组也不折叠（一两行字，折起来反而要多点一下）
   */
  private steps(out: Row[], turn: TurnView, items: GroupItem[]): void {
    const live = turn.status === 'running'
    const current = live ? items.findLast(isRunning) : undefined
    const shown = items.filter(thoughtShown)
    if (!current && shown.length === 0) return
    if (!current && shown.every((item) => item.kind === 'reasoning')) {
      for (const item of shown) if (item.kind === 'reasoning') out.push(this.reasoning(turn, item))
      return
    }
    if (shown.every((item) => item.kind === 'notice')) {
      for (const item of shown) if (item.kind === 'notice') out.push(this.notice(item))
      return
    }
    this.pushGroup(out, turn, shown)
  }

  private reasoning(turn: TurnView, item: ReasoningItem): Row {
    const expanded = this.expanded.has(item.id)
    return this.keep({
      type: 'reasoning',
      key: item.id,
      turnId: turn.id,
      text: expanded ? item.text.trim() : lastLine(item.text),
      expanded,
    })
  }

  /** 一组过程：先是摘要，展开时下面是每一步（从旧到新），最后一行“收起”（倒置之后摘要在最上面，照桌面端往下展开） */
  private pushGroup(out: Row[], turn: TurnView, items: GroupItem[]): void {
    const key = `${turn.id}:p:${items[0]?.id}`
    const expanded = this.expanded.has(key)
    let count = 0
    let failed = 0
    let current: Text | null = null
    let thinking = false
    const shown: Row[] = []
    for (const item of items) {
      if (item.kind === 'reasoning') {
        // 思考不算步数；在想的时候摘要上写它的第一行
        if (item.status === 'inProgress' && turn.status === 'running') {
          current = item.text.trim().split('\n', 1)[0] ?? ''
          thinking = true
        }
        if (expanded) shown.push(this.reasoning(turn, item))
        continue
      }
      count++
      const state = stateOf(item)
      if (state === 'failed') failed++
      if (state === 'running' && turn.status === 'running') {
        current = labelOf(item)
        thinking = false
      }
      if (!expanded) continue
      const command = item.kind === 'command' ? item : null
      const stepKey = `s:${item.id}`
      shown.push(
        this.keep({
          type: 'step',
          key: stepKey,
          turnId: turn.id,
          item,
          state,
          output: command?.output ?? '',
          tail: command?.elided?.tail ?? '',
          exitCode: command?.exitCode ?? null,
          durationMs: command?.durationMs ?? (item.kind === 'toolCall' ? item.durationMs : null),
          expanded: this.expanded.has(stepKey),
        }),
      )
    }
    out.push(
      this.keep({
        type: 'group',
        key,
        turnId: turn.id,
        count,
        failed,
        durationMs: spanOf(items),
        current,
        thinking,
        since: current === null ? null : spanFrom(items),
        running: current !== null,
        expanded,
        ids: items.map((item) => item.id).join(' '),
        ended: turn.status !== 'running',
      }),
    )
    if (!expanded) return
    out.push(...shown)
    out.push(this.keep({ type: 'groupEnd', key: `${key}:end`, turnId: turn.id, group: key }))
  }

  /** 启动子代理的那一次调用：每个子代理现在的状态按核心的 agentRunState 取（见行的说明） */
  private agents(
    turnId: string,
    item: ToolCallItem,
    threads: AgentThreadView[],
    reported: Map<string, AgentState>,
  ): Row {
    const states = (item.agents ?? []).map((agent) =>
      agentRunState(
        threads.find((thread) => thread.id === agent.threadId),
        reported.get(agent.threadId),
        agent.state,
      ),
    )
    return this.keep({
      type: 'agents',
      key: `${item.id}:agents`,
      turnId,
      item,
      threads,
      states: states.join(' '),
    })
  }

  private notice(item: NoticeItem): Row {
    return this.keep({ type: 'notice', key: item.id, label: item.label, detail: item.detail })
  }

  private markdown(
    turnId: string,
    itemId: string,
    text: string,
    open: boolean,
    plan: boolean,
  ): Row[] {
    let cache = this.items.get(itemId)
    if (!cache) {
      cache = { chunks: emptyChunks(), text: null }
      this.items.set(itemId, cache)
    }
    const chunks = chunkText(cache.chunks, text, cache.text, open)
    cache.text = text
    return chunks.map((chunk) =>
      this.keep({
        type: 'md',
        key: `${itemId}:${chunk.index}`,
        turnId,
        itemId,
        text: chunk.text,
        open: chunk.open,
        live: open,
        plan,
        first: chunk.index === 0,
      }),
    )
  }

  /** 和上一次给出的同一个键的行一样，就还用上一次的对象 */
  private keep<R extends Row>(row: R): R {
    const previous = this.rows.get(row.key)
    if (previous && sameRow(previous, row)) return previous as R
    this.rows.set(row.key, row)
    return row
  }
}

/** 同一种行的各项逐个比：字和数比值，条目、数组比引用（核心换掉条目时它们才换） */
function sameRow(a: Row, b: Row): boolean {
  if (a.type !== b.type) return false
  const left = a as unknown as Record<string, unknown>
  const right = b as unknown as Record<string, unknown>
  for (const key in left) if (left[key] !== right[key]) return false
  return true
}

function stateOf(item: StepItem): StepState {
  if (item.kind === 'webSearch' || item.kind === 'notice') return 'done'
  switch (item.status) {
    case 'inProgress':
      return 'running'
    case 'completed':
      // 命令跑完了但退出码不是 0，也算没成
      return item.kind === 'command' && item.exitCode !== null && item.exitCode !== 0
        ? 'failed'
        : 'done'
    case 'declined':
      return 'declined'
    default:
      return 'failed'
  }
}

/** 一步说的是什么：摘要上“正在运行”后面那段 */
export function labelOf(item: StepItem): Text {
  switch (item.kind) {
    case 'command':
      return item.command
    case 'fileChange':
      return item.changes.map((change) => change.path).join(', ')
    case 'toolCall':
      return item.tool
    case 'webSearch':
      return item.query
    case 'notice':
      return item.label
  }
}

const lastLine = (text: string): string => {
  const lines = text.trim().split('\n')
  return lines[lines.length - 1] ?? ''
}

/** 整段是一份答复，答的题都还在会话里（问题卡上画得出答案） */
function foldedReply(view: SessionView, text: string, peer: boolean): boolean {
  if (peer) return false
  const replies = parseAskReply(text)
  return (
    replies?.every((reply) => {
      const itemId = questionItemOf(reply.questionItemId)
      return itemId !== null && view.items[itemId] !== undefined
    }) === true
  )
}
