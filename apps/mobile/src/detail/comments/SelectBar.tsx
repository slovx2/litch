// 选字回复时输入区上面的一行：说怎么选、怎么回复，右边“完成”退出选字。评论满了加不上时这一行改说满了。
// 只在有回答正在选字（hub.selecting）时出现。
import { MAX_COMMENTS } from '@litch/core'
import { StyleSheet, Text, View } from 'react-native'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'
import { useHubValue } from './context'
import type { CommentsHub } from './hub'

export function SelectBar({ hub }: { hub: CommentsHub }) {
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  const selecting = useHubValue(hub, (each) => each.selecting !== null, false)
  const full = useHubValue(hub, (each) => each.replyFull, false)
  if (!selecting) return null
  return (
    <View
      testID="select-bar"
      style={[styles.bar, { borderTopColor: c.line2, backgroundColor: c.panel }]}
    >
      <Text style={[styles.hint, { color: full ? c.err : c.ink2 }]} numberOfLines={2}>
        {full ? t('comment.full', { max: MAX_COMMENTS }) : t('comment.select.hint')}
      </Text>
      <Button
        kind="plain"
        label={t('comment.select.done')}
        testID="select-bar:done"
        onPress={() => hub.select(null)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderTopWidth: 1,
  },
  hint: { flex: 1, fontSize: 13, lineHeight: 18 },
})
