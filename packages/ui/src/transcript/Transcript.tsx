import type { SearchHit } from '@litch/core'
import { HistoryStatus, useOlderHistory } from './history.tsx'
import { SearchPanel } from './search/SearchPanel.tsx'
import { searchWindow } from './turn-window.ts'
import '../styles/search.css'
import {
  type Block,
  blockInput,
  bucketItems,
  type DeviceView,
  type ItemView,
  keys,
  type ProcessSegment,
  processFolded,
  processSegments,
  processSettled,
  type RequestView,
  type SessionMeta,
  type SessionSummary,
  type Text,
  type TurnStatus,
  type TurnView,
  turnAddition,
  visibleProcessParts,
  workingShown,
} from '@litch/core'
import {
  Component,
  Fragment,
  memo,
  type ReactNode,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useT } from '../app/appearance.ts'
import { useElapsed } from '../app/clock.ts'
import { downHarness, downText, nameOf } from '../app/device.ts'
import { duration, elapsed, retryText, turnEnded } from '../app/format.ts'
import { currentPlatform } from '../app/platform.ts'
import { useKey, useServices } from '../app/services.tsx'
import { TurnOrigin } from '../background/TurnOrigin.tsx'
import { ChildRequests, DelegatedHistory } from '../composer/ChildRequests.tsx'
import { Dock, Requests } from '../composer/Dock.tsx'
import { PendingQuestions } from '../composer/PendingQuestions.tsx'
import { GoalReached } from '../goal/GoalReached.tsx'
import type { MessageKey, Translator } from '../i18n/index.ts'
import { useRailHasTodo } from '../rail/rail-state.ts'
import { onFind, onFindPreparing, requestFind } from '../search/actions.ts'
import { TaskNote } from '../tasks/TaskNote.tsx'
import { useAgentsUnfinished } from '../tree/agent-view.tsx'
import { LineageBar } from '../tree/LineageBar.tsx'
import { TreeCard } from '../tree/TreeCards.tsx'
import { TurnTail } from '../tree/TurnTail.tsx'
import { ActionsProvider } from './actions.tsx'
import { Compaction, Notes, RestartNote } from './activity.tsx'
import { CiteScope } from './comments/Cite.tsx'
import { CommentLayer } from './comments/Layer.tsx'
import { FileLinksProvider, useSessionFileLinks } from './FileLinks.tsx'
import { ManagerReferencesScope } from './ManagerReferences.tsx'
import { AgentAnswer, AnswerCopy, PlanCard, UserMessage } from './messages.tsx'
import { ProcessHead, ProcessParts } from './process.tsx'
import { Recovery } from './Recovery.tsx'
import { Stamp } from './Stamp.tsx'
import { PinProvider, savedFindRoom, savedTurns, useTranscriptScroll } from './scroll.ts'
import { TurnTouch, touchTurn, useFold, useToggle, useTurnTouched } from './state.ts'
import { TodoCard } from './Todo.tsx'
import { FIRST_TURNS, growWindow, restoreWindow, WINDOWED_TURNS } from './turn-window.ts'
import { useTranscriptView } from './view.ts'

interface SessionRef {
  deviceId: string
  sessionId: string
}

interface TurnBlocks {
  blocks: Block[]
  /** 设备进程提醒收尾的回合（开头是 event.kind 为 remind 的用户消息） */
  remind: boolean
  /** 回合结束后按全部回答判断是否收起过程。 */
  answerIds: string[]
  /** 每块过程所属的段，同段共用摘要与开关。 */
  segments: Map<string, ProcessSegment>
}

/**
 * 把一个回合的条目分成块。条目的种类、卡片与否只看开始时就有的东西，所以只在标识的列表变化时重算；
 * 助手消息的阶段要到写完才定（声明了 agentMessagePhase: onCompleted 的 harness），回合结束时再算一遍，
 * 让最后认作最终回答的那一条落定；收尾带的卡片和问题也在这时进收尾区（回合在跑时先不画，见核心的 bucketItems）
 */
function useBlocks(
  { deviceId, sessionId }: SessionRef,
  itemIds: string[],
  status: TurnView['status'] | undefined,
): TurnBlocks {
  const { store } = useServices().replica
  return useMemo(() => {
    const inputs = []
    for (const id of itemIds) {
      const item = store.get<ItemView>(keys.item(deviceId, sessionId, id))
      if (item) inputs.push(blockInput(id, item))
    }
    const blocks = bucketItems(inputs, { turnRunning: status === 'running' })
    return {
      blocks,
      remind: inputs[0] !== undefined && 'remind' in inputs[0] && inputs[0].remind,
      answerIds: blocks.filter((block) => block.type === 'answer').map((block) => block.itemId),
      segments: processSegments(blocks),
    }
  }, [store, deviceId, sessionId, itemIds, status])
}

