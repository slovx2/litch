import { Animated, type TextProps } from 'react-native'
import { useBreath } from './breath'

/** 只让状态记号呼吸，旁边的正文保持稳定；静态时仍保留原有颜色和形状。 */
export function BreathingText({ active, style, ...props }: TextProps & { active: boolean }) {
  const opacity = useBreath(!active)
  return <Animated.Text {...props} style={[style, { opacity }]} />
}
