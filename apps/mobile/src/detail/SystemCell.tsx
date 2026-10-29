// Litch 替用户发的话（核心认出来的 UserMessageItem.system：定时任务触发、子会话启动时的简报、提案卡上点的“在这里做”）：
// 不画成用户的气泡，收成一行（CompactRow，同子会话回报那一条）：来源和类型、简略内容；
// 点一下在原处展开发给模型的原文（简报的先写来自哪个会话，还在列表里的点了过去），再点收起（展开状态记在行上，同思考那一行）
import { keys, type SessionSummary, type SystemMessageView } from '@litch/core'
import { memo } from 'react'
import { StyleSheet, Text } from 'react-native'
import { useKey } from '../shell/services'
import { useT } from '../ui/i18n'
import { useTheme } from '../ui/theme'
import { CompactRow } from './CompactRow'
import type { Props } from './cells'
import { useToggleInPlace, useTranscript } from './context'

const MARK = { scheduledTask: '◷', briefing: '⑂', here: '↳' } as const

/** 展开后补一行：手动运行，启动指令来自哪个会话（还在列表里的点了过去）。没有就不画 */
function Detail({ system }: { system: SystemMessageView }) {
  const { c, font } = useTheme()
  const t = useT()
  const { deviceId, openSession } = useTranscript()
  const parent = system.kind === 'briefing' ? system.parent : null
  const listed = useKey<SessionSummary>(keys.summary(deviceId, parent?.id ?? ''))
  if (system.kind === 'scheduledTask' && system.manual)
    return (
      <Text style={[styles.detail, { color: c.ink3, fontSize: font.size.meta }]}>
        {t('sysmsg.manual')}
      </Text>
    )
  if (!parent) return null
  const name = parent.title || (listed ? t.text(listed.title) : parent.id)
  return (
    <Text
      numberOfLines={1}
      style={[styles.detail, { color: listed ? c.accent : c.ink3, fontSize: font.size.meta }]}
      onPress={listed ? () => openSession(parent.id) : undefined}
      accessibilityHint={listed ? t('sysmsg.openParentHint') : undefined}
    >
      {t('sysmsg.from', { name })}
    </Text>
  )
}

export const SystemCell = memo(function SystemCell({ row }: Props<'system'>) {
  const { c, font } = useTheme()
  const t = useT()
  const toggle = useToggleInPlace()
  const { system } = row
  const title = system.kind === 'scheduledTask' ? '' : system.title
  const source =
    system.kind === 'scheduledTask'
      ? t('sysmsg.scheduledTask', { name: system.task })
      : system.kind === 'briefing'
        ? t(`sysmsg.briefing.${system.mode}`)
        : t('sysmsg.here')
  return (
    <CompactRow
      testID={`system-message:${system.kind}`}
      mark={MARK[system.kind]}
      source={source}
      summary={[title, system.prompt].filter(Boolean).join(' · ')}
      open={row.expanded === true}
      onPress={() => toggle(row.key, row.turnId)}
    >
      <Detail system={system} />
      <Text selectable style={[styles.body, { color: c.ink2, fontSize: font.size.meta }]}>
        {row.text}
      </Text>
    </CompactRow>
  )
})

const styles = StyleSheet.create({
  detail: { paddingBottom: 2 },
  body: { lineHeight: 18, paddingBottom: 4 },
})
