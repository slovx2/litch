// 飞书的一个群：未接入的是接入页，已接入的是群设置页（同一页）。发言模式（不预选，外部群预选审批并要再勾确认）、
// 叫醒名单（成员选择单加“包括已绑定用户”）、保留天数、审批过期时间（只在审批发言时出）；已接入的只提交改了的字段，
// 底部“取消接入”另有确认框（默认同时删除记录）。机器人不在群里或群已解散时成员选择不可用，其余照样能改。
// 这条连接不是设备管理员时写操作都不可点，页首写明原因。“记录”一节有条数、补历史与补缺口，已接入的群能手动补更早的消息。写操作带群的 revision，冲突时重读这一个群并提示重试。
import { type DeviceView, keys } from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native'
import { feishuFailure } from '../../../../../../packages/ui/src/feishu/failure.ts'
import {
  accessParams,
  boundedInt,
  type ChatDraft,
  chatChanges,
  chatDraft,
  chatUnavailable,
  draftProblems,
  FEISHU_BACKFILL_LIMIT,
  FEISHU_RETENTION_DAYS,
  FEISHU_REVIEW_TTL_HOURS,
  FEISHU_WAKERS_MAX,
  type FeishuChat,
  type FeishuMember,
  feishuReason,
  staleReason,
  writeBlock,
} from '../../../../../../packages/ui/src/feishu/model.ts'
import type { RootStackParamList } from '../../../nav/routes'
import { useChannel, useKey } from '../../../shell/services'
import { useT } from '../../../ui/i18n'
import { Button, Empty, Field, Row, SectionLabel, ValueRow } from '../../../ui/kit/controls'
import { KeyboardFormScrollView } from '../../../ui/kit/KeyboardForm'
import { ChoiceMark } from '../../../ui/kit/marks'
import { Dialog, Sheet } from '../../../ui/kit/overlays'
import { Screen } from '../../../ui/kit/Screen'
import { useTheme } from '../../../ui/theme'
import { FeishuBackfillForm, FeishuRecordsSummary } from './FeishuChatRecords'
import { chatMarks } from './FeishuChats'
import { FeishuMemberSheet } from './FeishuMemberSheet'
import { useFeishuChats, useFeishuDevice } from './use-feishu'

type Props = NativeStackScreenProps<RootStackParamList, 'FeishuChat'>

