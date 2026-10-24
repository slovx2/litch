// 对话区：倒置的 FlashList（验证原型里和 LegendList 贴底模式比过，只有它在 60 秒的长回答
// 流式输出里不飘）。第 0 行（最新的）在最下面，底部在几何上就是偏移 0，
// 内容变高、键盘升起都不用 JS 追底。“保持可见位置”一直开着：原型在贴底时把它关掉，可开关一次列表就插拔一次
// 它的锚点视图，刚打开长会话就快速甩动时安卓 Fabric 挂载会崩（Unable to add a view into a view that is not a ViewGroup，
// 2026-10-17 复现：开关时 15 次崩 5–7 次，一直开 15 次 0 次）。一直开着贴底也没受影响（T1 的偏差仍是 0.00x dp）。
import { type DeviceView, keys } from '@litch/core'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { FlashList, type FlashListRef, type ListRenderItem } from '@shopify/flash-list'
import {
  forwardRef,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Linking, type ScrollViewProps, StyleSheet, View } from 'react-native'
import { KeyboardChatScrollView, useKeyboardState } from 'react-native-keyboard-controller'
import { nameOf } from '../../../../packages/ui/src/app/device.ts'
import type { Row } from '../core/rows'
import { growingRows, type SessionSnapshot, type SessionStore } from '../core/session-store'
import { experiment } from '../experiment'
import type { RootStackParamList } from '../nav/routes'
import { noteFirstContent, noteWork } from '../probe'
import { useKey } from '../shell/services'
import { useT } from '../ui/i18n'
import { useTheme } from '../ui/theme'
import { AgentsCell } from './agents/AgentsCell'
import { useSessionBackground } from './background/BackgroundBar'
import { OriginCell } from './background/OriginCell'
import {
  CompactionCell,
  ErrorCell,
  ForkedCell,
  MarkdownCell,
  NoticeCell,
  ReasoningCell,
  RestartNoteCell,
  StatusCell,
  TodoCell,
  UserCell,
} from './cells'
import { useCommentJump } from './comments/context'
import {
  BackgroundContext,
  type TranscriptActions,
  TranscriptContext,
  useFileScope,
} from './context'
import { GoalReachedCell } from './goal/GoalReachedCell'
import { isWebUrl, parseFileHref } from './links'
import { EventCell, QueuedNotesCell } from './proposals/EventCell'
import { HandoffCell } from './proposals/HandoffCell'
import { flash, takeReveal, useRevealWaiting } from './proposals/hooks'
import { ProposalCell } from './proposals/ProposalCell'
import { WrapAskCell } from './proposals/WrapAskCell'
import { GroupCell, GroupEndCell, StepCell } from './steps'
import { colors } from './theme'
import { Flash, ImageViewer, TurnMenu } from './turn-menu'

interface Props {
  store: SessionStore
  /** 列表底边到屏幕底边之间还有多高（输入区加底部安全区）：键盘升起时内容只需让出超出的那部分 */
  bottomOffset: number
  markers: boolean
}

function renderRow(row: Row) {
  switch (row.type) {
    case 'forked':
      return <ForkedCell row={row} />
    case 'user':
      return <UserCell row={row} />
    case 'origin':
      return <OriginCell row={row} />
    case 'event':
      return <EventCell row={row} />
    case 'proposal':
      return <ProposalCell row={row} />
    case 'wrapAsk':
      return <WrapAskCell row={row} />
    case 'handoff':
      return <HandoffCell row={row} />
    case 'md':
      return <MarkdownCell row={row} />
    case 'reasoning':
      return <ReasoningCell row={row} />
    case 'group':
      return <GroupCell row={row} />
    case 'step':
      return <StepCell row={row} />
    case 'groupEnd':
      return <GroupEndCell row={row} />
    case 'agents':
      return <AgentsCell row={row} />
    case 'todo':
      return <TodoCell row={row} />
    case 'notice':
      return <NoticeCell row={row} />
    case 'compaction':
      return <CompactionCell row={row} />
    case 'goalReached':
      return <GoalReachedCell row={row} />
    case 'error':
      return <ErrorCell row={row} />
    case 'status':
      return <StatusCell row={row} />
  }
}

