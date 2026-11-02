// 上下文用量的小圆环：按百分比顺时针填满，放在输入框那一行里，不另占高度。点了打开用量页（具体数字）。
// 没有画矢量图的依赖：用“两个半环各自裁在左右两半里、按进度转过去”的办法画。半环是上、右两条边着色的圆，
// 转 45° 正好盖住右半边；右半边管 0–50%，左半边管 50–100%。
import { Pressable, StyleSheet, View } from 'react-native'
import { useT } from '../../ui/i18n'
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

export function UsageRing({ percent, onPress }: { percent: number; onPress?(): void }) {
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  const share = Math.max(0, Math.min(100, percent)) / 100
  // 快满了换成提醒的颜色
  const color = percent >= 80 ? c.wait : c.accent
  const label = t('compose.ring', { n: percent })
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : 'text'}
      aria-label={label}
      disabled={!onPress}
      testID="settings:usage"
      // 和“+”一样：40 宽、随输入框那一排拉高（至少 40），四边再放 6，可点的范围 52
      hitSlop={6}
      {...(onPress ? { onPress } : {})}
      style={({ pressed }) => [
        styles.hit,
        { borderRadius: theme.radius.m },
        pressed ? { backgroundColor: c.press } : null,
      ]}
    >
      <View style={styles.ring}>
        <View style={[styles.track, { borderColor: c.line2 }]} />
        {/* 右半边：进度 0 时整个半环转到左边、裁掉看不见；到 50% 正好盖满 */}
        <Half side="right" turn={-180 + Math.min(share, 0.5) * 360} color={color} />
        <Half side="left" turn={Math.max(share - 0.5, 0) * 360} color={color} />
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  hit: { width: 40, alignItems: 'center', justifyContent: 'center' },
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
