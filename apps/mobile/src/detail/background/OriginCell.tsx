// 不是用户发起的回合开头那一行，与所属过程靠左相接（照桌面端的 TurnOrigin）：“↻ 后台任务结束，自动继续”，
// 后面是叫醒它的那个任务（这一回合开始前最后结束的那个，找不到就不写）；定时任务触发的写“定时任务触发”。
import { wokenBy } from '@litch/core'
import { memo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useT } from '../../ui/i18n'
import { Icon } from '../../ui/kit/Icon'
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
      <Icon name="reload" size={13} color={c.accent} />
      <Text numberOfLines={1} style={{ flexShrink: 1, color: c.ink2, fontSize: font.size.meta }}>
        {t(`background.origin.${row.origin}`)}
        {by ? <Text style={{ fontFamily: font.mono }}>{` ${by.title}`}</Text> : null}
      </Text>
    </View>
  )
})

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 0,
  },
})
