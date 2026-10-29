import {
  type Block,
  blockInput,
  bucketItems,
  type DeviceView,
  type ItemView,
  keys,
  processFolded,
  processItemIds,
  processSettled,
  type RequestView,
  type SessionMeta,
  type SessionSummary,
  type Text,
  type TurnStatus,
  type TurnView,
  workingShown,
} from '@litch/core'
import {
  Component,
  Fragment,
  memo,
  type ReactNode,
  startTransition,
  useCallback,
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
import { useKey, useServices } from '../app/services.tsx'
import { TurnOrigin } from '../background/TurnOrigin.tsx'
import { ChildRequests, DelegatedHistory } from '../composer/ChildRequests.tsx'
import { Dock, Requests } from '../composer/Dock.tsx'
import { PendingQuestions } from '../composer/PendingQuestions.tsx'
import { GoalReached } from '../goal/GoalReached.tsx'
import type { MessageKey, Translator } from '../i18n/index.ts'
import { useRailHasTodo } from '../rail/rail-state.ts'
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
import { AgentAnswer, PlanCard, UserMessage } from './messages.tsx'
import { ProcessHead, ProcessParts } from './process.tsx'
import { Stamp } from './Stamp.tsx'
import { PinProvider, savedTurns, useTranscriptScroll } from './scroll.ts'
import { TurnTouch, touchTurn, useFold, useTurnTouched } from './state.ts'
import { TodoCard } from './Todo.tsx'
import { firstWindow, growWindow } from './turn-window.ts'
import { useTranscriptView } from './view.ts'

interface SessionRef {
  deviceId: string
  sessionId: string
}

interface TurnBlocks {
  blocks: Block[]
  /** 设备进程提醒收尾的回合（开头是 event.kind 为 remind 的用户消息） */
  remind: boolean
  /** 最终回答那一条 */
  answerId: string | undefined
  /** 整段过程里所有条目的标识 */
  processIds: string[]
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
      answerId: blocks.find((block) => block.type === 'answer')?.itemId,
      processIds: blocks.flatMap((block) =>
        block.type === 'process' ? processItemIds(block.parts) : [],
      ),
    }
  }, [store, deviceId, sessionId, itemIds, status])
}

/**
 * 过程是不是告一段落、可以收成一行了（规矩在核心的 processSettled：有最终回答、没被打断）。
 * 要看最终回答那一条，所以订阅它；结果是个布尔值，回答的文字在变而结论没变时不会引起重画
 */