/**
 * 每段分别判断，订阅本段条目的结束状态；文字增量不改变布尔值，不引起整段重画。
 */
function useSettled(
  ref: SessionRef,
  status: TurnStatus | undefined,
  answerIds: string[],
  segment: ProcessSegment,
): boolean {
  const { store } = useServices().replica
  const { deviceId, sessionId } = ref
  const ids = status === 'running' ? segment.answerIds : answerIds
  const itemKeys = useMemo(() => {
    // 活跃的最后一段必定展开，无需随每个文本增量扫描整段历史。
    if (status === 'running' && !segment.closed) return []
    return (status === 'running' ? [...segment.itemIds, ...ids] : ids).map((id) =>
      keys.item(deviceId, sessionId, id),
    )
  }, [deviceId, sessionId, status, segment, ids])
  const subscribe = useCallback(
    (listener: () => void) => {
      const offs = itemKeys.map((key) => store.subscribe(key, listener))
      return () => {
        for (const off of offs) off()
      }
    },
    [store, itemKeys],
  )
  return useSyncExternalStore(subscribe, () => {
    if (status === 'running' && !segment.closed) return false
    const read = (id: string) => store.get<ItemView>(keys.item(deviceId, sessionId, id))
    const answers = ids.map(read).filter((item): item is ItemView => item !== undefined)
    const items = segment.itemIds.map(read).filter((item): item is ItemView => item !== undefined)
    return processSettled(status ?? 'running', answers, { closed: segment.closed, items })
  })
}

/**
 * 回合末尾那一行“正在工作”此刻该不该出（规矩在核心的 workingShown：只在正文出字、等人答复时让开）。
 * 订阅回合里的每一条条目和待答的请求；结果是个布尔值，字在长而结论没变时不引起重画。回合不在跑时什么都不订阅
 */
function useWorking(ref: SessionRef, running: boolean, itemIds: string[]): boolean {
  const { store } = useServices().replica
  const { deviceId, sessionId } = ref
  const itemKeys = useMemo(
    () => itemIds.map((itemId) => keys.item(deviceId, sessionId, itemId)),
    [deviceId, sessionId, itemIds],
  )
  const requestsKey = keys.requests(deviceId, sessionId)
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!running) return () => {}
      const offs = [...itemKeys, requestsKey].map((key) => store.subscribe(key, listener))
      return () => {
        for (const off of offs) off()
      }
    },
    [store, itemKeys, requestsKey, running],
  )
  return useSyncExternalStore(
    subscribe,
    () =>
      running &&
      workingShown(
        running,
        itemKeys.map((key) => store.get<ItemView>(key)),
        store.get<RequestView[]>(requestsKey)?.length ?? 0,
      ),
  )
}

/** 让开之后要持续 WORKING_DELAY_MS 才再显出：两段正文挨着出字时不跟着闪一下，出完字又不至于迟迟不出来 */
const WORKING_DELAY_MS = 300

function useLasting(on: boolean, ms: number): boolean {
  const [lasted, setLasted] = useState(false)
  useEffect(() => {
    setLasted(false)
    if (!on) return
    const timer = window.setTimeout(() => setLasted(true), ms)
    return () => window.clearTimeout(timer)
  }, [on, ms])
  return on && lasted
}

/** 一个回合画坏了不连累别的回合 */
class TurnBoundary extends Component<
  { children: ReactNode; label: string },
  { error: Error | null }
> {
  override state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  override render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="errbox">
        <span>{this.props.label}</span>
        <span className="mono">{this.state.error.message}</span>
      </div>
    )
  }
}

/** 读会话没成时核心留下的那个错误 */
type SessionFailure = { code?: string; message: string; text?: Text }

const NO_ITEMS: string[] = []

