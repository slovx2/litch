// 页面标题和页签留在 KeyboardArea 外；区域只缩短内容高度，不平移整页。
// 长表单用 KeyboardFormScrollView：跟踪聚焦、光标换行、候选栏高度变化，并为下一行提交按钮留空间。
import {
  createContext,
  type ReactNode,
  type Ref,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  type LayoutChangeEvent,
  Platform,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native'
import {
  KeyboardAvoidingView,
  KeyboardAwareScrollView,
  type KeyboardAwareScrollViewProps,
  type KeyboardAwareScrollViewRef,
  KeyboardController,
  KeyboardEvents,
  KeyboardStickyView,
  useFocusedInputHandler,
  useKeyboardState,
  useReanimatedFocusedInput,
} from 'react-native-keyboard-controller'
import { runOnJS, useAnimatedReaction, useSharedValue } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useT } from '../i18n'
import { useTheme } from '../theme'
import { keyboardFormLayout } from './keyboard-layout'

const Contained = createContext(false)

export function useKeyboardAccessoryHeight() {
  const { hit } = useTheme()
  return Platform.OS === 'ios' ? hit : 0
}

/** iOS 数字键盘和多行键盘没有完成键；页面与独立 Modal 各在自己的窗口提供一个。 */
export function KeyboardDismissBar() {
  const theme = useTheme()
  const t = useT()
  const shown = useKeyboardState((state) => state.isVisible)
  if (Platform.OS !== 'ios' || !shown) return null
  return (
    <KeyboardStickyView style={styles.accessory}>
      <Pressable
        testID="keyboard:done"
        accessibilityRole="button"
        onPress={() => void KeyboardController.dismiss()}
        style={{
          minHeight: theme.hit,
          paddingHorizontal: 16,
          alignItems: 'flex-end',
          justifyContent: 'center',
          backgroundColor: theme.c.panel,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderColor: theme.c.line1,
        }}
      >
        <Text style={{ color: theme.c.accent, fontSize: theme.font.size.body }}>
          {t('app.done')}
        </Text>
      </Pressable>
    </KeyboardStickyView>
  )
}

/** 表单主操作固定在可用区域底部，键盘打开时不保留系统底栏的空白。 */
export function KeyboardFormFooter({ children }: { children: ReactNode }) {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const shown = useKeyboardState((state) => state.isVisible)
  return (
    <View
      style={{
        padding: 12,
        paddingBottom: 12 + (shown ? 0 : insets.bottom),
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: c.line1,
        backgroundColor: c.panel,
      }}
    >
      {children}
    </View>
  )
}

export function KeyboardArea({
  children,
  style,
}: {
  children: ReactNode
  style?: StyleProp<ViewStyle>
}) {
  const accessory = useKeyboardAccessoryHeight()
  const box = useRef<View>(null)
  const [top, setTop] = useState(0)
  const keyboard = useKeyboardState((state) => state.height)
  const { height } = useWindowDimensions()
  const measure = useCallback(() => {
    box.current?.measureInWindow((_x, y, width, h) => {
      if (width > 0 && h > 0) setTop(y)
    })
  }, [])
  // Android 首次 onLayout 内同步读取窗口坐标可能仍为 0。等布局提交，并在键盘/窗口变化后再量，
  // 把外层的屏幕偏移交给内层 KAV；不能把标题和页签的高度从键盘避让量中漏掉。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 高度变化触发原生坐标重测。
  useEffect(() => {
    const frame = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(frame)
  }, [keyboard, height, measure])
  return (
    <View
      ref={box}
      collapsable={false}
      onLayout={() => requestAnimationFrame(measure)}
      style={[styles.fill, style]}
      pointerEvents="box-none"
    >
      <KeyboardAvoidingView
        behavior="padding"
        keyboardVerticalOffset={top + accessory}
        style={styles.fill}
        pointerEvents="box-none"
      >
        <Contained.Provider value>{children}</Contained.Provider>
      </KeyboardAvoidingView>
    </View>
  )
}

export function KeyboardFormScrollView({
  ref,
  actionHeight,
  onLayout,
  ...props
}: Omit<KeyboardAwareScrollViewProps, 'bottomOffset' | 'extraKeyboardSpace'> & {
  ref?: Ref<KeyboardAwareScrollViewRef>
  actionHeight?: number
}) {
  const theme = useTheme()
  const contained = useContext(Contained)
  const keyboardHeight = useKeyboardState((state) => (state.isVisible ? state.height : 0))
  const { height } = useWindowDimensions()
  const scroll = useRef<KeyboardAwareScrollViewRef>(null)
  const { input } = useReanimatedFocusedInput()
  const [inputHeight, setInputHeight] = useState(80)
  const selectionTarget = useSharedValue(-1)
  const selectionHeight = useSharedValue(0)
  useFocusedInputHandler({
    onSelectionChange: (event) => {
      'worklet'
      selectionTarget.value = event.target
      selectionHeight.value = event.selection.end.y
    },
  })
  useAnimatedReaction(
    () => {
      const field = input.value
      if (!field) return 80
      // 与滚动库使用同一个落点：选区未到时保护整个输入框，选区到后为光标下的操作留空间。
      return field.target === selectionTarget.value && selectionHeight.value > 0
        ? Math.min(field.layout.height, selectionHeight.value)
        : field.layout.height
    },
    (next, previous) => {
      if (next !== previous) runOnJS(setInputHeight)(next)
    },
    [input, selectionTarget, selectionHeight],
  )
  const setRef = useCallback(
    (value: KeyboardAwareScrollViewRef | null) => {
      scroll.current = value
      if (typeof ref === 'function') ref(value)
      else if (ref) ref.current = value
    },
    [ref],
  )
  const [bounds, setBounds] = useState<{ top: number; bottom: number } | null>(null)
  useEffect(() => {
    let frame = 0
    const shown = KeyboardEvents.addListener('keyboardDidShow', () => {
      // 先等避让容器和光标坐标落定，再校正首次聚焦；动画中间的旧视口会把高键盘上的文字滚过头。
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => scroll.current?.assureFocusedInputVisible())
      })
    })
    return () => {
      shown.remove()
      cancelAnimationFrame(frame)
    }
  }, [])
  const measure = useCallback(() => {
    scroll.current?.getNativeScrollRef()?.measureInWindow((_x, y, width, h) => {
      if (width <= 0 || h <= 0) return
      setBounds((old) => (old?.top === y && old.bottom === y + h ? old : { top: y, bottom: y + h }))
    })
  }, [])
  // 弹层居中或 StickyView 平移时，自身尺寸可以不变；键盘落定后仍要重新量屏幕坐标。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 高度变化是测量的触发信号，测量值来自原生布局。
  useEffect(() => {
    const frame = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(frame)
  }, [keyboardHeight, height, measure])
  const layout = (event: LayoutChangeEvent) => {
    measure()
    onLayout?.(event)
  }
  const offsets = keyboardFormLayout({
    keyboardHeight,
    windowHeight: height,
    viewportBottom: bounds?.bottom ?? null,
    viewportTop: bounds?.top ?? null,
    inputHeight,
    // 库按光标而非输入框底边滚动；还要留出多行框、字段说明和下一行操作。
    actionHeight: actionHeight ?? theme.hit * 3 + 48,
    accessoryHeight: Platform.OS === 'ios' ? theme.hit : 0,
    contained,
  })
  return (
    <KeyboardAwareScrollView
      ref={setRef}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      {...props}
      {...offsets}
      onLayout={layout}
    />
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  accessory: { position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 10 },
})