/** 内容末尾的标记线：紧贴在最新一行的下边（measure/ 认洋红色那条） */
function EndMark({ markers }: { markers: boolean }) {
  return <View style={styles.endSpace}>{markers ? <View style={styles.endMark} /> : null}</View>
}

/**
 * 倒置列表的表头（在最底下）：正在流式的那一块和状态行，再下面是标记线。
 * 自己订阅尾巴，尾巴变时只有这里重渲染，列表本身不动
 */
function Tail({ store, markers }: { store: SessionStore; markers: boolean }) {
  const tail = useSyncExternalStore(store.subscribeTail, store.getTail)
  useLayoutEffect(() => {
    if (tail.publishedAt) noteWork('tail', performance.now() - tail.publishedAt)
  }, [tail])
  return (
    <View>
      {tail.rows.toReversed().map((row) => (
        <View key={row.key}>{renderRow(row)}</View>
      ))}
      {/* 子会话交来、还排着没交给模型的回报：进队列就画在最下面，不等下一回合 */}
      <RestartNoteCell />
      <QueuedNotesCell />
      <EndMark markers={markers} />
    </View>
  )
}

/** 交给界面到对话区提交完：React 渲染、列表测量和提交都在 JS 线程上，记进探针 */
function useCommitTiming(snapshot: SessionSnapshot) {
  useLayoutEffect(() => {
    if (snapshot.publishedAt) noteWork('react', performance.now() - snapshot.publishedAt)
    if (snapshot.rows.length > 0) noteFirstContent()
  }, [snapshot])
}

/**
 * 单元格共用的动作（经上下文给下去）和对话区上面的几层浮层：回合的菜单、看大图、一闪而过的提示。
 * 上下文的值只在会话、认路径的范围变了时才换，单元格不会因为浮层开合重画
 */
function useActions(store: SessionStore) {
  const { deviceId, sessionId } = store
  const t = useT()
  const { c } = useTheme()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const cwd = useSyncExternalStore(store.subscribeMeta, () => store.getMeta()?.cwd ?? null)
  const harnessId = useSyncExternalStore(store.subscribeMeta, () => store.getMeta()?.harness ?? '')
  const harness = nameOf(useKey<DeviceView>(keys.device(deviceId)), harnessId)
  const { scope, root } = useFileScope(deviceId, sessionId, cwd)
  const [menu, setMenu] = useState<string | null>(null)
  const [image, setImage] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const clearFlash = useCallback(() => setFlash(null), [])
  const openSession = useCallback(
    (id: string) => navigation.push('Detail', { deviceId, sessionId: id }),
    [navigation, deviceId],
  )
  const value = useMemo<TranscriptActions>(
    () => ({
      deviceId,
      sessionId,
      harness,
      scope,
      root,
      toggle: (key, turnId) => store.toggle(key, turnId),
      openLink: (url) => {
        const file = parseFileHref(url)
        if (file) {
          if (!root) return setFlash(t('detail.link.noFiles'))
          navigation.navigate('Files', {
            deviceId,
            root,
            path: file.path,
            ...(file.line === null ? {} : { line: file.line }),
          })
          return
        }
        if (isWebUrl(url))
          Linking.openURL(url).catch(() => setFlash(t('detail.link.failed', { url })))
      },
      turnMenu: setMenu,
      openDiff: () => {
        const dir = cwd ?? root
        if (dir) navigation.navigate('Diff', { deviceId, root: dir, scope: 'all', sessionId })
      },
      openSession,
      viewImage: setImage,
    }),
    [store, deviceId, sessionId, harness, scope, root, cwd, navigation, openSession, t],
  )
  const overlays = (
    <>
      <TurnMenu
        store={store}
        turnId={menu}
        onClose={() => setMenu(null)}
        onForked={openSession}
        say={setFlash}
      />
      <ImageViewer url={image} onClose={() => setImage(null)} />
      <Flash text={flash} onDone={clearFlash} />
    </>
  )
  return { value, overlays, background: c.raised, say: setFlash }
}

/**
 * 尾巴刚并回列表的那一小会儿，在最早的内容上面（视觉上的顶上）再垫一段：并进来的行要先按别的行的旧高度排一遍
 * （列表的布局按下标记，前面插了行，下标全错开），这一帧内容总高会缩，短会话里缩到比屏幕还矮，
 * 原生滚动把偏移夹回 0，又被当成贴底、尾巴搬回表头，来回抖（2026-10-24 复现：内容 960 缩到 311）。量完就撤。
 * 和尾巴一样走外部订阅：两边在同一次提交里生效，垫高不会晚一步
 */