/** 同段过程块共用开关；插话两侧各自展开，条目节点的位置和键保持稳定。 */
function SegmentBlock({
  turn,
  block,
  segment,
  first,
  divided,
  answerIds,
  touched,
  agentsRunning,
  userId,
  ...ref
}: SessionRef & {
  turn: TurnView
  block: Extract<Block, { type: 'process' }>
  segment: ProcessSegment
  first: boolean
  divided: boolean
  answerIds: string[]
  touched: boolean
  agentsRunning: boolean
  userId: string | undefined
}) {
  const settled = useSettled(ref, turn.status, answerIds, segment)
  const autoOpen = !processFolded(settled, touched, agentsRunning)
  const foldKey = first ? `p:${turn.id}` : `p:${turn.id}:${segment.key}`
  const [open, setOpen] = useFold(`${ref.deviceId}:${ref.sessionId}`, foldKey, autoOpen)
  const head = block.key === segment.key
  const parts = visibleProcessParts(block.parts, settled && !open, segment.keepSteps)
  if (parts.length === 0 && !head) return null
  return (
    <div className={settled ? 'proc' : 'proc live'}>
      {settled && head ? (
        <ProcessHead
          {...ref}
          turn={turn}
          itemIds={segment.itemIds}
          anchor={foldKey}
          divided={divided}
          open={open}
          onToggle={setOpen}
        />
      ) : null}
      {parts.length === 0 ? null : (
        <div className="proc-body">
          <CiteScope {...ref} userId={userId}>
            <ProcessParts {...ref} parts={parts} live={turn.status === 'running'} />
          </CiteScope>
        </div>
      )}
    </div>
  )
}

const TURN_END: Record<Exclude<TurnView['status'], 'running'>, MessageKey> = {
  failed: 'turn.failed',
  interrupted: 'turn.interrupted',
  completed: 'turn.completed',
}

/** 读会话失败时给人看的原因：核心说得出是哪一句的说那一句，设备那头报的错原样给，别的按错误码说 */
function failureText(failure: SessionFailure, t: Translator): string {
  if (failure.text) return t.text(failure.text)
  if (failure.code === 'timeout') return t('error.timeout')
  if (failure.code === 'offline') return t('error.offline')
  if (failure.code === 'cancelled') return t('error.cancelled')
  return failure.code === 'remote' && failure.message ? failure.message : t('error.other')
}

