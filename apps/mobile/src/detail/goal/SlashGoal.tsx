// 输入框上方的斜杠单子（手机上眼下只有 /goal 一项）：harness 会持续目标、输入框里刚打了 / 开头的一个词时出现，
// 点一下输入框里换成 `/goal `，接着写要做到的事。说明文字用桌面斜杠单子的那一句
import { Pressable, StyleSheet, Text } from 'react-native'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import { GOAL_PREFIX, slashGoalShown } from './logic'

export function SlashGoal({
  text,
  able,
  onPick,
}: {
  text: string
  able: boolean
  onPick(text: string): void
}) {
  const t = useT()
  const theme = useTheme()
  const { c, font } = theme
  if (!slashGoalShown(text, able)) return null
  return (
    <Pressable
      accessibilityRole="button"
      testID="slash:goal"
      onPress={() => onPick(GOAL_PREFIX)}
      style={[styles.row, { borderColor: c.line3, borderRadius: theme.radius }]}
    >
      <Text style={{ color: c.accent, fontFamily: font.mono, fontSize: font.size.meta }}>
        /goal
      </Text>
      <Text numberOfLines={2} style={[styles.note, { color: c.ink2, fontSize: font.size.meta }]}>
        {t('slash.goal')}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 40,
    paddingHorizontal: 10,
    marginHorizontal: 12,
    marginBottom: 6,
    borderWidth: 1,
  },
  note: { flex: 1 },
})
