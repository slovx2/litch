// 议题里“谁、什么时候”的一行：名字加粗，时间小一号、淡一档，中间留空不加分隔符；
// tag 是跟在后面的小状态（等待回复、失败），画成小标签，不单独占一行。
import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { stamp } from '../../../../../packages/ui/src/app/format.ts'
import { useT } from '../../ui/i18n'
import { BreathingText } from '../../ui/kit/BreathingText'
import { useTheme } from '../../ui/theme'

/** 文案里带的冒号（“经理：”）在这里去掉：名字和时间已经分开画了 */
export const speaker = (label: string) => label.replace(/[：:]\s*$/, '')

export function Byline({
  who,
  at,
  tag,
  lead,
}: {
  who: string
  at: number
  tag?: { text: string; tone: 'wait' | 'err'; testID?: string }
  /** 名字前的小东西（展开收起的箭头） */
  lead?: ReactNode
}) {
  const t = useT()
  const { c, font, radius } = useTheme()
  const color = tag?.tone === 'err' ? c.err : c.wait
  return (
    <View style={styles.row}>
      {lead}
      <Text style={{ color: c.ink, fontWeight: '600', fontSize: font.size.meta + 1 }}>
        {speaker(who)}
      </Text>
      <Text style={{ color: c.ink3, fontSize: font.size.small + 1 }}>
        {stamp(at, Date.now(), t.lang)}
      </Text>
      {tag ? (
        <BreathingText
          active={tag.tone === 'wait'}
          testID={tag.testID}
          style={[
            styles.tag,
            { color, borderColor: color, borderRadius: radius.s, fontSize: font.size.small },
          ]}
        >
          {tag.text}
        </BreathingText>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: 8, rowGap: 2 },
  tag: { borderWidth: 1, paddingHorizontal: 5, paddingVertical: 1, overflow: 'hidden' },
})
