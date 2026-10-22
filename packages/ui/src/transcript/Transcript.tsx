import {
  type Block,
  bucketItems,
  cardPlace,
  type DeviceView,
  type ItemView,
  keys,
  processFolded,
  processItemIds,
  processSettled,
  quietOf,
  type RequestView,
  type SessionMeta,
  type SessionSummary,
  type Text,
  type TurnView,
  workingShown,
} from '@litch/core'
import {
  Component,
  Fragment,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import { useT } from '../app/appearance.ts'
import { useElapsed } from '../app/clock.ts'
import { downHarness, downText, nameOf } from '../app/device.ts'
import { duration, elapsed } from '../app/format.ts'
import { useKey, useServices } from '../app/services.tsx'
import { TurnOrigin } from '../background/TurnOrigin.tsx'
import { Dock, Requests } from '../composer/Dock.tsx'
import { GoalReached } from '../goal/GoalReached.tsx'
import type { MessageKey, Translator } from '../i18n/index.ts'
import { useRailHasTodo } from '../rail/rail-state.ts'
import { TaskNote } from '../tasks/TaskNote.tsx'
import { useAgentsUnfinished } from '../tree/agent-view.tsx'
import { LineageBar } from '../tree/LineageBar.tsx'
import { TreeCard } from '../tree/TreeCards.tsx'
import { TurnTail } from '../tree/TurnTail.tsx'
import { ActionsProvider } from './actions.tsx'
import { Notes } from './activity.tsx'
import { CiteScope } from './comments/Cite.tsx'
import { CommentLayer } from './comments/Layer.tsx'
import { FileLinksProvider, useSessionFileLinks } from './FileLinks.tsx'
import { AgentAnswer, PlanCard, UserMessage } from './messages.tsx'
import { ProcessHead, ProcessParts } from './process.tsx'
import { PinProvider, useTranscriptScroll } from './scroll.ts'
import { TurnTouch, touchTurn, useToggle, useTurnTouched } from './state.ts'
import { TodoCard } from './Todo.tsx'

interface SessionRef {
  deviceId: string
  sessionId: string
}

interface TurnBlocks {
  blocks: Block[]
  /** 最终回答那一条 */
  answerId: string | undefined
  /** 整段过程里所有条目的标识 */
  processIds: string[]
}

/**
 * 把一个回合的条目分成块。条目的种类、卡片与否只看开始时就有的东西，所以只在标识的列表变化时重算；
 * 助手消息的阶段要到写完才定（声明了 agentMessagePhase: onCompleted 的 harness），回合结束时再算一遍，
 * 让最后认作最终回答的那一条落定
 */
function useBlocks(
  { deviceId, sessionId }: SessionRef,
  itemIds: string[],
  status: TurnView['status'] | undefined,
): TurnBlocks {
  const { store } = useServices().replica
  // biome-ignore lint/correctness/useExhaustiveDependencies: status 变了就是要重算
  return useMemo(() => {
    const inputs = []
    for (const id of itemIds) {
      const item = store.get<ItemView>(keys.item(deviceId, sessionId, id))
      if (!item) continue
      const place = cardPlace(item)
      // 收尾调用（空的、带建议的）：认最终回答时看它前后
      const wrapUp = item.kind === 'toolCall' && item.wrapUp !== undefined ? { wrapUp: true } : {}
      inputs.push(
        item.kind === 'agentMessage'
          ? { id, kind: item.kind, phase: item.phase, ...(place ? { card: place } : {}) }
          : item.kind === 'userMessage' && item.event?.kind === 'remind'
            ? { id, kind: item.kind, remind: true }
            : place
              ? { id, kind: item.kind, card: place, ...wrapUp }
              : quietOf(item)
                ? { id, kind: item.kind, quiet: true, ...wrapUp }
                : { id, kind: item.kind },
      )
    }
    const blocks = bucketItems(inputs)
    return {
      blocks,
      answerId: blocks.find((block) => block.type === 'answer')?.itemId,
      processIds: blocks.flatMap((block) =>
        block.type === 'process' ? processItemIds(block.parts) : [],
      ),
    }
  }, [store, deviceId, sessionId, itemIds, status])
}

/**
 * 过程是不是告一段落了：回合结束，或者最终回答写完了（声明了一开始就知道的 harness，一开始就算）。
 * 要看最终回答那一条，所以订阅它；结果是个布尔值，回答的文字在变而结论没变时不会引起重画
 */
function useSettled(
  ref: SessionRef,
  running: boolean,
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
    return processSettled(running, answer ? [answer] : [], finalOnStart)
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
  const { blocks, answerId, processIds } = useBlocks(ref, turn?.itemIds ?? [], turn?.status)
  const settled = useSettled(ref, running, answerId, meta?.can.finalOnStart === true)
  const working = useLasting(useWorking(ref, running, turn?.itemIds ?? NO_ITEMS), WORKING_DELAY_MS)
  const touched = useTurnTouched(sessionKey, turnId)
  // 待办在右边的信息栏里时，对话里不再画一遍
  const todoInRail = useRailHasTodo(sessionKey)
  // 回合里还有没做完的子代理时不自动收（状态以子线程为准，见 tree/agent-view.tsx）
  const agentsRunning = useAgentsUnfinished(deviceId, sessionId, turnId)
  const [open, setOpen] = useToggle(
    sessionKey,
    `p:${turnId}`,
    !processFolded(settled, touched, agentsRunning),
  )
  const touch = useCallback(() => touchTurn(sessionKey, turnId), [sessionKey, turnId])
  if (!turn) return null
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
  // 分叉、回退挂在回合开头的那条用户消息上。回合结束了、会话能发消息、设备连着、它所属的 harness 可用才出
  const actable =
    !running &&
    meta?.live === true &&
    device?.connection === 'online' &&
    !downHarness(device, meta.harness)
  return (
    <TurnTouch.Provider value={touch}>
      <section className="turn">
        {/* 后台任务结束后、定时任务触发时 harness 自己开的回合：开头一行写怎么来的 */}
        {turn.origin ? (
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
                turnId={actable && index === 0 ? turnId : undefined}
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
        {turn.status === 'failed' && turn.error ? (
          <div className="errbox">
            <span>{turn.error}</span>
          </div>
        ) : null}
        {/* 建议任务的卡片和收尾留的问题：固定在回合最下方（最终回答下面），不随回答往上冲 */}
        {tail ? <TurnTail {...ref} turnId={turnId} itemIds={tail.itemIds} /> : null}
        {/* 回合在跑时这一格一直占着位置，正文出字时隐去（只改透明度，不跟着跳）；用时从回合开始算，隐去时照样走 */}
        {running ? (
          <div
            className="running-line slot"
            data-anchor={`t:${turnId}`}
            data-hidden={working ? undefined : ''}
            aria-hidden={!working}
          >
            <i className="st run" />
            <span>{t('turn.working', { name: nameOf(device, meta?.harness ?? '') })}</span>
            <TurnElapsed since={turn.startedAt} />
          </div>
        ) : (
          <div className="turn-foot" data-anchor={`t:${turnId}`}>
            <span>{turn.status === 'running' ? '' : t(TURN_END[turn.status])}</span>
            {turn.durationMs === null ? null : <span>{duration(turn.durationMs, t)}</span>}
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
}

/** 对话区：只在显示期间订阅这个会话，切走就退订 */
export function Transcript({ deviceId, sessionId, footer, onOpen }: TranscriptProps) {
  const { replica } = useServices()
  // 读取失败后点“重试”：把订阅关掉再开一次
  const [attempt, setAttempt] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 变了就是要重新订阅
  useEffect(() => replica.openSession(deviceId, sessionId), [replica, deviceId, sessionId, attempt])
  const turnIds = useKey<string[]>(keys.turnIds(deviceId, sessionId))
  const failure = useKey<SessionFailure>(keys.sessionError(deviceId, sessionId))
  // 内容还没读到、而它所属的 harness 现在用不了：这时核心在等它恢复，不是“正在读取”
  const device = useKey<DeviceView>(keys.device(deviceId))
  const listed = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const down = downHarness(device, listed?.harness)
  const t = useT()
  const scroll = useTranscriptScroll(`${deviceId}:${sessionId}`)
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
                  <CommentLayer deviceId={deviceId} sessionId={sessionId} />
                ) : null}
                {turnIds && !failure ? (
                  <>
                    <ForkedFrom deviceId={deviceId} sessionId={sessionId} onOpen={onOpen} />
                    <LineageBar deviceId={deviceId} sessionId={sessionId} onOpen={onOpen} />
                  </>
                ) : null}
                {turnIds && !failure ? (
                  <TaskNote deviceId={deviceId} sessionId={sessionId} />
                ) : null}
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
                  <div className="dim">{t('transcript.empty')}</div>
                ) : (
                  turnIds.map((turnId) => (
                    <TurnBoundary key={turnId} label={t('turn.broken')}>
                      <Turn deviceId={deviceId} sessionId={sessionId} turnId={turnId} />
                    </TurnBoundary>
                  ))
                )}
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
      </div>
      <div className="dock-wrap">
        {footer ?? <Dock deviceId={deviceId} sessionId={sessionId} />}
      </div>
    </>
  )
}
