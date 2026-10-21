// 不是用户发起的回合开头那一行，放在用户气泡的位置（照桌面端的 TurnOrigin）：“↻ 后台任务结束，自动继续”，
// 后面是叫醒它的那个任务（这一回合开始前最后结束的那个，找不到就不写）；定时任务触发的写“定时任务触发”。
import { wokenBy } from '@litch/core'
import { memo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import type { Props } from '../cells'
import { useBackgroundView } from '../context'

export const OriginCell = memo(function OriginCell({ row }: Props<'origin'>) {
  const { c, font } = useTheme()
  const t = useT()
  const background = useBackgroundView()
  const by = row.origin === 'backgroundTask' ? wokenBy(background, row) : null
  return (
    <View style={styles.wrap} testID={`turn-origin:${row.origin}`}>
      <Text numberOfLines={1} style={[styles.line, { color: c.ink3, fontSize: font.size.meta }]}>
        <Text style={{ color: c.accent }}>↻ </Text>
        {t(`background.origin.${row.origin}`)}
        {by ? <Text style={{ fontFamily: font.mono }}>{` ${by.title}`}</Text> : null}
      </Text>
    </View>
  )
})

const styles = StyleSheet.create({
  wrap: { alignItems: 'flex-end', paddingHorizontal: 16, paddingVertical: 6 },
  line: { maxWidth: '85%' },
})