class Guard {
  private height = 0
  private readonly listeners = new Set<() => void>()
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  readonly get = (): number => this.height
  set(height: number): void {
    if (height === this.height) return
    this.height = height
    for (const listener of this.listeners) listener()
  }
}

/** 倒置列表的表尾（在最上面）：键盘开着时垫的高度，加上尾巴刚并回列表时临时垫的 */
function Footer({ guard, pad }: { guard: Guard; pad: number }) {
  const raised = useSyncExternalStore(guard.subscribe, guard.get)
  useEffect(() => {
    if (!raised) return
    const timer = setTimeout(() => guard.set(0), 300)
    return () => clearTimeout(timer)
  }, [guard, raised])
  return <View style={{ height: pad + raised }} />
}

/** 一次多给列表多少行更早的历史（T6）。核心给的是整个会话，分页只在界面这层：一进来只排最近的这些 */
const PAGE = 40

export function Transcript({ store, bottomOffset, markers }: Props) {
  const listRef = useRef<FlashListRef<Row>>(null)
  const pinnedRef = useRef(true)
  /** 刚离开底部、尾巴正从表头并回列表时是当时的内容总高（见 onScroll），平时是 0 */
  const unpinningRef = useRef(0)
  const guard = useMemo(() => new Guard(), [])
  // 贴底时列表的数据变了（回合结束、尾巴并回列表，发了新的一句）：这一次别让“保持可见位置”去校正。
  // 它只看行的位置，不管表头（尾巴）同时缩了多少，会按并进来的行高把列表推离底部，而且不发滚动事件，
  // 这边还以为贴着底（2026-10-18 复现：回答比一屏长时，回合一结束就停在回答开头）。
  // 不能贴底时把它关掉：开关一次就插拔一次锚点视图，会崩（见文件开头）。
  // 刚离开底部时尾巴并回列表也一样：上面的内容总高不变，而它的锚点是并入前算的第一行，贴底时那是整条正在流的
  // 回答上面那一行（其实不在屏幕里），按它校正会一下滚过整条回答（2026-10-24 复现：上滑 12 就跳到 495，停在回答开头）。
  // 只在列表数据真变了时才跳过：跳过的标记要等列表下一次重排才清，没变时打上会把之后的一次正常校正吞掉
  const subscribe = useCallback(
    (listener: () => void) =>
      store.subscribe(() => {
        if (pinnedRef.current || unpinningRef.current)
          listRef.current?.prepareForLayoutAnimationRender()
        if (unpinningRef.current) guard.set(unpinningRef.current)
        listener()
      }),
    [store, guard],
  )
  const snapshot = useSyncExternalStore(subscribe, store.getSnapshot)
  useCommitTiming(snapshot)
  const [limit, setLimit] = useState(PAGE)
  const rows = useMemo(() => snapshot.rows.slice(0, limit), [snapshot.rows, limit])
  const more = snapshot.rows.length > limit
  // 往上翻着看时，回合里最底下会自己长高的行（状态行、正在流的那一块）不当“保持可见位置”的锚点：
  // 列表默认拿视觉上最下面那一行当锚，它自己长高不算位移，翻着看的内容会被新出的字一点点顶上去。
  // 锚点挑法在 FlashList 的补丁里（patches/），平时（不在流式）照旧
  const anchorFrom = growingRows(snapshot)
  const visiblePosition = useMemo(() => ({ anchorFrom }), [anchorFrom])
  // 倒置列表的“末尾”在最上面：滑到最早的那一行附近时再接一页更早的
  const loadOlder = useCallback(() => {
    if (!more) return
    noteWork('page', limit + PAGE)
    setLimit((current) => current + PAGE)
  }, [more, limit])
  const actions = useActions(store)
  const background = useSessionBackground(store)
  useReveal(store, listRef, snapshot.rows, limit, setLimit, actions.say)
  useCommentJump(listRef, snapshot.rows, limit, setLimit)
  const renderItem = useCallback<ListRenderItem<Row>>(({ item }) => renderRow(item), [])
  const ScrollComponent = useMemo(
    () =>
      forwardRef<unknown, ScrollViewProps>(function ChatScroll(scrollProps, ref) {
        return (
          <KeyboardChatScrollView
            ref={ref as never}
            {...scrollProps}
            inverted
            offset={bottomOffset}
            keyboardLiftBehavior="whenAtEnd"
          />
        )
      }),
    [bottomOffset],
  )
  // 贴底时尾巴放表头；往上翻着看时并回列表，靠列表的“保持可见位置”稳住正在看的内容。之后的切换在 onScroll 里
  useLayoutEffect(() => {
    store.setSplitTail(pinnedRef.current)
    return () => store.setSplitTail(false)
  }, [store])
  const header = useMemo(() => <Tail store={store} markers={markers} />, [store, markers])
  // 整个对话区跟着键盘上移时，最上面那一截被标题栏挡住：键盘开着时在最早的内容上面垫同样高，翻到顶还看得全
  const keyboardHeight = useKeyboardState((state) => (state.isVisible ? state.height : 0))
  const footer = useMemo(
    () => <Footer guard={guard} pad={experiment.keyboard === 'sticky' ? keyboardHeight : 0} />,
    [guard, keyboardHeight],
  )
  return (
    <TranscriptContext.Provider value={actions.value}>
      <BackgroundContext.Provider value={background}>
        <View style={[styles.list, { backgroundColor: actions.background }]}>
          <FlashList
            ref={listRef}
            data={rows}
            inverted
            renderItem={renderItem}
            keyExtractor={keyOf}
            getItemType={typeOf}
            drawDistance={1500}
            maintainVisibleContentPosition={visiblePosition}
            ListHeaderComponent={header}
            onEndReached={loadOlder}
            onEndReachedThreshold={0.5}
            renderScrollComponent={
              experiment.keyboard === 'chat' ? (ScrollComponent as never) : undefined
            }
            ListFooterComponent={footer}
            scrollEventThrottle={16}
            onScroll={(event) => {
              noteWork('offset', event.nativeEvent.contentOffset.y)
              const next = event.nativeEvent.contentOffset.y < 8
              if (next !== pinnedRef.current) {
                noteWork(next ? 'pin' : 'unpin', event.nativeEvent.contentOffset.y)
                pinnedRef.current = next
                // 尾巴搬家就在这里同步做（它会同步通知上面的订阅），不等重渲染后的副作用：
                // 那样跳过校正的标记可能在两次提交之间就被清掉
                unpinningRef.current = next ? 0 : event.nativeEvent.contentSize.height
                store.setSplitTail(next)
                unpinningRef.current = 0
              }
            }}
            style={styles.list}
          />
          {actions.overlays}
        </View>
      </BackgroundContext.Provider>
    </TranscriptContext.Provider>
  )
}

