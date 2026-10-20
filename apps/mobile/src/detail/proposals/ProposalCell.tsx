// 对话里的提案卡（建议任务）：收尾调用带的每条建议、litch_sessions.start 降成的提案各一张。
// 标题、harness / 模型 / 目录、简报（长的折起来，点了展开）、状态（等你开始、已开始、不要了、撤回了、过期了），
// 沙箱收不紧时的提醒；等着的有“开始”“改了再开始”“不要”。已开始的下面一行是实际起出来的子会话
// （它的 harness 和目录照子会话本身写，不照提案），点了进去。列表页点一条回来时这张描一圈。
// offer 卡（start 带 initiation offer，用户这条消息是和会话无关的新任务）：只有标题和一句说明，
// 等你选时有“新会话”“在这里做”；选了之后写等模型补简报、已开始（下面一行同上）、在这里做。
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
import { badgeOf } from '../../screens/sessions/rows'
import { useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import type { Props } from '../cells'
import { useTranscript } from '../context'
import { ChildLine } from './ChildLine'
import { useFlashed, useProposalClock } from './hooks'
import { isLongBrief, isOfferStatus, needsUser, STATUS_TEXT } from './logic'
import { OfferActs, ProposalActs } from './ProposalActs'

/** offer 卡上那句说明，按状态（已开始的不写，下面是子会话那一行） */
const OFFER_NOTE = {
  offered: 'proposals.offer.ask',
  chosen: 'proposals.offer.chosen',
  here: 'proposals.offer.here.note',
} as const

export const ProposalCell = memo(function ProposalCell({ row }: Props<'proposal'>) {
  const theme = useTheme()
  const { c, font } = theme
  const t = useT()
  const { deviceId, sessionId } = useTranscript()
  const { proposal, spawned } = row
  const proposalId = proposal?.id ?? spawned?.proposalId ?? ''
  const device = useKey<DeviceView>(keys.device(deviceId))
  const parent = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const starts = useKey<ProposalStarts>(keys.proposalStarts(deviceId))
  const childId = proposal?.startedId ?? starts?.[proposalId] ?? ''
  const now = useProposalClock([proposal])
  const lit = useFlashed(proposalId || undefined)
  const [unfolded, setUnfolded] = useState(false)
  // 列表里还没有这一张：开始了的看侧栏里谁记着从它开始；offer 的调用还没有结果（还在等你选），当作等你选；
  // 否则说不清
  const status = proposal
    ? proposalStatus(proposal, now)
    : childId
      ? 'started'
      : row.offer && !spawned?.proposalId
        ? 'offered'
        : null
  const offer = row.offer || (status !== null && isOfferStatus(status))
  const title = proposal?.title ?? spawned?.title ?? ''
  const prompt = proposal?.prompt ?? spawned?.prompt ?? ''
  const harness = proposal?.harness ?? spawned?.harness ?? parent?.harness ?? null
  const model = proposal?.model ?? spawned?.model ?? null
  const cwd = proposal?.cwd ?? spawned?.cwd ?? null
  const kind = proposal?.kind ?? spawned?.kind ?? 'fresh'
  const long = isLongBrief(prompt)
  // offer 卡在模型补上简报之前只有标题：不写 harness 那一行
  const shaped = !offer || prompt !== ''
  const waiting = status === 'pending' && proposal !== null
  const choosing = status === 'offered' && proposal !== null
  const note =
    offer && status !== null && status in OFFER_NOTE
      ? OFFER_NOTE[status as keyof typeof OFFER_NOTE]
      : null
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
          borderColor: lit ? c.accent : waiting || choosing ? c.line3 : c.line2,
          borderWidth: lit ? 2 : 1,
          backgroundColor: c.raised,
        },
      ]}
    >
      <View style={styles.body}>
        <View style={styles.head}>
          <Text style={[styles.kind, { color: c.ink3, fontFamily: font.mono }]}>
            ◇ {t(offer ? 'proposals.offer.kind' : 'proposal.kind')}
          </Text>
          {status ? (
            <Text
              testID={`proposal:${proposalId}:state`}
              style={[
                styles.state,
                { color: needsUser(status) ? c.wait : c.ink3, fontFamily: font.mono },
              ]}
            >
              {t(STATUS_TEXT[status])}
            </Text>
          ) : null}
        </View>
        <Text style={[styles.title, { color: c.ink, fontSize: font.size.body }]}>{title}</Text>
        {note ? (
          <Text
            testID={`proposal:${proposalId}:note`}
            style={[styles.note, { color: c.ink2, fontSize: font.size.meta }]}
          >
            {t(note)}
          </Text>
        ) : null}
        {shaped ? (
          <View style={styles.meta}>
            {harness ? (
              <Text
                style={[
                  styles.badge,
                  { color: c.ink2, borderColor: c.line2, fontFamily: font.mono },
                ]}
              >
                {badgeOf(device, harness)}
              </Text>
            ) : null}
            <Text style={[styles.metaText, { color: c.ink2 }]} numberOfLines={2}>
              {meta.join(' · ')}
            </Text>
          </View>
        ) : null}
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
        {choosing ? (
          <OfferActs deviceId={deviceId} sessionId={sessionId} proposalId={proposalId} />
        ) : null}
      </View>
      {status === 'started' && childId ? (
        <ChildLine childId={childId} fallback={title} testID={`proposal:${proposalId}:child`} />
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
  note: { lineHeight: 19 },
})
