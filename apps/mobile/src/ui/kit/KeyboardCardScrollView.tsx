// 请求卡已经随 StickyView 避让，且自身会缩高。直接量卡片视口和完整输入框，
// 不让按屏幕键盘边缘计算的滚动再次移动它；键盘落定、换焦点和输入长高后再校正。
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import {
  Platform,
  ScrollView,
  type ScrollViewProps,
  StyleSheet,
  TextInput,
  type TextInputProps,
  useWindowDimensions,
} from 'react-native'
import {
  KeyboardEvents,
  useFocusedInputHandler,
  useKeyboardState,
} from 'react-native-keyboard-controller'
import { runOnJS } from 'react-native-reanimated'
import { cardInputMaxHeight, cardInputScroll } from './card-input-layout'
import { useKeyboardAccessoryHeight } from './KeyboardForm'

const CardViewport = createContext<{
  height: number
  focus(target: number): void
  blur(target: number): void
  resize(): void
} | null>(null)

/** 短卡片的多行框在自身内部滚动，不能长到卡片视口之外。 */
export function CardTextInput({
  style,
  onFocus,
  onBlur,
  onContentSizeChange,
  ...props
}: TextInputProps) {
  const card = useContext(CardViewport)
  const flat = StyleSheet.flatten(style)
  const preferred = typeof flat?.maxHeight === 'number' ? flat.maxHeight : 160
  const minimum = typeof flat?.minHeight === 'number' ? flat.minHeight : 44
  return (
    <TextInput
      {...props}
      style={[
        style,
        {
          maxHeight: cardInputMaxHeight(
            card?.height ?? Number.POSITIVE_INFINITY,
            preferred,
            minimum,
          ),
        },
      ]}
      onFocus={(event) => {
        card?.focus(event.nativeEvent.target)
        onFocus?.(event)
      }}
      onBlur={(event) => {
        card?.blur(event.nativeEvent.target)
        onBlur?.(event)
      }}
      onContentSizeChange={(event) => {
        card?.resize()
        onContentSizeChange?.(event)
      }}
    />
  )
}

export function KeyboardCardScrollView({
  children,
  onLayout,
  onContentSizeChange,
  onScroll,
  ...props
}: ScrollViewProps) {
  const scroll = useRef<ScrollView>(null)
  const [viewport, setViewport] = useState(Number.POSITIVE_INFINITY)
  const focusTarget = useRef(-1)
  const offset = useRef(0)
  const caret = useRef<number | null>(null)
  const frame = useRef(0)
  const generation = useRef(0)
  const keyboard = useKeyboardState((state) => (state.isVisible ? state.height : 0))
  const { height } = useWindowDimensions()
  const accessory = useKeyboardAccessoryHeight()
  const limits = useRef({ keyboard, bottom: height - keyboard - accessory })
  limits.current = { keyboard, bottom: height - keyboard - accessory }

  const reveal = useCallback(() => {
    cancelAnimationFrame(frame.current)
    const token = ++generation.current
    // onLayout 与 keyboardDidShow 可以早于原生提交；两帧后读取的坐标包含 StickyView 的平移。
    frame.current = requestAnimationFrame(() => {
      frame.current = requestAnimationFrame(() => {
        const view = scroll.current
        if (!view || limits.current.keyboard <= 0 || focusTarget.current < 0) return
        // 只在原生键盘实际出现后取焦点；网页滚动由浏览器负责，没有这项原生 API。
        const field = TextInput.State.currentlyFocusedInput()
        if (!field) return
        view.getNativeScrollRef()?.measureInWindow((_x, top, width, viewportHeight) => {
          if (width <= 0 || viewportHeight <= 0) return
          field.measureInWindow((_ix, inputTop, inputWidth, inputHeight) => {
            if (token !== generation.current || focusTarget.current < 0 || inputWidth <= 0) return
            const y = cardInputScroll({
              offset: offset.current,
              viewportTop: top,
              viewportBottom: Math.min(top + viewportHeight, limits.current.bottom),
              inputTop,
              inputHeight,
              caretY: caret.current,
            })
            if (Math.abs(y - offset.current) > 0.5) view.scrollTo({ y, animated: false })
          })
        })
      })
    })
  }, [])
  const selection = useCallback(
    (target: number, y: number) => {
      if (focusTarget.current !== target) return
      caret.current = y
      reveal()
    },
    [reveal],
  )
  useFocusedInputHandler({
    onSelectionChange: (event) => {
      'worklet'
      runOnJS(selection)(event.target, event.selection.end.y)
    },
  })
  useEffect(() => {
    const shown = KeyboardEvents.addListener('keyboardDidShow', reveal)
    return () => {
      shown.remove()
      cancelAnimationFrame(frame.current)
      generation.current++
    }
  }, [reveal])
  // biome-ignore lint/correctness/useExhaustiveDependencies: 窗口与键盘变化后重测原生坐标。
  useEffect(reveal, [keyboard, height, accessory, reveal])
  return (
    <ScrollView
      ref={scroll}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      scrollEventThrottle={16}
      {...props}
      onScroll={(event) => {
        offset.current = event.nativeEvent.contentOffset.y
        onScroll?.(event)
      }}
      onLayout={(event) => {
        setViewport(event.nativeEvent.layout.height)
        reveal()
        onLayout?.(event)
      }}
      onContentSizeChange={(width, contentHeight) => {
        reveal()
        onContentSizeChange?.(width, contentHeight)
      }}
    >
      <CardViewport.Provider
        value={{
          height: viewport,
          focus: (target) => {
            focusTarget.current = target
            caret.current = null
            reveal()
          },
          blur: (target) => {
            if (focusTarget.current !== target) return
            focusTarget.current = -1
            generation.current++
          },
          resize: reveal,
        }}
      >
        {children}
      </CardViewport.Provider>
    </ScrollView>
  )
}
