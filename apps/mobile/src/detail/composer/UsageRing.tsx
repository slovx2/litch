// “+”菜单的上下文用量图形；交互和读屏由外层菜单项统一承担。
// 没有画矢量图的依赖：用“两个半环各自裁在左右两半里、按进度转过去”的办法画。半环是上、右两条边着色的圆，
// 转 45° 正好盖住右半边；右半边管 0–50%，左半边管 50–100%。
import { StyleSheet, View } from 'react-native'
import { useTheme } from '../../ui/theme'

const SIZE = 20
const WIDTH = 3

function Half({ side, turn, color }: { side: 'left' | 'right'; turn: number; color: string }) {
  return (
    <View style={[styles.clip, side === 'right' ? { left: SIZE / 2 } : { left: 0 }]}>
      <View
        style={[
          styles.half,
          side === 'right' ? { left: -SIZE / 2 } : { left: 0 },
          {
            borderTopColor: color,
            borderRightColor: color,
            transform: [{ rotate: `${45 + turn}deg` }],
          },
        ]}
      />
    </View>
  )
}

export function UsageRing({ percent }: { percent: number }) {
  const theme = useTheme()
  const { c } = theme
  const share = Math.max(0, Math.min(100, percent)) / 100
  // 快满了换成提醒的颜色
  const color = percent >= 80 ? c.wait : c.accent
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      testID="usage:menu-ring"
    >
      <View style={styles.ring}>
        <View style={[styles.track, { borderColor: c.line2 }]} />
        {/* 右半边：进度 0 时整个半环转到左边、裁掉看不见；到 50% 正好盖满 */}
        <Half side="right" turn={-180 + Math.min(share, 0.5) * 360} color={color} />
        <Half side="left" turn={Math.max(share - 0.5, 0) * 360} color={color} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  ring: { width: SIZE, height: SIZE },
  track: {
    position: 'absolute',
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    borderWidth: WIDTH,
  },
  clip: { position: 'absolute', top: 0, width: SIZE / 2, height: SIZE, overflow: 'hidden' },
  half: {
    position: 'absolute',
    top: 0,
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    borderWidth: WIDTH,
    borderColor: 'transparent',
  },
})
