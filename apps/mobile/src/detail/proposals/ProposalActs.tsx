// 一张等着的提案上的“开始”“在这里做”“改了再开始”“不要”四个按钮，和没做成时的那句话。对话里的卡片和建议任务列表共用。
// offer 卡的“新会话”“在这里做”在下面的 OfferActs。“改了再开始”是单独一页（src/screens/proposals/ProposalStartScreen.tsx）。
import { type DeviceView, keys, type SessionSummary } from '@litch/core'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { StyleSheet, Text, View } from 'react-native'
import type { RootStackParamList } from '../../nav/routes'
import { useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'
import { useProposalAct } from './hooks'

export function ProposalActs({
  deviceId,
  sessionId,
  proposalId,
}: {
  deviceId: string
  sessionId: string
  proposalId: string
}) {
  const { c, font } = useTheme()
  const t = useT()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const device = useKey<DeviceView>(keys.device(deviceId))
  // “改了再开始”那一页要父会话的摘要（harness、项目、目录）
  const parent = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const act = useProposalAct(deviceId, sessionId, proposalId)
  const off = act.busy || device?.connection !== 'online'
  return (
    <>
      <View style={styles.acts}>
        <Button
          label={t('proposal.start')}
          disabled={off}
          busy={act.busy}
          onPress={() => act.accept()}
          testID={`proposal:${proposalId}:start`}
        />
        <Button
          kind="plain"
          label={t('proposal.here')}
          disabled={off}
          onPress={() => act.here()}
          testID={`proposal:${proposalId}:here`}
        />
        <Button
          kind="plain"
          label={t('proposal.edit')}
          disabled={off || !parent}
          onPress={() => navigation.navigate('ProposalStart', { deviceId, sessionId, proposalId })}
          testID={`proposal:${proposalId}:edit`}
        />
        <Button
          kind="plain"
          label={t('proposal.dismiss')}
          disabled={off}
          onPress={() => act.dismiss()}
          testID={`proposal:${proposalId}:dismiss`}
        />
      </View>
      {act.failure ? (
        <Text style={[styles.failure, { color: c.err, fontSize: font.size.meta }]}>
          {act.failure}
        </Text>
      ) : null}
    </>
  )
}

const styles = StyleSheet.create({
  acts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  failure: { lineHeight: 19 },
})

/** offer 卡上的“新会话”“在这里做”（模型那次调用一直等着这个选择），和没做成时的那句话 */
export function OfferActs({
  deviceId,
  sessionId,
  proposalId,
}: {
  deviceId: string
  sessionId: string
  proposalId: string
}) {
  const { c, font } = useTheme()
  const t = useT()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const act = useProposalAct(deviceId, sessionId, proposalId)
  const off = act.busy || device?.connection !== 'online'
  return (
    <>
      <View style={styles.acts}>
        <Button
          label={t('proposals.offer.session')}
          disabled={off}
          busy={act.busy}
          onPress={() => act.answer('session')}
          testID={`proposal:${proposalId}:session`}
        />
        <Button
          kind="plain"
          label={t('proposals.offer.here')}
          disabled={off}
          onPress={() => act.answer('here')}
          testID={`proposal:${proposalId}:here`}
        />
      </View>
      {act.failure ? (
        <Text style={[styles.failure, { color: c.err, fontSize: font.size.meta }]}>
          {act.failure}
        </Text>
      ) : null}
    </>
  )
}
