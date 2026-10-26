// Litch 替用户发的话（核心认出来的 UserMessageItem.system：定时任务触发、子会话启动时的简报、提案卡上点的“在这里做”）：
// 不画成用户的气泡，画成一张系统卡片，样子同子会话回报那一条（proposals/EventCell.tsx）：
// 第一行是来源和类型（简报的还写来自哪个会话，还在列表里的点了过去），下面两行简略内容，
// 点一下在原处展开发给模型的原文，再点收起（展开状态记在行上，同思考那一行）
import { keys, type SessionSummary, type SystemMessageView } from '@litch/core'
import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useKey } from '../shell/services'
import { useT } from '../ui/i18n'
import { useTheme } from '../ui/theme'
import type { Props } from './cells'
import { useToggleInPlace, useTranscript } from './context'

const MARK = { scheduledTask: '◷', briefing: '⑂', here: '↳' } as const

function Head({ system }: { system: SystemMessageView }) {
  const { c, font } = useTheme()
  const t = useT()
  const { deviceId, openSession } = useTranscript()
  const parent = system.kind === 'briefing' ? system.parent : null
  const listed = useKey<SessionSummary>(keys.summary(deviceId, parent?.id ?? ''))
  const head =
    system.kind === 'scheduledTask'
      ? `${t('sysmsg.scheduledTask', { name: system.task })}${system.manual ? ` · ${t('sysmsg.manual')}` : ''}`
      : system.kind === 'briefing'
        ? t(`sysmsg.briefing.${system.mode}`)
        : t('sysmsg.here')
  const name = parent ? parent.title || (listed ? t.text(listed.title) : parent.id) : ''
  return (
    <Text numberOfLines={1} style={[styles.head, { color: c.ink3, fontFamily: font.mono }]}>
      {`${MARK[system.kind]} ${head}`}
      {parent ? (
        <Text
          style={{ color: listed ? c.accent : c.ink3 }}
          onPress={listed ? () => openSession(parent.id) : undefined}
          accessibilityHint={listed ? t('sysmsg.openParentHint') : undefined}
        >
          {` · ${t('sysmsg.from', { name })}`}
        </Text>
      ) : null}
    </Text>
  )
}

export const SystemCell = memo(function SystemCell({ row }: Props<'system'>) {
  const { c, font } = useTheme()
  const t = useT()
  const toggle = useToggleInPlace()
  const { system } = row
  const title = system.kind === 'scheduledTask' ? '' : system.title
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: row.expanded }}
      onPress={() => toggle(row.key, row.turnId)}
      testID={`system-message:${system.kind}`}
      style={({ pressed }) => [
        styles.bar,
        { borderLeftColor: c.line2 },
        pressed ? { backgroundColor: c.press } : null,
      ]}
    >
      <Head system={system} />
      {row.expanded ? (
        <Text selectable style={[styles.body, { color: c.ink2, fontSize: font.size.meta }]}>
          {row.text}
        </Text>
      ) : (
        <Text numberOfLines={2} style={[styles.body, { color: c.ink2, fontSize: font.size.meta }]}>
          {title ? <Text style={{ color: c.ink, fontWeight: '600' }}>{`${title} `}</Text> : null}
          {system.prompt}
        </Text>
      )}
      <View style={styles.foot}>
        <Text style={{ color: c.accent, fontSize: font.size.small + 1 }}>
          {t(row.expanded ? 'sysmsg.collapse' : 'sysmsg.expand')}
        </Text>
      </View>
    </Pressable>
  )
})

const styles = StyleSheet.create({
  bar: { marginHorizontal: 16, marginVertical: 4, paddingLeft: 10, borderLeftWidth: 2, gap: 2 },
  head: { fontSize: 12, paddingVertical: 2 },
  body: { lineHeight: 18 },
  foot: { paddingVertical: 2 },
})
