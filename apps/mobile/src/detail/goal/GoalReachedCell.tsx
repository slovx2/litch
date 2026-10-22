// 达成目标的那一轮，最后一条回答下面的一行“◎ 目标已达成 · 用时 N”（照桌面的 goal/GoalReached.tsx）。
// 目标一达成核心就清掉它，输入框上方那一行没了，改在这里留一句；写不写由核心的 goalReachedIn 定（rows.ts）
import { memo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { goalTime } from '../../../../../packages/ui/src/goal/logic.ts'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import type { Props } from '../cells'

export const GoalReachedCell = memo(function GoalReachedCell({ row }: Props<'goalReached'>) {
  const { c, font } = useTheme()
  const t = useT()
  return (
    <View style={styles.wrap} testID="goal:reached">
      <Text numberOfLines={1} style={{ color: c.ink3, fontSize: font.size.meta }}>
        <Text style={{ color: c.ok }}>◎ </Text>
        {t('goal.reached', { time: goalTime(row.ms, t) })}
      </Text>
    </View>
  )
})

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 16, paddingVertical: 4 },
})
