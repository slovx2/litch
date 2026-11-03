// 运行记号统一慢呼吸：2.4 秒一轮，只改变透明度，不挪动文字或触发布局。
import { useIsFocused } from '@react-navigation/native'
import { useEffect } from 'react'
import { AccessibilityInfo, Animated, AppState, Easing } from 'react-native'
import { createBreathClock } from './breath-state'

const value = new Animated.Value(1)
const still = new Animated.Value(1)
const clock = createBreathClock({
  active: () => AppState.currentState === 'active',
  reduced: () => AccessibilityInfo.isReduceMotionEnabled(),
  onActive: (change) => {
    const listener = AppState.addEventListener('change', (state) => change(state === 'active'))
    return () => listener.remove()
  },
  onReduced: (change) => {
    const listener = AccessibilityInfo.addEventListener('reduceMotionChanged', change)
    return () => listener.remove()
  },
  start: () => {
    const half = (toValue: number) =>
      Animated.timing(value, {
        toValue,
        duration: 1200,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
        // 无限循环不能占住交互队列，否则长列表会推迟挂载后续的行。
        isInteraction: false,
      })
    const loop = Animated.loop(Animated.sequence([half(0.35), half(1)]))
    loop.start()
    return () => loop.stop()
  },
  reset: () => value.setValue(1),
})

/** 暂停、页面失焦、退到后台、减弱动态时用完整不透明度的皮肤记号。 */
export function useBreath(paused = false): Animated.Value {
  const focused = useIsFocused()
  const enabled = focused && !paused
  useEffect(() => {
    if (enabled) return clock.retain()
  }, [enabled])
  return enabled ? value : still
}
