// 看板卡片开合的过渡（手机）：用系统的布局动画，状态照常立刻生效，只是位置和尺寸平滑过去。
// 偏好减少动态时不做。
import { AccessibilityInfo, LayoutAnimation } from 'react-native'

/** 过渡时长（毫秒），与桌面一致 */
export const MOTION_MS = 200

let reduced = false
let watching = false
function watch() {
  if (watching) return
  watching = true
  void AccessibilityInfo.isReduceMotionEnabled().then(
    (value) => {
      reduced = value
    },
    () => {},
  )
  AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
    reduced = value
  })
}

/** 下一次布局变化做过渡：卡片长高缩短、下方的卡跟着挪，新出现的淡入 */
export function animateNextLayout() {
  watch()
  if (reduced) return
  LayoutAnimation.configureNext(
    LayoutAnimation.create(
      MOTION_MS,
      LayoutAnimation.Types.easeInEaseOut,
      LayoutAnimation.Properties.opacity,
    ),
  )
}
