// 对话里的交接卡（litch_sessions.hand_off）：做到一半来了无关的新消息，模型把手上的任务连同剩下的计划
// 交给了一个分叉会话（不出提案卡，立刻开始）。写“交给了分叉会话”和任务的标题，下面一行是那个分叉会话，点了进去。
// 调用还没完时写“正在交给分叉会话”；失败了不画成这张，照普通工具调用画（原因在那里）。
import { memo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import type { Props } from '../cells'
import { ChildLine } from './ChildLine'

export const HandoffCell = memo(function HandoffCell({ row }: Props<'handoff'>) {
  const { c, font } = useTheme()
  const t = useT()
  return (
    <View
      testID={`handoff:${row.itemId}`}
      style={[styles.card, { borderColor: c.line2, backgroundColor: c.raised }]}
    >
      <View style={styles.body}>
        <Text style={[styles.kind, { color: c.ink3, fontFamily: font.mono }]}>
          ⑂ {t(row.running ? 'proposals.handoff.running' : 'proposals.handoff.kind')}
        </Text>
        {row.title ? (
          <Text style={[styles.title, { color: c.ink, fontSize: font.size.body }]}>
            {row.title}
          </Text>
        ) : null}
      </View>
      {row.threadId ? (
        <ChildLine
          childId={row.threadId}
          fallback={row.title}
          testID={`handoff:${row.itemId}:child`}
        />
      ) : null}
    </View>
  )
})

const styles = StyleSheet.create({
  card: { marginHorizontal: 16, marginVertical: 6, borderWidth: 1 },
  body: { padding: 12, gap: 6 },
  kind: { fontSize: 11 },
  title: { fontWeight: '600', lineHeight: 21 },
})
