import {
  activitySettled,
  type Block,
  bucketItems,
  cardOf,
  type DeviceView,
  type ItemView,
  keys,
  quietOf,
  type SessionMeta,
  type SessionSummary,
  type Text,
  type TurnView,
} from '@litch/core'
import {
  Component,
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
import { downHarness, downText, nameOf } from '../app/device.ts'
import { duration } from '../app/format.ts'
import { useKey, useServices } from '../app/services.tsx'
import { Dock, Requests } from '../composer/Dock.tsx'
import type { MessageKey, Translator } from '../i18n/index.ts'
import { TaskNote } from '../tasks/TaskNote.tsx'
import { LineageBar } from '../tree/LineageBar.tsx'
import { TreeCard } from '../tree/TreeCards.tsx'
import { ActionsProvider } from './actions.tsx'
import { Activity, Notes } from './activity.tsx'
import { FileLinksProvider, useSessionFileLinks } from './FileLinks.tsx'
import { AgentAnswer, PlanCard, UserMessage } from './messages.tsx'
import { PinProvider, useTranscriptScroll } from './scroll.ts'
import { TodoCard } from './Todo.tsx'

interface SessionRef {
  deviceId: string
  sessionId: string
}

interface TurnBlocks {
  blocks: Block[]
  kinds: Map<string, ItemView['kind']>
}

/** 把一个回合的条目分成块。条目的种类和阶段定了就不变，所以只在标识的列表变化时重算 */
function useBlocks({ deviceId, sessionId }: SessionRef, itemIds: string[]): TurnBlocks {
  const { store } = useServices().replica
  return useMemo(() => {
    const kinds = new Map<string, ItemView['kind']>()
    const inputs = []
    for (const id of itemIds) {
      const item = store.get<ItemView>(keys.item(deviceId, sessionId, id))
      if (!item) continue
      kinds.set(id, item.kind)
      inputs.push(
        item.kind === 'agentMessage'
          ? { id, kind: item.kind, phase: item.phase }
          : cardOf(item)
            ? { id, kind: item.kind, card: true }
            : quietOf(item)
              ? { id, kind: item.kind, quiet: true }
              : { id, kind: item.kind },
      )
    }
    return { blocks: bucketItems(inputs), kinds }
  }, [store, deviceId, sessionId, itemIds])
}

/**
 * 一个活动块该不该自动收起。要看它后面那些回答写完没有，所以订阅那几条回答；
 * 结果是个布尔值，回答的文字在变而结论没变时不会引起重画。
 */
function useSettled(
  ref: SessionRef,
  running: boolean,
  answerIds: string[],
  finalOnStart: boolean,
): boolean {
  const { store } = useServices().replica
  const { deviceId, sessionId } = ref
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = answerIds.map((id) =>
        store.subscribe(keys.item(deviceId, sessionId, id), listener),
      )
      return () => {
        for (const stop of stops) stop()
      }
    },
    [store, deviceId, sessionId, answerIds],
  )
  return useSyncExternalStore(subscribe, () =>
    activitySettled(
      running,
      answerIds.flatMap((id) => store.get<ItemView>(keys.item(deviceId, sessionId, id)) ?? []),
      finalOnStart,
    ),
  )
}

interface ActivityBlockProps extends SessionRef {
  block: Extract<Block, { type: 'activity' }>
  kinds: Map<string, ItemView['kind']>
  running: boolean
  /** 这个块后面的回答 */
  answersAfter: string[]
  /** 这个会话的 harness 在最终回答一开始就知道它是最终回答：那时候就收，不等它写完 */
  finalOnStart: boolean
}

function ActivityBlock({
  block,
  kinds,
  running,
  answersAfter,
  finalOnStart,
  ...ref
}: ActivityBlockProps) {
  const settled = useSettled(ref, running, answersAfter, finalOnStart)
  const items = useMemo(
    () => block.itemIds.map((itemId) => ({ itemId, kind: kinds.get(itemId) ?? 'notice' })),
    [block.itemIds, kinds],
  )
  return <Activity {...ref} blockKey={block.key} items={items} settled={settled} />
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
  const { blocks, kinds } = useBlocks({ deviceId, sessionId }, turn?.itemIds ?? [])
  // 每个活动块后面有哪些回答。块没变时这些数组也不变，免得下面的订阅白白重建
  const answersAfter = useMemo(
    () =>
      blocks.map((_, index) =>
        blocks.slice(index + 1).flatMap((later) => (later.type === 'answer' ? [later.itemId] : [])),
      ),
    [blocks],
  )
  if (!turn) return null
  const running = turn.status === 'running'
  const ref = { deviceId, sessionId }
  // 分叉、回退挂在回合开头的那条用户消息上。回合结束了、会话能发消息、设备连着、它所属的 harness 可用才出
  const actable =
    !running &&
    meta?.live === true &&
    device?.connection === 'online' &&
    !downHarness(device, meta.harness)
  return (
    <section className="turn">
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
          return <AgentAnswer key={block.itemId} {...ref} itemId={block.itemId} />
        if (block.type === 'plan')
          return <PlanCard key={block.itemId} {...ref} itemId={block.itemId} />
        if (block.type === 'todo')
          return <TodoCard key={block.itemId} {...ref} itemId={block.itemId} />
        if (block.type === 'card')
          return <TreeCard key={block.itemId} {...ref} itemId={block.itemId} />
        if (block.type === 'notes')
          return <Notes key={block.key} {...ref} itemIds={block.itemIds} />
        return (
          <ActivityBlock
            key={block.key}
            {...ref}
            block={block}
            kinds={kinds}
            running={running}
            finalOnStart={meta?.can.finalOnStart === true}
            answersAfter={answersAfter[index] ?? []}
          />
        )
      })}
      {/* 回合级的出错框只给失败的回合（官方桌面端也是这样）：被打断的回合对面就算带了一句错误
          （旧版 Claude Code 入口带过 interrupted），也只在结尾写“已中断”，不画红框 */}
      {turn.status === 'failed' && turn.error ? (
        <div className="errbox">
          <span>{turn.error}</span>
        </div>
      ) : null}
      {running ? (
        <div className="running-line" data-anchor={`t:${turnId}`}>
          <i className="st run" />
          <span>{t('turn.working', { name: nameOf(device, meta?.harness ?? '') })}</span>
        </div>
      ) : (
        <div className="turn-foot" data-anchor={`t:${turnId}`}>
          <span>{turn.status === 'running' ? '' : t(TURN_END[turn.status])}</span>
          {turn.durationMs === null ? null : <span>{duration(turn.durationMs, t)}</span>}
        </div>
      )}
    </section>
  )
})

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