const Turn = memo(function Turn({
  deviceId,
  sessionId,
  turnId,
  kept,
}: SessionRef & { turnId: string; kept: boolean }) {
  const turn = useKey<TurnView>(keys.turn(deviceId, sessionId, turnId))
  const meta = useKey<SessionMeta>(keys.session(deviceId, sessionId))
  const device = useKey<DeviceView>(keys.device(deviceId))
  const t = useT()
  const ref = useMemo(() => ({ deviceId, sessionId }), [deviceId, sessionId])
  const sessionKey = `${deviceId}:${sessionId}`
  const running = turn?.status === 'running'
  // 回合结束的时刻（开始加用时），结尾那一行写在用时后面
  const ended = turn ? turnEnded(turn) : null
  const { blocks, remind, answerIds, segments } = useBlocks(ref, turn?.itemIds ?? [], turn?.status)
  const working = useLasting(useWorking(ref, running, turn?.itemIds ?? NO_ITEMS), WORKING_DELAY_MS)
  // 模型请求在重试：状态行一直显出，后面写第几次和原因，重试结束（新一次出字）就去掉
  const retry = running ? (turn?.retry ?? null) : null
  const touched = useTurnTouched(sessionKey, turnId)
  // 待办在右边的信息栏里时，对话里不再画一遍
  const [searchTodo] = useToggle(sessionKey, `search-todo:${turnId}`, false)
  const todoInRail = useRailHasTodo(sessionKey) && !searchTodo
  // 回合里还有没做完的子代理时不自动收（状态以子线程为准，见 tree/agent-view.tsx）
  const agentsRunning = useAgentsUnfinished(deviceId, sessionId, turnId)
  // 详细视图里点开什么都不算“手动展开过”：切回精简时照常自动收
  const verbose = useTranscriptView(sessionKey) === 'verbose'
  const touch = useCallback(() => {
    if (!verbose) touchTurn(sessionKey, turnId)
  }, [sessionKey, turnId, verbose])
  // 收尾区是看着回合结束才出来的（这里见过它在跑、在跑时还没有收尾区）：滑进来，读历史、滚回来时不动
  const seen = useRef({ running: false, tail: false })
  const hasTail = blocks.some((block) => block.type === 'tail')
  if (running) seen.current = { running: true, tail: seen.current.tail || hasTail }
  const freshTail = !running && seen.current.running && !seen.current.tail
  // 提醒收尾的回合对用户透明（核心的 bucketItems 只给它留卡片）：没有卡片就整个不画，有卡片也不画开头、用时和结尾
  if (!turn || (remind && blocks.length === 0)) return null
  // 告一段落之后，每段的第一块过程显示摘要；没告一段落时过程照常摊开。
  const firstSegment = segments.values().next().value
  const divided = blocks.some((block) => block.type === 'user' && turnAddition(turn, block.itemId))
  const tail = blocks.find((block) => block.type === 'tail')
  const lastAnswer = blocks.findLastIndex((block) => block.type === 'answer')
  const footerAnswer = !running && !remind ? blocks[lastAnswer] : undefined
  // 每一块前面最近的那条用户消息：它带着评论的话，回答里的 [N] 指向它的评论（comments/Cite.tsx）
  const userBefore = blocks.map(
    (_, index) =>
      blocks.findLast(
        (block, at): block is Extract<Block, { type: 'user' }> =>
          at < index && block.type === 'user',
      )?.itemId,
  )
  // 分叉、回退挂在用户消息上：回合开头那条按回合切，后面插进来的话切在它之前（harness 会切在回合中间才出，
  // TurnActions 里判断）。是不是插进来的按它在回合条目里的位置认，和核心一样：不画出来的条目（续做回合开头那句）
  // 也算数，插进来的话不会被当成回合开头、点了退掉整个回合。回合结束了、会话能发消息、设备连着、它所属的 harness 可用才出
  const actable =
    !running &&
    meta?.live === true &&
    device?.connection === 'online' &&
    !downHarness(device, meta.harness)
  return (
    <TurnTouch.Provider value={touch}>
      <section className="turn" data-search-turn={turnId} data-search-keep={kept ? '' : undefined}>
        {/* 后台任务结束后、目标续跑时 harness 自己开的回合：开头一行写怎么来的 */}
        {/* 别的会话发来消息、定时任务开的回合：开头那条消息（来自 X 的消息、定时任务卡片）自己写着来源，不再另写一行 */}
        {turn.origin && turn.origin !== 'peer' && turn.origin !== 'schedule' && !remind ? (
          <TurnOrigin
            deviceId={deviceId}
            sessionId={sessionId}
            turn={{ ...turn, origin: turn.origin }}
          />
        ) : null}
        {blocks.map((block, index) => {
          if (block.type === 'user')
            return (
              <UserMessage
                key={block.itemId}
                {...ref}
                itemId={block.itemId}
                turn={turn}
                turnId={actable ? turnId : undefined}
                steered={turn.itemIds.indexOf(block.itemId) > 0}
              />
            )
          if (block.type === 'answer')
            return (
              <Fragment key={block.itemId}>
                <CiteScope {...ref} userId={userBefore[index]}>
                  <AgentAnswer {...ref} itemId={block.itemId} footerCopy={block === footerAnswer} />
                </CiteScope>
                {/* 达成目标的那一轮：最后一条回答下面写用了多久（目标随即清掉） */}
                {index === lastAnswer && !running ? <GoalReached {...ref} turn={turn} /> : null}
              </Fragment>
            )
          if (block.type === 'plan')
            return <PlanCard key={block.itemId} {...ref} itemId={block.itemId} />
          if (block.type === 'todo')
            return todoInRail ? null : (
              <TodoCard key={block.itemId} {...ref} itemId={block.itemId} />
            )
          if (block.type === 'card')
            return <TreeCard key={block.itemId} {...ref} itemId={block.itemId} />
          if (block.type === 'notes')
            return <Notes key={block.key} {...ref} itemIds={block.itemIds} />
          if (block.type === 'compaction')
            return <Compaction key={block.itemId} {...ref} itemId={block.itemId} />
          // 收尾区排在回合最后（下面单独画），这里跳过
          if (block.type === 'tail') return null
          const segment = segments.get(block.key)!
          return (
            <SegmentBlock
              key={block.key}
              {...ref}
              turn={turn}
              block={block}
              segment={segment}
              first={segment === firstSegment}
              divided={divided}
              answerIds={answerIds}
              touched={touched}
              agentsRunning={agentsRunning}
              userId={userBefore[index]}
            />
          )
        })}
        {/* 回合级的出错框只给失败的回合（官方桌面端也是这样）：被打断的回合对面就算带了一句错误
          （旧版 Claude Code 入口带过 interrupted），也只在结尾写“已中断”，不画红框 */}
        {turn.status === 'failed' && turn.error && !remind ? (
          <div className="errbox" data-search-item={`search-error:${turnId}`}>
            <span>{turn.error}</span>
          </div>
        ) : null}
        {running && turn.recovery ? <Recovery {...ref} turn={turn} /> : null}
        {/* 建议任务的卡片和收尾留的问题：固定在回合最下方（最终回答下面），不随回答往上冲 */}
        {/* 收尾带的卡片和问题等回合结束才进来（核心的 bucketItems），先收尾再写回答时不比回答先出 */}
        {tail ? (
          <TurnTail {...ref} turnId={turnId} itemIds={tail.itemIds} fresh={freshTail} />
        ) : null}
        {/* 正文出字且没有工作提示时不占行；实际高度变化由对话区的滚动锚点补偿。 */}
        {remind ? null : running ? (
          <div
            className="running-line slot"
            data-anchor={`t:${turnId}`}
            data-hidden={working || retry ? undefined : ''}
            aria-hidden={!working && !retry}
          >
            <i className="st run" />
            <span>{t('turn.working', { name: nameOf(device, meta?.harness ?? '', t) })}</span>
            <TurnElapsed since={turn.startedAt} />
            {retry ? <span className="running-retry">{retryText(retry, t)}</span> : null}
          </div>
        ) : (
          <div className="turn-foot" data-anchor={`t:${turnId}`}>
            <span>{turn.status === 'running' ? '' : t(TURN_END[turn.status])}</span>
            {turn.durationMs === null ? null : <span>{duration(turn.durationMs, t)}</span>}
            {ended === null ? null : <Stamp at={ended} />}
            {footerAnswer?.type === 'answer' ? (
              <div className="message-acts">
                <AnswerCopy {...ref} itemId={footerAnswer.itemId} />
              </div>
            ) : null}
          </div>
        )}
      </section>
    </TurnTouch.Provider>
  )
})

