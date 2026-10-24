// 一个会话里的建议任务：模型提的全部提案。没了结的在上（先提的在前），每条能开始、改了再开始、不要，
// offer 卡等你选的能选“新会话”“在这里做”，选了新会话等模型补简报的也在上面；
// 了结的（开始了、在这里做、不要了、撤回了、过期了）在下（刚了结的在前），可以收起来。点一条回到对话里那张卡片
// （对话区滚过去、描一圈，见 src/detail/proposals/hooks.ts 的 requestReveal）。
// 从会话详情顶上那一条（有等着的时候）或者右上角菜单里的“建议任务”进来。
import { type DeviceView, keys, proposalStatus, type SessionProposalView } from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { requestReveal, useProposalClock, useProposalList } from '../../detail/proposals/hooks'
import { arrange, needsUser, STATUS_TEXT } from '../../detail/proposals/logic'
import { OfferActs, ProposalActs } from '../../detail/proposals/ProposalActs'
import type { RootStackParamList } from '../../nav/routes'
import { useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Empty, SectionLabel } from '../../ui/kit/controls'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'
import { badgeOf } from '../sessions/rows'

type Props = NativeStackScreenProps<RootStackParamList, 'Proposals'>

export function ProposalsScreen({ route, navigation }: Props) {
  const { deviceId, sessionId, title } = route.params
  const t = useT()
  const { c } = useTheme()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const list = useProposalList(deviceId, sessionId)
  const now = useProposalClock(list)
  const [folded, setFolded] = useState(false)
  const reveal = (proposal: SessionProposalView) => {
    requestReveal(deviceId, sessionId, proposal.id)
    navigation.goBack()
  }
  const { pending, settled } = arrange(list ?? [], now)
  const row = (proposal: SessionProposalView) => (
    <ProposalRow
      key={proposal.id}
      deviceId={deviceId}
      sessionId={sessionId}
      proposal={proposal}
      now={now}
      onReveal={() => reveal(proposal)}
    />
  )
  return (
    <Screen
      title={t('proposals.title')}
      subtitle={title}
      wire={device ? c.wire[device.wire] : undefined}
      testID="proposals"
    >
      {!list || list.length === 0 ? (
        <Empty title={t('proposals.none')} />
      ) : (
        <ScrollView>
          <SectionLabel>{t('proposals.pending', { n: pending.length })}</SectionLabel>
          {pending.length > 0 ? (
            pending.map(row)
          ) : (
            <Text style={[styles.none, { color: c.ink3 }]}>{t('proposals.nonePending')}</Text>
          )}
          {settled.length > 0 ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: !folded }}
                onPress={() => setFolded(!folded)}
                testID="proposals:fold"
              >
                <SectionLabel right={<Text style={{ color: c.ink3 }}>{folded ? '▸' : '▾'}</Text>}>
                  {t('proposals.settled', { n: settled.length })}
                </SectionLabel>
              </Pressable>
              {folded ? null : settled.map(row)}
            </>
          ) : null}
        </ScrollView>
      )}
    </Screen>
  )
}

function ProposalRow({
  deviceId,
  sessionId,
  proposal,
  now,
  onReveal,
}: {
  deviceId: string
  sessionId: string
  proposal: SessionProposalView
  now: number
  onReveal(): void
}) {
  const t = useT()
  const theme = useTheme()
  const { c, font } = theme
  const device = useKey<DeviceView>(keys.device(deviceId))
  const status = proposalStatus(proposal, now)
  return (
    <View
      testID={`proposals:row:${proposal.id}`}
      style={[styles.row, { borderBottomColor: c.line1, backgroundColor: c.panel }]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityHint={t('proposal.reveal')}
        onPress={onReveal}
        testID={`proposals:reveal:${proposal.id}`}
        style={({ pressed }) => [styles.main, pressed ? { backgroundColor: c.press } : null]}
      >
        <View style={styles.line}>
          <Text
            numberOfLines={1}
            style={[styles.title, { color: c.ink, fontSize: font.size.body }]}
          >
            {proposal.title}
          </Text>
          <Text
            style={[
              styles.state,
              { color: needsUser(status) ? c.wait : c.ink3, fontFamily: font.mono },
            ]}
          >
            {t(STATUS_TEXT[status])}
          </Text>
        </View>
        <View style={styles.line}>
          {proposal.harness ? (
            <Text
              style={[
                styles.badge,
                {
                  color: c.ink2,
                  borderColor: c.line2,
                  fontFamily: font.mono,
                  borderRadius: theme.radius.s,
                },
              ]}
            >
              {badgeOf(device, proposal.harness)}
            </Text>
          ) : null}
          <Text numberOfLines={2} style={[styles.brief, { color: c.ink2 }]}>
            {proposal.prompt || (status === 'offered' ? t('proposals.offer.ask') : '')}
          </Text>
        </View>
      </Pressable>
      {status === 'pending' ? (
        <View style={styles.acts}>
          <ProposalActs
            deviceId={deviceId}
            sessionId={sessionId}
            proposalId={proposal.id}
            worktree={proposal.worktree ?? proposal.worktreeDefault}
          />
        </View>
      ) : null}
      {status === 'offered' ? (
        <View style={styles.acts}>
          <OfferActs
            deviceId={deviceId}
            sessionId={sessionId}
            proposalId={proposal.id}
            worktree={proposal.worktree ?? proposal.worktreeDefault}
          />
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  none: { fontSize: 14, paddingHorizontal: 16, paddingVertical: 12 },
  row: { borderBottomWidth: StyleSheet.hairlineWidth },
  main: { paddingHorizontal: 16, paddingVertical: 10, gap: 4 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, fontWeight: '500' },
  state: { fontSize: 11 },
  badge: { fontSize: 10, borderWidth: 1, paddingHorizontal: 4, paddingVertical: 1 },
  brief: { flex: 1, fontSize: 13, lineHeight: 18 },
  acts: { paddingHorizontal: 16, paddingBottom: 10 },
})
