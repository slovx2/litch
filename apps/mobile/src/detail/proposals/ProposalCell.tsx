// 对话里的提案卡（建议任务）：收尾调用带的每条建议、litch_sessions.start 降成的提案各一张。
// 标题、harness / 模型 / 目录、简报（长的折起来，点了展开）、状态（等你开始、已开始、不要了、撤回了、过期了），
// 沙箱收不紧时的提醒；等着的有“开始”“改了再开始”“不要”。已开始的下面一行是实际起出来的子会话
// （它的 harness 和目录照子会话本身写，不照提案），点了进去。列表页点一条回来时这张描一圈。
import {
  type DeviceView,
  keys,
  type ProposalStarts,
  proposalStatus,
  type SessionSummary,
} from '@litch/core'
import { memo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { SANDBOX_LEVEL } from '../../../../../packages/ui/src/tree/sandbox.ts'
import { badgeOf, titleOf } from '../../screens/sessions/rows'
import { useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { StatusMark } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'
import type { Props } from '../cells'
import { useTranscript } from '../context'
import { useFlashed, useProposalClock } from './hooks'
import { isLongBrief, STATUS_TEXT } from './logic'
import { ProposalActs } from './ProposalActs'

const MARK = { running: 'running', waiting: 'waiting', error: 'error', idle: 'idle' } as const

export const ProposalCell = memo(function ProposalCell({ row }: Props<'proposal'>) {
  const theme = useTheme()
  const { c, font } = theme
  const t = useT()
  const { deviceId, sessionId, openSession } = useTranscript()
  const { proposal, spawned } = row
  const proposalId = proposal?.id ?? spawned?.proposalId ?? ''
  const device = useKey<DeviceView>(keys.device(deviceId))
  const parent = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const starts = useKey<ProposalStarts>(keys.proposalStarts(deviceId))
  const childId = proposal?.startedId ?? starts?.[proposalId] ?? ''
  const child = useKey<SessionSummary>(keys.summary(deviceId, childId))
  const now = useProposalClock([proposal])
  const lit = useFlashed(proposalId || undefined)
  const [unfolded, setUnfolded] = useState(false)
  // 列表里还没有这一张：开始了的看侧栏里谁记着从它开始，否则说不清
  const status = proposal ? proposalStatus(proposal, now) : childId ? 'started' : null
  const title = proposal?.title ?? spawned?.title ?? ''
  const prompt = proposal?.prompt ?? spawned?.prompt ?? ''
  const harness = proposal?.harness ?? spawned?.harness ?? parent?.harness ?? null
  const model = proposal?.model ?? spawned?.model ?? null
  const cwd = proposal?.cwd ?? spawned?.cwd ?? null
  const kind = proposal?.kind ?? spawned?.kind ?? 'fresh'
  const long = isLongBrief(prompt)
  const waiting = status === 'pending' && proposal !== null
  const nameOf = (id: string) => device?.harnesses.find((entry) => entry.id === id)?.name ?? id
  const meta = [
    harness ? nameOf(harness) : null,
    model,
    cwd,
    t(kind === 'fork' ? 'proposal.fork' : 'proposal.fresh'),
  ].filter(Boolean)
  return (
    <View
      testID={`proposal:${proposalId}`}
      style={[
        styles.card,
        {
          borderColor: lit ? c.accent : waiting ? c.line3 : c.line2,
          borderWidth: lit ? 2 : 1,
          backgroundColor: c.raised,
        },
      ]}
    >
      <View style={styles.body}>
        <View style={styles.head}>
          <Text style={[styles.kind, { color: c.ink3, fontFamily: font.mono }]}>
            ◇ {t('proposal.kind')}
          </Text>
          {status ? (
            <Text
              testID={`proposal:${proposalId}:state`}
              style={[
                styles.state,
                { color: status === 'pending' ? c.wait : c.ink3, fontFamily: font.mono },
              ]}
            >
              {t(STATUS_TEXT[status])}
            </Text>
          ) : null}
        </View>
        <Text style={[styles.title, { color: c.ink, fontSize: font.size.body }]}>{title}</Text>
        <View style={styles.meta}>
          {harness ? (
            <Text
              style={[styles.badge, { color: c.ink2, borderColor: c.line2, fontFamily: font.mono }]}
            >
              {badgeOf(device, harness)}
            </Text>
          ) : null}
          <Text style={[styles.metaText, { color: c.ink2 }]} numberOfLines={2}>
            {meta.join(' · ')}
          </Text>
        </View>
        {prompt ? (
          <Pressable
            disabled={!long}
            accessibilityRole={long ? 'button' : undefined}
            accessibilityState={long ? { expanded: unfolded } : undefined}
            onPress={() => setUnfolded(!unfolded)}
            testID={`proposal:${proposalId}:brief`}
          >
            <Text
              numberOfLines={long && !unfolded ? 4 : undefined}
              style={[styles.brief, { color: c.ink2, fontSize: font.size.meta }]}
            >
              {prompt}
            </Text>
            {long ? (
              <Text style={[styles.more, { color: c.accent, fontSize: font.size.meta }]}>
                {t(unfolded ? 'proposal.brief.less' : 'proposal.brief.more')}
              </Text>
            ) : null}
          </Pressable>
        ) : null}
        {waiting && proposal.widerSandbox ? (
          <Text style={[styles.wider, { color: c.wait, fontSize: font.size.meta }]}>
            {t('proposal.wider', { level: t(SANDBOX_LEVEL[proposal.widerSandbox]) })}
          </Text>
        ) : null}
        {waiting ? (
          <ProposalActs deviceId={deviceId} sessionId={sessionId} proposalId={proposalId} />
        ) : null}
      </View>
      {status === 'started' && childId ? (
        <Pressable
          accessibilityRole="button"
          accessibilityHint={t('tree.child.open')}
          disabled={!child}
          onPress={() => openSession(childId)}
          testID={`proposal:${proposalId}:child`}
          style={({ pressed }) => [
            styles.child,
            { borderTopColor: c.line1, backgroundColor: pressed ? c.press : 'transparent' },
          ]}
        >
          {child ? (
            <>
              <StatusMark status={MARK[child.status]} />
              <View style={styles.childText}>
                <Text numberOfLines={1} style={{ color: c.ink, fontSize: font.size.meta + 1 }}>
                  {titleOf(child, t) || title}
                </Text>
                <Text
                  numberOfLines={1}
                  style={[styles.childMeta, { color: c.ink3, fontFamily: font.mono }]}
                >
                  {[nameOf(child.harness), child.cwd].filter(Boolean).join(' · ')}
                </Text>
              </View>
              <Text style={[styles.childState, { color: c.ink3 }]}>
                {t(`tree.status.${child.status}`)} ›
              </Text>
            </>
          ) : (
            <Text style={{ color: c.ink3, fontSize: font.size.meta }}>{t('tree.child.gone')}</Text>
          )}
        </Pressable>
      ) : null}
    </View>
  )
})

const styles = StyleSheet.create({
  card: { marginHorizontal: 16, marginVertical: 6 },
  body: { padding: 12, gap: 6 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  kind: { flex: 1, fontSize: 11 },
  state: { fontSize: 11 },
  title: { fontWeight: '600', lineHeight: 21 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  badge: { fontSize: 10, borderWidth: 1, paddingHorizontal: 4, paddingVertical: 1 },
  metaText: { flex: 1, fontSize: 12 },
  brief: { lineHeight: 19 },
  more: { marginTop: 2 },
  wider: { lineHeight: 19 },
  child: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  childText: { flex: 1, minWidth: 0 },
  childMeta: { fontSize: 11, marginTop: 2 },
  childState: { fontSize: 12 },
})
