// 用户消息的交付状态（排队、停止待发、状态待确认）：一个小记号，放在气泡左边、不占一行。
// 读屏名称是整句说明；给了 onPress 时点一下在对话区底部闪出这句说明。已发送不画。
import { Pressable, StyleSheet } from 'react-native'
import { useT } from '../ui/i18n'
import { Icon } from '../ui/kit/Icon'
import { useTheme } from '../ui/theme'

/** 等着发（钟）、停了（暂停）、说不准（圈 i）：和桌面的三个图标同义 */
const MARK = { queued: 'clock', held: 'pause', unknown: 'info' } as const

type Delivery = 'queued' | 'sent' | 'held' | 'unknown'

export function DeliveryMark({
  delivery,
  onPress,
}: {
  delivery: Delivery | null | undefined
  onPress?(note: string): void
}) {
  const t = useT()
  const { c } = useTheme()
  if (!delivery || delivery === 'sent') return null
  const note = t(`inputDelivery.${delivery}.note`)
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : 'text'}
      aria-label={note}
      disabled={!onPress}
      testID={`input-delivery-${delivery}`}
      // 记号小，四边放宽到可点 44
      hitSlop={10}
      {...(onPress ? { onPress: () => onPress(note) } : {})}
      style={styles.mark}
    >
      <Icon name={MARK[delivery]} size={14} color={delivery === 'unknown' ? c.wait : c.ink3} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  mark: { minWidth: 24, minHeight: 24, alignItems: 'center', justifyContent: 'center' },
})
