// 后台任务那几处的慢呼吸（输入框上方那一行、会话列表的记号）：不透明度在 1 和 0.35 之间来回，2.4 秒一个周期（和桌面一样）。
// 系统开着“减少动态效果”时不动。用原生驱动，不占 JS 线程
import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, Easing } from 'react-native'

const PERIOD_MS = 2400

/** 系统是不是开着“减少动态效果” */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false)
  useEffect(() => {
    let alive = true
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (alive) setReduce(value)
      })
      .catch(() => {})
    const listener = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce)
    return () => {
      alive = false
      listener.remove()
    }
  }, [])
  return reduce
}

/** 呼吸的不透明度。paused 为真（比如按着）时停在当前的样子 */
export function useBreath(paused = false): Animated.Value {
  const value = useRef(new Animated.Value(1)).current
  const reduce = useReduceMotion()
  useEffect(() => {
    if (reduce || paused) {
      if (reduce) value.setValue(1)
      return
    }
    const half = (to: number) =>
      Animated.timing(value, {
        toValue: to,
        duration: PERIOD_MS / 2,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      })
    const loop = Animated.loop(Animated.sequence([half(0.35), half(1)]))
    loop.start()
    return () => loop.stop()
  }, [value, reduce, paused])
  return value
}
