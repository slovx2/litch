import type { Ref } from 'react'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { StyleSheet, useWindowDimensions, View, type ViewProps } from 'react-native'
import type {
  KeyboardAwareScrollViewProps,
  KeyboardAwareScrollViewRef,
} from 'react-native-keyboard-controller'
import { useKeyboardState } from 'react-native-keyboard-controller'
import Animated, {
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { KeyboardFormScrollView } from '../../ui/kit/KeyboardForm'
import { useTheme } from '../../ui/theme'
import { cardActionOffset } from './card-action-layout'

type Viewport = { top: number; height: number; scroll: SharedValue<number>; revision: number }
const Scroll = createContext<Viewport | null>(null)

/** 使用实际滚动视口，键盘缩短、底部批量提交栏和安全区都不占用卡片操作空间。 */
export function BoardActionScrollView({
  onScroll,
  onLayout,
  onContentSizeChange,
  ...props
}: KeyboardAwareScrollViewProps & { ref?: Ref<KeyboardAwareScrollViewRef> }) {
  const box = useRef<View>(null)
  const scroll = useSharedValue(0)
  const [revision, changed] = useState(0)
  const [bounds, setBounds] = useState({ top: 0, height: 0 })
  const { height } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const keyboard = useKeyboardState((state) => state.isVisible)
  const measure = useCallback(() => {
    box.current?.measureInWindow((_x, top, _width, size) => {
      const bottom = Math.min(top + size, height - (keyboard ? 0 : insets.bottom))
      setBounds((old) =>
        old.top === top && old.height === bottom - top
          ? old
          : { top, height: Math.max(0, bottom - top) },
      )
    })
  }, [height, keyboard, insets.bottom])
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(frame)
  }, [measure])
  const value = useMemo(() => ({ ...bounds, scroll, revision }), [bounds, scroll, revision])
  return (
    <View ref={box} collapsable={false} style={styles.fill} onLayout={measure}>
      <Scroll.Provider value={value}>
        <Actions.Provider value={null}>
          <KeyboardFormScrollView
            {...props}
            // Android 不能按操作栏的原布局位置裁掉已移入视口的按钮。
            removeClippedSubviews={false}
            onLayout={(event) => {
              measure()
              onLayout?.(event)
            }}
            onScroll={(event) => {
              scroll.value = event.nativeEvent.contentOffset.y
              onScroll?.(event)
            }}
            onContentSizeChange={(width, height) => {
              changed((value) => value + 1)
              onContentSizeChange?.(width, height)
            }}
            scrollEventThrottle={16}
          />
        </Actions.Provider>
      </Scroll.Provider>
    </View>
  )
}

type ActionEntry = { node: ReactNode; full: boolean }
type ActionsScope = {
  register(id: string, node: ReactNode, full: boolean): void
  remove(id: string): void
}
const Actions = createContext<ActionsScope | null>(null)

/** 移动端没有 bottom sticky：只移动卡尾本身，正文布局与原生触控边界仍在这张卡内。 */
export function CardActionArea(props: ViewProps) {
  const parent = useContext(Actions)
  return parent ? <View {...props} /> : <OwnActionArea {...props} />
}

function OwnActionArea({ children, onLayout, ...props }: ViewProps) {
  const viewport = useContext(Scroll)
  const { c } = useTheme()
  const box = useRef<View>(null)
  const bar = useRef<View>(null)
  const [entries, setEntries] = useState(() => new Map<string, ActionEntry>())
  const scope = useMemo<ActionsScope>(
    () => ({
      register: (id, node, full) => setEntries((old) => new Map(old).set(id, { node, full })),
      remove: (id) =>
        setEntries((old) => {
          const next = new Map(old)
          next.delete(id)
          return next
        }),
    }),
    [],
  )
  const top = useSharedValue(0)
  const footerY = useSharedValue(0)
  const size = useSharedValue(0)
  const ready = useSharedValue(false)
  const measure = useCallback(() => {
    if (!viewport?.height) return
    box.current?.measureInWindow((_x, y) => {
      top.value = y - viewport.top + viewport.scroll.value
      // measureLayout 不含 transform，按钮移动后仍能量到原来的占位。
      const parent = box.current
      if (parent)
        bar.current?.measureLayout(parent, (_left, y, _width, height) => {
          footerY.value = y
          size.value = height
          ready.value = true
        })
    })
  }, [viewport, top, footerY, size, ready])
  // biome-ignore lint/correctness/useExhaustiveDependencies: 按钮集合变化后重测卡尾位置。
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(frame)
  }, [measure, entries])
  const movement = useAnimatedStyle(() => ({
    transform: [
      {
        translateY:
          viewport && ready.value
            ? cardActionOffset(
                top.value,
                top.value + footerY.value,
                size.value,
                viewport.scroll.value + viewport.height,
              )
            : 0,
      },
    ],
  }))
  return (
    <View
      {...props}
      ref={box}
      collapsable={false}
      onLayout={(event) => {
        measure()
        onLayout?.(event)
      }}
    >
      <Actions.Provider value={scope}>
        {children}
        {entries.size ? (
          <Animated.View
            ref={bar}
            testID="board-card-actions"
            onLayout={(event) => {
              footerY.value = event.nativeEvent.layout.y
              size.value = event.nativeEvent.layout.height
              measure()
            }}
            style={[
              styles.actions,
              { backgroundColor: c.panel, borderTopColor: c.line1 },
              movement,
            ]}
          >
            {[...entries].map(([id, { node, full }]) => (
              <View key={id} style={[styles.group, full && styles.full]}>
                {node}
              </View>
            ))}
          </Animated.View>
        ) : null}
      </Actions.Provider>
    </View>
  )
}

/** 操作节点只挂载一次，移到同一卡片尾部，保留按钮自身状态、可访问性和点击行为。 */
export function CardActions({ children, full = false }: { children: ReactNode; full?: boolean }) {
  const scope = useContext(Actions)
  const id = useId()
  useLayoutEffect(() => {
    scope?.register(id, children, full)
  }, [scope, id, children, full])
  useLayoutEffect(() => () => scope?.remove(id), [scope, id])
  return scope ? null : children
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },

  actions: {
    zIndex: 2,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  group: { flexShrink: 1, maxWidth: '100%' },
  full: { width: '100%' },
})