/**
 * “{harness} 正在工作”后面这一回合已经用了多久。单独一个组件：每秒重画的只有这几个字。
 * 回合的开始时刻没给（接手时已经在跑、对面没说）就不写
 */
function TurnElapsed({ since }: { since: number | null }) {
  const t = useT()
  const spent = useElapsed(since)
  if (spent === null || spent < 1000) return null
  return <span className="running-time">{elapsed(spent, t)}</span>
}

/** 等一小会儿再出现的提示：读得快的时候不闪一下“正在读取” */
function Delayed({ ms, children }: { ms: number; children: ReactNode }) {
  const [show, setShow] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setShow(true), ms)
    return () => window.clearTimeout(timer)
  }, [ms])
  return show ? children : null
}

/**
 * 分叉出来的会话：对话最上面一行写明从哪个会话分出来的，点它回到那个会话。那个会话不在侧栏里
 * （归档了、删了，或者还没列出来）就只写一句，不给点
 */
function ForkedFrom({
  deviceId,
  sessionId,
  onOpen,
}: SessionRef & { onOpen: TranscriptProps['onOpen'] | undefined }) {
  const t = useT()
  const meta = useKey<SessionMeta>(keys.session(deviceId, sessionId))
  const source = meta?.forkedFrom ?? null
  const listed = useKey<SessionSummary>(keys.summary(deviceId, source ?? ''))
  if (!source) return null
  const title = listed ? t.text(listed.title) || t('session.untitled') : null
  return (
    <div className="forked-from" data-source={source}>
      <span>{t('transcript.forkedFrom')}</span>
      {title !== null && onOpen ? (
        <button
          type="button"
          className="forked-link"
          title={t('transcript.forkedFrom.open')}
          onClick={() => onOpen({ deviceId, sessionId: source })}
        >
          {title}
        </button>
      ) : (
        <span className="forked-gone">{title ?? t('transcript.forkedFrom.unknown')}</span>
      )}
    </div>
  )
}

interface TranscriptProps extends SessionRef {
  /** 对话下面放什么。不给就是平常的输入区；只读地看已归档的对话时换成一条说明 */
  footer?: ReactNode
  /** 打开另一个会话（分叉出来的那个） */
  onOpen?(selection: SessionRef): void
  /**
   * 这是一个侧聊（aside/state.ts）：parentId 是它的主会话（选字浮层上换成“带回主会话”），
   * skip 是从主会话带来的回合（不画），lead 画在对话最前面，替掉“分叉自”那一行
   */
  aside?: { parentId: string; skip: readonly string[]; lead: ReactNode }
}

/**
 * 这一刻画最后几个回合（turn-window.ts）：先画一截，之后每次让出主线程再往前补一批，补的渲染可被打断（transition），
 * 打字、点按不用等它。换了会话从头来
 */
function useTurnWindow(
  sessionKey: string,
  total: number,
  searching = false,
): { span: number; restoring: boolean } {
  const [state, setState] = useState(() => ({
    key: sessionKey,
    shown: FIRST_TURNS,
    restore: restoreWindow(savedTurns(sessionKey)),
  }))
  let current = state
  if (state.key !== sessionKey) {
    current = {
      key: sessionKey,
      shown: FIRST_TURNS,
      restore: restoreWindow(savedTurns(sessionKey)),
    }
    setState(current)
  }
  const { shown, restore } = current
  useEffect(() => {
    if (shown >= total || searching) return
    const timer = setTimeout(() =>
      startTransition(() =>
        setState((current) =>
          current.key === sessionKey
            ? { ...current, shown: growWindow(current.shown, total) }
            : current,
        ),
      ),
    )
    return () => clearTimeout(timer)
  }, [sessionKey, shown, total, searching])
  return { span: shown, restoring: shown < Math.min(total, restore) }
}