function useSettled(
  ref: SessionRef,
  status: TurnStatus | undefined,
  answerId: string | undefined,
  finalOnStart: boolean,
): boolean {
  const { store } = useServices().replica
  const { deviceId, sessionId } = ref
  const key = answerId ? keys.item(deviceId, sessionId, answerId) : null
  const subscribe = useCallback(
    (listener: () => void) => (key ? store.subscribe(key, listener) : () => {}),
    [store, key],
  )
  return useSyncExternalStore(subscribe, () => {
    const answer = key ? store.get<ItemView>(key) : undefined
    return processSettled(status ?? 'running', answer ? [answer] : [], finalOnStart)
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

const Turn = memo(function Turn({ deviceId, sessionId, turnId }: SessionRef & { turnId: string }) {
  const turn = useKey<TurnView>(keys.turn(deviceId, sessionId, turnId))
  const meta = useKey<SessionMeta>(keys.session(deviceId, sessionId))
  const device = useKey<DeviceView>(keys.device(deviceId))
  const t = useT()
  const ref = useMemo(() => ({ deviceId, sessionId }), [deviceId, sessionId])
  const sessionKey = `${deviceId}:${sessionId}`
  const running = turn?.status === 'running'
  // 回合结束的时刻（开始加用时），结尾那一行写在用时后面
  const ended = turn ? turnEnded(turn) : null
  const { blocks, remind, answerId, processIds } = useBlocks(ref, turn?.itemIds ?? [], turn?.status)
  const settled = useSettled(ref, turn?.status, answerId, meta?.can.finalOnStart === true)
  const working = useLasting(useWorking(ref, running, turn?.itemIds ?? NO_ITEMS), WORKING_DELAY_MS)
  // 模型请求在重试：状态行一直显出，后面写第几次和原因，重试结束（新一次出字）就去掉
  const retry = running ? (turn?.retry ?? null) : null
  const touched = useTurnTouched(sessionKey, turnId)
  // 待办在右边的信息栏里时，对话里不再画一遍
  const todoInRail = useRailHasTodo(sessionKey)
  // 回合里还有没做完的子代理时不自动收（状态以子线程为准，见 tree/agent-view.tsx）
  const agentsRunning = useAgentsUnfinished(deviceId, sessionId, turnId)
  // 详细视图里整段过程一直开着，回合结束也不收（useFold）
  const [open, setOpen] = useFold(
    sessionKey,
    `p:${turnId}`,
    !processFolded(settled, touched, agentsRunning),
  )
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
  // 告一段落之后，第一段过程的开头是收起整段过程的那一行；没告一段落时没有这一行，过程照常摊开
  const firstProcess = blocks.findIndex((block) => block.type === 'process')
  const tail = blocks.find((block) => block.type === 'tail')
  const lastAnswer = blocks.findLastIndex((block) => block.type === 'answer')
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
      <section className="turn">
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
                turnId={actable ? turnId : undefined}
                steered={turn.itemIds.indexOf(block.itemId) > 0}
              />
            )
          if (block.type === 'answer')
            return (
              <Fragment key={block.itemId}>
                <CiteScope {...ref} userId={userBefore[index]}>
                  <AgentAnswer {...ref} itemId={block.itemId} />
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
          // 收起时后面几段过程都不占地方，只留第一段开头的那一行
          if (settled && !open && index !== firstProcess) return null
          // 位置固定的几个子元素（收起那一行、过程本身），中间切换时下面的说明和步骤组不会被重建
          return (
            <div key={block.key} className={settled ? 'proc' : 'proc live'}>
              {settled && index === firstProcess ? (
                <ProcessHead
                  {...ref}
                  turn={turn}
                  itemIds={processIds}
                  open={open}
                  onToggle={setOpen}
                />
              ) : null}
              {settled && !open ? null : (
                <div className="proc-body">
                  <CiteScope {...ref} userId={userBefore[index]}>
                    <ProcessParts {...ref} parts={block.parts} live={running} />
                  </CiteScope>
                </div>
              )}
            </div>
          )
        })}
        {/* 回合级的出错框只给失败的回合（官方桌面端也是这样）：被打断的回合对面就算带了一句错误
          （旧版 Claude Code 入口带过 interrupted），也只在结尾写“已中断”，不画红框 */}
        {turn.status === 'failed' && turn.error && !remind ? (
          <div className="errbox">
            <span>{turn.error}</span>
          </div>
        ) : null}
        {/* 建议任务的卡片和收尾留的问题：固定在回合最下方（最终回答下面），不随回答往上冲 */}
        {/* 收尾带的卡片和问题等回合结束才进来（核心的 bucketItems），先收尾再写回答时不比回答先出 */}
        {tail ? (
          <TurnTail {...ref} turnId={turnId} itemIds={tail.itemIds} fresh={freshTail} />
        ) : null}
        {/* 回合在跑时这一格一直占着位置，正文出字时隐去（只改透明度，不跟着跳）；用时从回合开始算，隐去时照样走 */}
        {remind ? null : running ? (
          <div
            className="running-line slot"
            data-anchor={`t:${turnId}`}
            data-hidden={working || retry ? undefined : ''}
            aria-hidden={!working && !retry}
          >
            <i className="st run" />
            <span>{t('turn.working', { name: nameOf(device, meta?.harness ?? '') })}</span>
            <TurnElapsed since={turn.startedAt} />
            {retry ? <span className="running-retry">{retryText(retry, t)}</span> : null}
          </div>
        ) : (
          <div className="turn-foot" data-anchor={`t:${turnId}`}>
            <span>{turn.status === 'running' ? '' : t(TURN_END[turn.status])}</span>
            {turn.durationMs === null ? null : <span>{duration(turn.durationMs, t)}</span>}
            {ended === null ? null : <Stamp at={ended} />}
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
function useTurnWindow(sessionKey: string, total: number): number {
  const [state, setState] = useState(() => ({
    key: sessionKey,
    shown: firstWindow(savedTurns(sessionKey)),
  }))
  let shown = state.shown
  if (state.key !== sessionKey) {
    shown = firstWindow(savedTurns(sessionKey))
    setState({ key: sessionKey, shown })
  }
  useEffect(() => {
    if (shown >= total) return
    const timer = setTimeout(() =>
      startTransition(() =>
        setState((current) =>
          current.key === sessionKey
            ? { key: sessionKey, shown: growWindow(current.shown, total) }
            : current,
        ),
      ),
    )
    return () => clearTimeout(timer)
  }, [sessionKey, shown, total])
  return shown
}

/** 对话区：只在显示期间订阅这个会话，切走就退订 */
export function Transcript({ deviceId, sessionId, footer, onOpen, aside }: TranscriptProps) {
  const { replica } = useServices()
  // 读取失败后点“重试”：把订阅关掉再开一次
  const [attempt, setAttempt] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 变了就是要重新订阅
  useEffect(() => replica.openSession(deviceId, sessionId), [replica, deviceId, sessionId, attempt])
  const allTurns = useKey<string[]>(keys.turnIds(deviceId, sessionId))
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
  const scroll = useTranscriptScroll(`${deviceId}:${sessionId}`)
  const span = useTurnWindow(`${deviceId}:${sessionId}`, turnIds?.length ?? 0)
  const drawn = useMemo(
    () => (turnIds && span < turnIds.length ? turnIds.slice(-span) : turnIds),
    [turnIds, span],
  )
  const { restore } = scroll
  const lastTurn = useKey<TurnView>(keys.turn(deviceId, sessionId, turnIds?.at(-1) ?? ''))
  const busy = lastTurn?.status === 'running'
  const actions = useMemo(() => ({ busy, open: onOpen }), [busy, onOpen])
  // 对话里提到的文件路径：落在这个会话的工作区里的可以点开
  const fileLinks = useSessionFileLinks(deviceId, listed)

  // 内容第一次画出来的那一刻，回到上次离开这个会话时的位置
  const ready = turnIds !== undefined
  useLayoutEffect(() => {
    if (ready) restore()
  }, [ready, restore])

  return (
    <>
      <div className="tr-scroll" ref={scroll.scrollerRef}>
        <div className="tr" ref={scroll.contentRef}>
          <PinProvider value={scroll.pin}>
            <FileLinksProvider value={fileLinks}>
              <ActionsProvider value={actions}>
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
                    <button type="button" className="mini" onClick={() => setAttempt((n) => n + 1)}>
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
                    <TurnBoundary key={turnId} label={t('turn.broken')}>
                      <Turn deviceId={deviceId} sessionId={sessionId} turnId={turnId} />
                    </TurnBoundary>
                  ))
                )}
                {/* 这边重启设备服务时回合被打断了：最后说一句发消息继续 */}
                {turnIds && !failure ? (
                  <RestartNote deviceId={deviceId} sessionId={sessionId} />
                ) : null}
              </ActionsProvider>
            </FileLinksProvider>
          </PinProvider>
        </div>
      </div>
      {/* 对话区和输入区之间：“回到底部”，还有等着回答的请求。请求排在输入框上面，不占它的位置 */}
      <div className="tr-tail">
        {scroll.following ? null : (
          <button type="button" className="to-bottom" onClick={scroll.toBottom}>
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
