// 对话区：倒置的 FlashList（验证原型里和 LegendList 贴底模式比过，只有它过了 T1，
// 见 research/mobile-prototype-2026-10-17/report.md）。第 0 行（最新的）在最下面，底部在几何上就是偏移 0，
// 内容变高、键盘升起都不用 JS 追底（S1）。贴着底的时候关掉“保持可见位置”，不然它会和贴底抢位置；往上翻着看时再打开。
import { FlashList, type ListRenderItem } from '@shopify/flash-list'
import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { type ScrollViewProps, StyleSheet, View } from 'react-native'
import { KeyboardChatScrollView, useKeyboardState } from 'react-native-keyboard-controller'
import type { Row } from '../core/rows'
import type { SessionSnapshot, SessionStore } from '../core/session-store'
import { experiment } from '../experiment'
import { noteFirstContent, noteWork } from '../probe'
import { MarkdownCell, ProcessCell, ReasoningCell, StatusCell, UserCell } from './cells'
import { colors } from './theme'

interface Props {
  store: SessionStore
  /** 列表底边到屏幕底边之间还有多高（输入区加底部安全区）：键盘升起时内容只需让出超出的那部分 */
  bottomOffset: number
  markers: boolean
}

function renderRow(row: Row, upward: boolean, toggle: (key: string) => void) {
  switch (row.type) {
    case 'user':
      return <UserCell row={row} />
    case 'md':
      return <MarkdownCell row={row} />
    case 'reasoning':
      return <ReasoningCell row={row} />
    case 'process':
      return <ProcessCell row={row} upward={upward} onToggle={toggle} />
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
function Tail({
  store,
  markers,
  toggle,
}: {
  store: SessionStore
  markers: boolean
  toggle(key: string): void
}) {
  const tail = useSyncExternalStore(store.subscribeTail, store.getTail)
  useLayoutEffect(() => {
    if (tail.publishedAt) noteWork('tail', performance.now() - tail.publishedAt)
  }, [tail])
  return (
    <View>
      {tail.rows.toReversed().map((row) => (
        <View key={row.key}>{renderRow(row, true, toggle)}</View>
      ))}
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

/** 一次多给列表多少行更早的历史（T6）。核心给的是整个会话，分页只在界面这层：一进来只排最近的这些 */
const PAGE = 40

export function Transcript({ store, bottomOffset, markers }: Props) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  useCommitTiming(snapshot)
  const [limit, setLimit] = useState(PAGE)
  const rows = useMemo(() => snapshot.rows.slice(0, limit), [snapshot.rows, limit])
  const more = snapshot.rows.length > limit
  // 倒置列表的“末尾”在最上面：滑到最早的那一行附近时再接一页更早的
  const loadOlder = useCallback(() => {
    if (!more) return
    noteWork('page', limit + PAGE)
    setLimit((current) => current + PAGE)
  }, [more, limit])
  const [pinned, setPinned] = useState(true)
  const pinnedRef = useRef(true)
  const toggle = useCallback((key: string) => store.toggle(key), [store])
  const renderItem = useCallback<ListRenderItem<Row>>(
    ({ item }) => renderRow(item, true, toggle),
    [toggle],
  )
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
  // 贴底时尾巴放表头；往上翻着看时并回列表，靠列表的“保持可见位置”稳住正在看的内容
  useLayoutEffect(() => store.setSplitTail(pinned), [store, pinned])
  useLayoutEffect(() => () => store.setSplitTail(false), [store])
  const header = useMemo(
    () => <Tail store={store} markers={markers} toggle={toggle} />,
    [store, markers, toggle],
  )
  // 整个对话区跟着键盘上移时，最上面那一截被标题栏挡住：键盘开着时在最早的内容上面垫同样高，翻到顶还看得全
  const keyboardHeight = useKeyboardState((state) => (state.isVisible ? state.height : 0))
  const footer = useMemo(
    () => (experiment.keyboard === 'sticky' ? <View style={{ height: keyboardHeight }} /> : null),
    [keyboardHeight],
  )
  return (
    <FlashList
      data={rows}
      inverted
      renderItem={renderItem}
      keyExtractor={keyOf}
      getItemType={typeOf}
      drawDistance={1500}
      ListHeaderComponent={header}
      onEndReached={loadOlder}
      onEndReachedThreshold={0.5}
      maintainVisibleContentPosition={{ disabled: pinned }}
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
          setPinned(next)
        }
      }}
      style={styles.list}
    />
  )
}

const keyOf = (row: Row) => row.key
const typeOf = (row: Row) => row.type

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.background },
  endSpace: { height: 10, justifyContent: 'flex-start' },
  endMark: { height: 2, backgroundColor: colors.markEnd },
})