/** 对话区：只在显示期间订阅这个会话，切走就退订 */
export function Transcript({ deviceId, sessionId, footer, onOpen, aside }: TranscriptProps) {
  const { replica } = useServices()
  // 读取失败后点“重试”：把订阅关掉再开一次
  const [attempt, setAttempt] = useState(0)
  // 新建页预取的内容在首帧就会显示；布局提交时先接手订阅，不能等被动 effect。
  // 否则预取的零延时释放可能先归零引用，清空会话并卸载刚出现的提问卡。
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 变了就是要重新订阅
  useLayoutEffect(
    () => replica.openSession(deviceId, sessionId),
    [replica, deviceId, sessionId, attempt],
  )
  // 状态库的通知是同步更新。把历史渲染降为可中断任务，先让侧栏完成选中和后续点击。
  const loadedTurns = useKey<string[]>(keys.turnIds(deviceId, sessionId))
  const allTurns = useDeferredValue(loadedTurns)
  const skip = aside?.skip
  const turnIds = useMemo(
    () => (allTurns && skip?.length ? allTurns.filter((id) => !skip.includes(id)) : allTurns),
    [allTurns, skip],
  )
  const failure = useKey<SessionFailure>(keys.sessionError(deviceId, sessionId))
  // 内容还没读到、而它所属的 harness 现在用不了：这时核心在等它恢复，不是“正在读取”
  const device = useKey<DeviceView>(keys.device(deviceId))
  const listed = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const down = downHarness(device, listed?.harness)
  const t = useT()
  const scroll = useTranscriptScroll(`${deviceId}:${sessionId}`, turnIds)
  const [finding, setFinding] = useState(false)
  // 查找条浮在右上角：查找时内容最上面多留一段，最早的几行也能滚到它下面。关掉之后先留着，
  // 等最上面滚出视口再去掉（滚动区贴底，那时去掉看不出来），免得关的那一下内容往上跳；不满一屏的直接去掉
  const [findRoom, setFindRoom] = useState(() => savedFindRoom(`${deviceId}:${sessionId}`) > 0)
  useLayoutEffect(() => {
    const room = savedFindRoom(`${deviceId}:${sessionId}`)
    setFindRoom(room > 0)
    if (room) scroll.contentRef.current?.style.setProperty('--find-room', `${room}px`)
  }, [deviceId, sessionId, scroll.contentRef])
  useEffect(() => {
    if (finding) setFindRoom(true)
  }, [finding])
  const [target, setTarget] = useState<SearchHit | null>(null)
  const [reading, setReading] = useState<string | null>(null)
  const focusBeforeSearch = useRef<HTMLElement | null>(null)
  const openFind = useCallback(() => {
    const input = document.querySelector<HTMLInputElement>(
      `[data-search-session="${CSS.escape(JSON.stringify([deviceId, sessionId]))}"] input`,
    )
    if (input) {
      input.focus()
      input.select()
      return
    }
    focusBeforeSearch.current = document.activeElement as HTMLElement
    setFinding(true)
  }, [deviceId, sessionId])
  const closeFind = useCallback(
    (restoreFocus = true) => {
      // DOM 高亮是最后实际显示的位置；目标状态可能还在等 React 提交。
      const range = [...(CSS.highlights.get('litch-find-current') ?? [])][0]
      const active = range?.startContainer.parentElement?.closest('[data-search-item]')
      const element =
        active ??
        (target
          ? scroll.contentRef.current?.querySelector(
              `[data-search-item="${CSS.escape(target.itemId)}"]`,
            )
          : null)
      if (element) scroll.keepReading(element)
      setReading(
        element?.closest('[data-search-turn]')?.getAttribute('data-search-turn') ??
          target?.turnId ??
          null,
      )
      setFinding(false)
      setTarget(null)
      if (!restoreFocus) return
      requestAnimationFrame(() => {
        const previous = focusBeforeSearch.current
        const fallback =
          document.querySelector<HTMLElement>('.search-entry') ?? scroll.scrollerRef.current
        ;(previous?.isConnected ? previous : fallback)?.focus({ preventScroll: true })
      })
    },
    [target, scroll],
  )
  const findsHere = useCallback(
    (device: string, session: string, origin: Element | null) =>
      device === deviceId &&
      session === sessionId &&
      (origin?.closest('.aside-view, .agents-view') ?? null) ===
        (scroll.scrollerRef.current?.closest('.aside-view, .agents-view') ?? null),
    [deviceId, sessionId, scroll.scrollerRef],
  )
  useEffect(
    () =>
      onFind((device, session, origin) => {
        if (findsHere(device, session, origin)) openFind()
      }),
    [findsHere, openFind],
  )
  useEffect(
    () =>
      onFindPreparing((device, session, origin) => {
        if (finding && !findsHere(device, session, origin)) closeFind(false)
      }),
    [findsHere, finding, closeFind],
  )
  const searchTarget = useCallback((hit: SearchHit | null) => {
    if (hit) setTarget(hit)
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: 会话身份变化时清除搜索，不沿用上个会话目标。
  useEffect(() => {
    setFinding(false)
    setTarget(null)
    setReading(null)
  }, [deviceId, sessionId])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.shiftKey ||
        event.altKey ||
        !(currentPlatform() === 'mac'
          ? event.metaKey && !event.ctrlKey
          : event.ctrlKey && !event.metaKey) ||
        event.code !== 'KeyF'
      )
        return
      const active = event.target instanceof Element ? event.target : null
      const owner = active?.closest('.aside-view, .agents-view') ?? null
      const mine = scroll.scrollerRef.current?.closest('.aside-view, .agents-view') ?? null
      if (owner !== mine || (active?.closest('.side') && !mine)) return
      if (active?.closest('.terminal-slot, .xterm, dialog[open], [role="dialog"]')) return
      event.preventDefault()
      requestFind(deviceId, sessionId, scroll.scrollerRef.current)
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [deviceId, sessionId, scroll.scrollerRef])
  const { span, restoring } = useTurnWindow(
    `${deviceId}:${sessionId}`,
    turnIds?.length ?? 0,
    finding,
  )
  const drawn = useMemo(() => {
    if (!turnIds) return turnIds
    if (finding && target?.turnId) return searchWindow(turnIds, target.turnId, span)
    const at = reading ? turnIds.indexOf(reading) : -1
    // 退出后接入连续的阅读窗口，逐批向两边补齐，不保留搜索的稀疏窗口或分隔行。
    return at < 0 ? turnIds.slice(-span) : turnIds.slice(Math.max(0, at - span + 1), at + span)
  }, [turnIds, span, target?.turnId, finding, reading])
  const searchGaps = useMemo(() => {
    const gaps = new Map<string, number>()
    if (!finding || !turnIds || !drawn) return gaps
    const positions = new Map(turnIds.map((id, index) => [id, index]))
    let previous = -1
    for (const id of drawn) {
      const index = positions.get(id) ?? previous + 1
      if (index > previous + 1) gaps.set(id, index - previous - 1)
      previous = index
    }
    return gaps
  }, [finding, turnIds, drawn])
  const { restore } = scroll
  const older = useOlderHistory(
    deviceId,
    sessionId,
    scroll,
    turnIds?.length ?? 0,
    drawn?.length ?? 0,
    finding,
    allTurns === loadedTurns,
  )
  const lastTurn = useKey<TurnView>(keys.turn(deviceId, sessionId, turnIds?.at(-1) ?? ''))
  const busy = lastTurn?.status === 'running'
  const actions = useMemo(() => ({ busy, open: onOpen }), [busy, onOpen])
  // 对话里提到的文件路径：落在这个会话的工作区里的可以点开
  const fileLinks = useSessionFileLinks(deviceId, listed)

  // 内容第一次画出来的那一刻，回到上次离开这个会话时的位置
  const ready = turnIds !== undefined && allTurns === loadedTurns && !restoring && !older.restoring
  useLayoutEffect(() => {
    if (ready) restore()
  }, [ready, restore])
  useEffect(() => {
    if (!ready || finding || !findRoom) return
    const scroller = scroll.scrollerRef.current
    if (!scroller) return
    const check = () => {
      const overflow = scroller.scrollHeight - scroller.clientHeight
      // 反向列：scrollTop 在底部是 0，往上是负的，到顶是 -overflow
      if (overflow <= 1 || overflow + scroller.scrollTop > 80) setFindRoom(false)
    }
    check()
    scroller.addEventListener('scroll', check, { passive: true })
    return () => scroller.removeEventListener('scroll', check)
  }, [ready, finding, findRoom, scroll.scrollerRef])

  return (
    <>
      {finding ? (
        <SearchPanel
          deviceId={deviceId}
          sessionId={sessionId}
          skip={aside?.skip}
          root={scroll.contentRef}
          onTarget={searchTarget}
          reveal={scroll.reveal}
          updateRange={scroll.updateSearchRange}
          onClose={() => closeFind()}
        />
      ) : null}
      {/* 查找会自动补页，隐藏同位置的手动入口，避免挡住浮动查找栏。 */}
      {finding ? null : (
        <div className="history-overlay">
          <HistoryStatus history={older.history} load={older.load} />
        </div>
      )}
      <div
        className="tr-scroll"
        tabIndex={-1}
        ref={scroll.scrollerRef}
        data-find-room={finding || findRoom ? '' : undefined}
        aria-busy={restoring || !turnIds}
      >
        {restoring ? <div className="tr-loading dim">{t('transcript.loading')}</div> : null}
        <div
          className="tr"
          ref={scroll.contentRef}
          data-windowed={(turnIds?.length ?? 0) > WINDOWED_TURNS ? '' : undefined}
        >
          <PinProvider value={scroll.pin}>
            <FileLinksProvider value={fileLinks}>
              <ActionsProvider value={actions}>
                <ManagerReferencesScope deviceId={deviceId} sessionId={sessionId} onOpen={onOpen}>
                  {/* 选字加评论、原文上的标记。只读地看（已归档）时不加。排在最前面：它不占地方，
                  放在回合后面的话 .turn:last-child 就认不出最后一个回合了 */}
                  {turnIds && !failure && !footer ? (
                    <CommentLayer
                      deviceId={deviceId}
                      sessionId={sessionId}
                      parentId={aside?.parentId ?? null}
                    />
                  ) : null}
                  {turnIds && !failure && aside ? aside.lead : null}
                  {turnIds && !failure && !aside ? (
                    <>
                      <ForkedFrom deviceId={deviceId} sessionId={sessionId} onOpen={onOpen} />
                      <LineageBar deviceId={deviceId} sessionId={sessionId} onOpen={onOpen} />
                    </>
                  ) : null}
                  {turnIds && !failure ? (
                    <TaskNote deviceId={deviceId} sessionId={sessionId} />
                  ) : null}
                  <DelegatedHistory deviceId={deviceId} sessionId={sessionId} />
                  {failure ? (
                    <div className="errbox">
                      <span>{t('transcript.loadFailed', { reason: failureText(failure, t) })}</span>
                      <button
                        type="button"
                        className="mini"
                        onClick={() => setAttempt((n) => n + 1)}
                      >
                        {t('transcript.retry')}
                      </button>
                    </div>
                  ) : !turnIds && down ? (
                    <div className="dim harness-wait">{downText(down, 'transcript', t)}</div>
                  ) : !turnIds ? (
                    <Delayed ms={300}>
                      <div className="dim">{t('transcript.loading')}</div>
                    </Delayed>
                  ) : turnIds.length === 0 ? (
                    aside ? null : (
                      <div className="dim">{t('transcript.empty')}</div>
                    )
                  ) : (
                    (drawn ?? turnIds).map((turnId) => (
                      <Fragment key={turnId}>
                        {searchGaps.has(turnId) ? (
                          <div className="search-gap">
                            {t('search.gap', { count: searchGaps.get(turnId) ?? 0 })}
                          </div>
                        ) : null}
                        <TurnBoundary label={t('turn.broken')}>
                          <Turn
                            deviceId={deviceId}
                            sessionId={sessionId}
                            turnId={turnId}
                            kept={turnId === target?.turnId || turnId === reading}
                          />
                        </TurnBoundary>
                      </Fragment>
                    ))
                  )}
                  {/* 这边重启设备服务时回合被打断了：最后说一句发消息继续 */}
                  {turnIds && !failure ? (
                    <RestartNote deviceId={deviceId} sessionId={sessionId} />
                  ) : null}
                </ManagerReferencesScope>
              </ActionsProvider>
            </FileLinksProvider>
          </PinProvider>
        </div>
      </div>
      {/* 对话区和输入区之间：“回到底部”，还有等着回答的请求。请求排在输入框上面，不占它的位置 */}
      <div className="tr-tail">
        {scroll.following ? null : (
          <button
            type="button"
            className="to-bottom"
            onClick={() => {
              setReading(null)
              scroll.toBottom()
            }}
          >
            {t('transcript.toBottom')}
          </button>
        )}
        {footer ? null : <Requests deviceId={deviceId} sessionId={sessionId} />}
        {footer ? null : <ChildRequests deviceId={deviceId} sessionId={sessionId} />}
        {footer ? null : <PendingQuestions deviceId={deviceId} sessionId={sessionId} />}
      </div>
      <div className="dock-wrap">
        {footer ?? <Dock deviceId={deviceId} sessionId={sessionId} />}
      </div>
    </>
  )
}