export function FeishuChatScreen({ route, navigation }: Props) {
  const { deviceId, appId, chatId } = route.params
  const t = useT()
  const theme = useTheme()
  const { c, font } = theme
  const channel = useChannel()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const online = device?.connection === 'online'
  const supported = device?.feishu === true
  const deviceView = useFeishuDevice(deviceId, supported)
  const view = useFeishuChats(deviceId, appId, supported)
  const listed = view?.value?.chats.find((one) => one.chatId === chatId) ?? null
  /** 命令结果或冲突后重读到的这个群：比快照新才用 */
  const [fresh, setFresh] = useState<FeishuChat | null>(null)
  const chat = listed && fresh && fresh.revision > listed.revision ? fresh : listed
  const [draft, setDraft] = useState<ChatDraft | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [members, setMembers] = useState<FeishuMember[] | null>(null)
  const [membersBusy, setMembersBusy] = useState(false)
  const [membersError, setMembersError] = useState('')
  const [picking, setPicking] = useState<'speech' | 'members' | null>(null)
  const [unaccessing, setUnaccessing] = useState(false)
  const [deleteRecords, setDeleteRecords] = useState(true)

  const refetch = useCallback(() => {
    channel.command('feishu.chat.get', { deviceId, appId, chatId }).then(
      (result) => setFresh(result.chat),
      () => {},
    )
  }, [channel, deviceId, appId, chatId])
  const loadMembers = useCallback(
    async (refresh: boolean) => {
      setMembersBusy(true)
      setMembersError('')
      try {
        const result = await channel.command('feishu.chat.members', {
          deviceId,
          appId,
          chatId,
          ...(refresh ? { refresh: true } : {}),
        })
        setMembers(result.members)
      } catch (failed) {
        setMembersError(feishuFailure(failed, t))
      } finally {
        setMembersBusy(false)
      }
    },
    [channel, deviceId, appId, chatId, t],
  )
  // 群读到、且能用时读一次成员
  const unavailable = chat ? chatUnavailable(chat) : null
  const loaded = useRef(false)
  useEffect(() => {
    if (loaded.current || !chat || unavailable || !online) return
    loaded.current = true
    void loadMembers(false)
  }, [chat, unavailable, online, loadMembers])

  /** 跑一个命令：忙记号、失败原因，版本冲突（或接入状态已变）先重读 */
  const run = async <R,>(what: string, request: () => Promise<R>): Promise<R | undefined> => {
    setBusy(what)
    setError('')
    try {
      return await request()
    } catch (failed) {
      if (staleReason(feishuReason(failed))) refetch()
      setError(feishuFailure(failed, t))
      return undefined
    } finally {
      setBusy(null)
    }
  }

  const title = chat?.name || route.params.title || chatId
  if (!chat) {
    return (
      <Screen title={title} testID="feishu-chat">
        <Empty
          busy={view?.value == null && online}
          title={t(
            view?.value == null
              ? online
                ? 'feishu.loading'
                : 'feishu.offline'
              : 'feishu.error.chat_not_found',
          )}
        />
      </Screen>
    )
  }

  const shown = draft ?? chatDraft(chat)
  const set = (patch: Partial<ChatDraft>) => setDraft({ ...shown, ...patch })
  const access = chat.access
  const block = writeBlock(online, deviceView?.admin)
  const locked = block !== null
  const problems = draftProblems(shown, chat)
  const changes = access ? chatChanges(shown, access) : null
  // 机器人不在群里或群已解散：不能新接入（留着记录的群也能打开看）
  const closed = !access && unavailable !== null
  const ready =
    !locked &&
    !closed &&
    busy === null &&
    problems.length === 0 &&
    (changes === null || Object.keys(changes).length > 0)

  const submit = async () => {
    if (!ready) return
    let result: { chat: FeishuChat } | undefined
    if (access && changes) {
      result = await run('save', () =>
        channel.command('feishu.chat.update', {
          deviceId,
          appId,
          chatId,
          expectedRevision: chat.revision,
          ...changes,
        }),
      )
    } else {
      const params = accessParams(shown, chat)
      if (!params) return
      result = await run('save', () =>
        channel.command('feishu.chat.access', { deviceId, ...params }),
      )
    }
    if (!result) return
    setFresh(result.chat)
    navigation.goBack()
  }
  const unaccess = async () => {
    setUnaccessing(false)
    const result = await run('unaccess', () =>
      channel.command('feishu.chat.unaccess', {
        deviceId,
        appId,
        chatId,
        expectedRevision: chat.revision,
        deleteRecords,
      }),
    )
    if (result) navigation.goBack()
  }

  const note = [styles.note, { color: c.ink3, fontSize: font.size.meta }]
  const why = closed
    ? t('feishu.chat.unavailableAccess')
    : problems.includes('speech')
      ? t('feishu.chat.problem.speech')
      : problems.includes('external')
        ? t('feishu.chat.problem.external')
        : problems.includes('wakers')
          ? t('feishu.chat.problem.wakers', { max: FEISHU_WAKERS_MAX })
          : ''
  const retentionBad = boundedInt(shown.retentionDays, FEISHU_RETENTION_DAYS) === null
  const ttlBad = boundedInt(shown.reviewTtlHours, FEISHU_REVIEW_TTL_HOURS) === null
  const marks = chatMarks(chat, t)
  return (
    <Screen
      title={title}
      subtitle={t(access ? 'feishu.chat.settingsTitle' : 'feishu.chat.accessTitle', {
        name: title,
      })}
      wire={device ? c.wire[device.wire] : undefined}
      testID="feishu-chat"
    >
      <KeyboardFormScrollView>
        {block === 'readOnly' ? (
          <Text style={note} testID="feishu:read-only">
            {t('feishu.readOnly')}
          </Text>
        ) : null}
        {block === 'offline' ? <Text style={note}>{t('feishu.offlineCached')}</Text> : null}
        {marks.length ? <Text style={note}>{marks.join(' · ')}</Text> : null}

        <SectionLabel>{t('feishu.chat.speech')}</SectionLabel>
        <ValueRow
          title={t('feishu.chat.speech')}
          value={shown.speech ? t(`feishu.chat.speech.${shown.speech}`) : t('mfs.unset')}
          testID="feishu:speech"
          onPress={() => (locked ? undefined : setPicking('speech'))}
        />
        {shown.speech ? (
          <Text style={note}>{t(`feishu.chat.speech.${shown.speech}Note`)}</Text>
        ) : null}
        {shown.speech === 'approval' ? (
          <Field
            label={t('feishu.chat.ttl')}
            value={shown.reviewTtlHours}
            onChangeText={(reviewTtlHours) => set({ reviewTtlHours })}
            keyboardType="number-pad"
            editable={!locked}
            testID="feishu:ttl"
            hint={t('feishu.chat.ttlNote')}
            {...(ttlBad
              ? {
                  error: t('feishu.chat.range', {
                    min: FEISHU_REVIEW_TTL_HOURS.min,
                    max: FEISHU_REVIEW_TTL_HOURS.max,
                  }),
                }
              : {})}
          />
        ) : null}
        {!access && chat.external ? (
          <Row
            testID="feishu:confirm-external"
            left={<ChoiceMark kind="check" state={shown.confirmExternal ? 'on' : 'off'} />}
            title={t('feishu.chat.confirmExternal')}
            trail="none"
            {...(locked ? {} : { onPress: () => set({ confirmExternal: !shown.confirmExternal }) })}
          />
        ) : null}

        <SectionLabel>{t('feishu.chat.wakers')}</SectionLabel>
        <Text style={note}>{t('feishu.chat.wakersNote')}</Text>
        <Row
          title={t('feishu.chat.wakeBound')}
          right={
            <Switch
              accessibilityLabel={t('feishu.chat.wakeBound')}
              testID="feishu:wake-bound"
              value={shown.wakeBound}
              disabled={locked}
              onValueChange={(wakeBound) => set({ wakeBound })}
              trackColor={{ true: c.accent, false: c.line2 }}
            />
          }
        />
        {unavailable ? (
          <>
            <Text style={[styles.note, { color: c.err }]}>
              {t(`feishu.chat.unavailable.${unavailable}`)}
            </Text>
            <Text style={note}>
              {shown.wakers.length
                ? shown.wakers.map((one) => one.name || one.openId).join('、')
                : t('feishu.chat.members.empty')}
            </Text>
          </>
        ) : (
          <ValueRow
            title={t('mfs.members')}
            value={t('feishu.chat.members.count', {
              count: shown.wakers.length,
              max: FEISHU_WAKERS_MAX,
            })}
            testID="feishu:members:open"
            onPress={() => (locked ? undefined : setPicking('members'))}
          />
        )}

        <SectionLabel>{t('feishu.records.title')}</SectionLabel>
        <FeishuRecordsSummary chat={chat} />
        <Field
          label={t('feishu.chat.retention')}
          value={shown.retentionDays}
          onChangeText={(retentionDays) => set({ retentionDays })}
          keyboardType="number-pad"
          editable={!locked}
          testID="feishu:retention"
          hint={t('feishu.chat.retentionNote')}
          {...(retentionBad
            ? {
                error: t('feishu.chat.range', {
                  min: FEISHU_RETENTION_DAYS.min,
                  max: FEISHU_RETENTION_DAYS.max,
                }),
              }
            : {})}
        />

        <FeishuBackfillForm deviceId={deviceId} chat={chat} block={block} onChat={setFresh} />
        {access ? null : (
          <Text style={note}>{t('feishu.chat.backfillNote', { max: FEISHU_BACKFILL_LIMIT })}</Text>
        )}

        {error ? (
          <Text testID="feishu:chat:error" style={[styles.note, { color: c.err }]}>
            {error}
          </Text>
        ) : null}
        {!locked && why ? (
          <Text style={note} testID="feishu:why">
            {why}
          </Text>
        ) : null}
        <View style={styles.buttons}>
          <Button
            label={t(access ? 'feishu.chat.save' : 'feishu.chat.access')}
            testID={access ? 'feishu:chat:save' : 'feishu:chat:access'}
            busy={busy === 'save'}
            disabled={!ready}
            onPress={() => void submit()}
          />
          {access ? (
            <Button
              kind="danger"
              label={t('feishu.chat.unaccess')}
              testID="feishu:chat:unaccess"
              busy={busy === 'unaccess'}
              disabled={locked || busy !== null}
              onPress={() => {
                setDeleteRecords(true)
                setUnaccessing(true)
              }}
            />
          ) : null}
        </View>
      </KeyboardFormScrollView>
      <Sheet
        visible={picking === 'speech'}
        title={t('feishu.chat.speech')}
        onClose={() => setPicking(null)}
        actions={(['free', 'approval'] as const).map((mode) => ({
          label: t(`feishu.chat.speech.${mode}`),
          selected: shown.speech === mode,
          testID: `feishu:speech:${mode}`,
          onPress: () => set({ speech: mode }),
        }))}
      />
      <FeishuMemberSheet
        visible={picking === 'members'}
        members={members}
        busy={membersBusy}
        error={membersError}
        wakers={shown.wakers}
        onChange={(wakers) => set({ wakers })}
        onRefresh={() => void loadMembers(true)}
        onClose={() => setPicking(null)}
      />
      <Dialog visible={unaccessing} onClose={() => setUnaccessing(false)}>
        <Text style={[styles.dialogTitle, { color: c.ink, fontFamily: font.ui }]}>
          {t('feishu.chat.unaccess.title', { name: title })}
        </Text>
        <Text style={[styles.dialogDetail, { color: c.ink2 }]}>
          {t('feishu.chat.unaccess.note')}
        </Text>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: deleteRecords }}
          testID="feishu:delete-records"
          onPress={() => setDeleteRecords(!deleteRecords)}
          style={[styles.check, { minHeight: theme.hit }]}
        >
          <ChoiceMark kind="check" state={deleteRecords ? 'on' : 'off'} />
          <Text style={[styles.dialogDetail, { color: c.ink }]}>
            {t('feishu.chat.unaccess.delete')}
          </Text>
        </Pressable>
        {deleteRecords ? (
          <Text style={[styles.dialogDetail, { color: c.err }]}>
            {t('feishu.chat.unaccess.deleteNote')}
          </Text>
        ) : null}
        <View style={styles.dialogButtons}>
          <Button kind="plain" label={t('feishu.cancel')} onPress={() => setUnaccessing(false)} />
          <Button
            kind="danger"
            label={t('feishu.chat.unaccess')}
            testID="feishu:unaccess:ok"
            onPress={() => void unaccess()}
          />
        </View>
      </Dialog>
    </Screen>
  )
}

const styles = StyleSheet.create({
  note: { lineHeight: 18, paddingHorizontal: 16, paddingVertical: 4 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 16 },
  check: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dialogTitle: { fontSize: 17, fontWeight: '600' },
  dialogDetail: { fontSize: 14, lineHeight: 20, flexShrink: 1 },
  dialogButtons: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 10 },
})