/**
 * 建议任务列表里点了一条、回到这里：在对话里找到那张卡片，滚到屏幕中间、描一圈。
 * 在还没排出来的更早的历史里就先多排几页；对话里没有（调用没留下来）就不滚
 */
function useReveal(
  store: SessionStore,
  listRef: RefObject<FlashListRef<Row> | null>,
  all: Row[],
  limit: number,
  setLimit: (limit: number) => void,
  say: (text: string) => void,
) {
  const t = useT()
  const waiting = useRevealWaiting(store.deviceId, store.sessionId)
  const [target, setTarget] = useState<string | null>(null)
  useEffect(() => {
    if (waiting) setTarget(takeReveal(store.deviceId, store.sessionId))
  }, [waiting, store])
  useEffect(() => {
    if (!target) return
    const index = all.findIndex(
      (row) =>
        row.type === 'proposal' &&
        (row.proposal?.id === target || row.spawned?.proposalId === target),
    )
    if (index < 0) {
      say(t('proposals.notInChat'))
      setTarget(null)
      return
    }
    if (index >= limit) {
      setLimit(index + PAGE)
      return
    }
    listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true })
    flash(target)
    setTarget(null)
  }, [target, all, limit, setLimit, listRef, say, t])
}

const keyOf = (row: Row) => row.key
const typeOf = (row: Row) => row.type

const styles = StyleSheet.create({
  list: { flex: 1 },
  endSpace: { height: 10, justifyContent: 'flex-start' },
  endMark: { height: 2, backgroundColor: colors.markEnd },
})
