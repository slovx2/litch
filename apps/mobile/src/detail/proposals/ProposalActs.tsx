// 一张等着的提案上的动作：卡上只放“开始”“在这里做”两个按钮，“编辑后开始”“忽略”收进“⋯”，和没做成时的那句话。
// 对话里的卡片把“⋯”放在右上角（和关闭任务卡那一项合在一起，ProposalCell.tsx），用 useProposalActs 加 ProposalActsRow；
// 建议任务列表和经理页没有标题行，用 ProposalActs，“⋯”排在按钮行末尾。
// offer 卡的“新会话”“在这里做”在下面的 OfferActs。“编辑后开始”是单独一页（src/screens/proposals/ProposalStartScreen.tsx）。
// 设备能建工作树时按钮行右边多一个“新工作树”开关（WorktreeSwitch，只写名字，说明在读屏提示和“编辑后开始”那一页），
// “开始”“新会话”照它带上。
import { type DeviceView, keys, type SessionSummary } from '@litch/core'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { type ReactNode, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { RootStackParamList } from '../../nav/routes'
import { useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { Sheet, type SheetAction } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'
import { useProposalAct } from './hooks'
import { useWorktreesOn, WorktreeSwitch } from './WorktreeSwitch'

/** 一张等着的提案：发出去的状态、工作树开关、收进“⋯”的几项 */
export function useProposalActs(
  deviceId: string,
  sessionId: string,
  proposalId: string,
  /** 工作树开关的初值：模型定的，没定是设备照父会话算的 */
  initial: boolean,
) {
  const t = useT()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const device = useKey<DeviceView>(keys.device(deviceId))
  // “编辑后开始”那一页要父会话的摘要（harness、项目、目录）
  const parent = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const act = useProposalAct(deviceId, sessionId, proposalId)
  const offline = device?.connection !== 'online'
  const off = act.busy || offline
  // 人没动过开关就跟着初值走：对话里的卡片先画、提案后到，初值会从“没有”变成设备算的缺省
  const [chosen, setWorktree] = useState<boolean | null>(null)
  const worktree = chosen ?? initial
  const worktrees = useWorktreesOn(deviceId)
  const gate = offline ? { disabled: t('devices.state.offline') } : {}
  // 正在开始或忽略时不给另一条路
  const menu: SheetAction[] = act.busy
    ? []
    : [
        ...(parent
          ? [
              {
                label: t('proposal.edit'),
                onPress: () =>
                  navigation.navigate('ProposalStart', { deviceId, sessionId, proposalId }),
                testID: `proposal:${proposalId}:edit`,
                ...gate,
              },
            ]
          : []),
        {
          label: t('proposal.dismiss'),
          onPress: () => act.dismiss(),
          testID: `proposal:${proposalId}:dismiss`,
          ...gate,
        },
      ]
  return { deviceId, proposalId, act, off, worktree, setWorktree, worktrees, menu }
}

export type ProposalActsState = ReturnType<typeof useProposalActs>

/** 按钮行：“开始”“在这里做”，右边是工作树开关和 tail（列表里的“⋯”） */
export function ProposalActsRow({ acts, tail }: { acts: ProposalActsState; tail?: ReactNode }) {
  const { c, font } = useTheme()
  const t = useT()
  const { deviceId, proposalId, act, off, worktree, worktrees } = acts
  return (
    <>
      <View style={styles.acts}>
        <Button
          label={t('proposal.start')}
          disabled={off}
          busy={act.busy}
          onPress={() => act.accept(worktrees ? { worktree } : undefined)}
          testID={`proposal:${proposalId}:start`}
        />
        <Button
          kind="plain"
          label={t('proposal.here')}
          disabled={off}
          onPress={() => act.here()}
          testID={`proposal:${proposalId}:here`}
        />
        <View style={styles.tail}>
          <WorktreeSwitch
            deviceId={deviceId}
            value={worktree}
            disabled={off}
            onChange={acts.setWorktree}
            testID={`proposal:${proposalId}:worktree`}
            compact
          />
          {tail}
        </View>
      </View>
      {act.failure ? (
        <Text style={[styles.failure, { color: c.err, fontSize: font.size.meta }]}>
          {act.failure}
        </Text>
      ) : null}
    </>
  )
}

/** 小的“⋯”按钮：点了出动作单 */
export function MoreButton({ onPress, testID }: { onPress(): void; testID: string }) {
  const { c, font } = useTheme()
  const t = useT()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('proposal.more')}
      hitSlop={{ top: 10, bottom: 10, left: 14, right: 14 }}
      onPress={onPress}
      style={({ pressed }) => [styles.more, pressed ? { backgroundColor: c.press } : null]}
      testID={testID}
    >
      <Text style={{ color: c.ink3, fontFamily: font.mono }}>⋯</Text>
    </Pressable>
  )
}

/** 没有标题行的地方（建议任务列表、经理页）：按钮行末尾自带“⋯” */
export function ProposalActs({
  deviceId,
  sessionId,
  proposalId,
  worktree,
}: {
  deviceId: string
  sessionId: string
  proposalId: string
  worktree: boolean
}) {
  const acts = useProposalActs(deviceId, sessionId, proposalId, worktree)
  const [open, setOpen] = useState(false)
  return (
    <>
      <ProposalActsRow
        acts={acts}
        tail={
          acts.menu.length > 0 ? (
            <MoreButton onPress={() => setOpen(true)} testID={`proposal:${proposalId}:more`} />
          ) : null
        }
      />
      <Sheet visible={open} actions={acts.menu} onClose={() => setOpen(false)} />
    </>
  )
}

const styles = StyleSheet.create({
  acts: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 4 },
  // 排不下时整块折到下一行，靠右
  tail: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 'auto' },
  more: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  failure: { lineHeight: 19 },
})

/** offer 卡上的“新会话”“在这里做”（模型那次调用一直等着这个选择），和没做成时的那句话 */
export function OfferActs({
  deviceId,
  sessionId,
  proposalId,
  worktree: initial,
}: {
  deviceId: string
  sessionId: string
  proposalId: string
  /** 选新会话时的工作树开关初值 */
  worktree: boolean
}) {
  const { c, font } = useTheme()
  const t = useT()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const act = useProposalAct(deviceId, sessionId, proposalId)
  const off = act.busy || device?.connection !== 'online'
  const [worktree, setWorktree] = useState(initial)
  const worktrees = useWorktreesOn(deviceId)
  return (
    <>
      <View style={styles.acts}>
        <Button
          label={t('proposals.offer.session')}
          disabled={off}
          busy={act.busy}
          onPress={() => act.answer('session', worktrees ? worktree : undefined)}
          testID={`proposal:${proposalId}:session`}
        />
        <Button
          kind="plain"
          label={t('proposals.offer.here')}
          disabled={off}
          onPress={() => act.answer('here')}
          testID={`proposal:${proposalId}:here`}
        />
        <View style={styles.tail}>
          <WorktreeSwitch
            deviceId={deviceId}
            value={worktree}
            disabled={off}
            onChange={setWorktree}
            testID={`proposal:${proposalId}:worktree`}
            compact
          />
        </View>
      </View>
      {act.failure ? (
        <Text style={[styles.failure, { color: c.err, fontSize: font.size.meta }]}>
          {act.failure}
        </Text>
      ) : null}
    </>
  )
}
