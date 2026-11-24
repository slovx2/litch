// 一台设备上一个飞书应用的详情：连接状态、启用、分配经理、能力自检（检查、补申请、待审核）、群、私聊绑定、发件、App Secret 更新时间、移除。
// 与桌面一致，只少“更换 App Secret”（秘密只在桌面输入，litch config 也不收）。写操作带 expectedRevision，冲突时重读并提示重试；
// 这条连接不是设备管理员时写操作都不可点，页首写明原因。
import { type DeviceView, keys } from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useCallback, useState } from 'react'
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import { stamp } from '../../../../../../packages/ui/src/app/format.ts'
import { operationId } from '../../../../../../packages/ui/src/external/model.ts'
import { feishuFailure } from '../../../../../../packages/ui/src/feishu/failure.ts'
import {
  canUpgrade,
  type FeishuApp,
  feishuReason,
  managerOptions,
  missingGroups,
  pendingReview,
  writeBlock,
} from '../../../../../../packages/ui/src/feishu/model.ts'
import type { RootStackParamList } from '../../../nav/routes'
import { useChannel, useKey } from '../../../shell/services'
import { useT } from '../../../ui/i18n'
import { Button, Empty, Row, SectionLabel, ValueRow } from '../../../ui/kit/controls'
import { IconButton } from '../../../ui/kit/Icon'
import { Confirm, Sheet } from '../../../ui/kit/overlays'
import { Screen } from '../../../ui/kit/Screen'
import { useTheme } from '../../../ui/theme'
import { InfoLine } from '../parts'
import { FeishuBindings } from './FeishuBindings'
import { FeishuChats } from './FeishuChats'
import { FeishuOutbox } from './FeishuOutbox'
import { BotAvatar, stateColor, stateText } from './FeishuSection'
import { useDeviceManagers, useFeishuDevice } from './use-feishu'

type Props = NativeStackScreenProps<RootStackParamList, 'FeishuApp'>

export function FeishuAppScreen({ route, navigation }: Props) {
  const { deviceId, appId } = route.params
  const t = useT()
  const theme = useTheme()
  const { c, font } = theme
  const channel = useChannel()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const online = device?.connection === 'online'
  const view = useFeishuDevice(deviceId, device?.feishu === true)
  const managers = useDeviceManagers(deviceId)
  const apps = view?.apps.value ?? null
  const listed = apps?.find((one) => one.appId === appId) ?? null
  /** 命令结果或冲突后重读到的这一个应用：比快照新才用 */
  const [fresh, setFresh] = useState<FeishuApp | null>(null)
  const app = listed && fresh && fresh.revision > listed.revision ? fresh : listed
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [picking, setPicking] = useState(false)
  const [removing, setRemoving] = useState(false)

  const refetch = useCallback(() => {
    channel.command('feishu.app.get', { deviceId, appId }).then(
      (result) => setFresh(result.app),
      () => {},
    )
  }, [channel, deviceId, appId])
  /** 跑一个命令：忙记号、失败原因，版本冲突先重读 */
  const run = async <R,>(what: string, request: () => Promise<R>): Promise<R | undefined> => {
    setBusy(what)
    setError('')
    try {
      return await request()
    } catch (failed) {
      if (feishuReason(failed) === 'revision_conflict') refetch()
      setError(feishuFailure(failed, t))
      return undefined
    } finally {
      setBusy(null)
    }
  }
  const update = async (patch: { managerId?: string | null; enabled?: boolean }) => {
    if (!app) return
    const result = await run('update', () =>
      channel.command('feishu.app.update', {
        deviceId,
        appId,
        expectedRevision: app.revision,
        ...patch,
      }),
    )
    if (result) setFresh(result.app)
  }
  const check = async () => {
    const result = await run('check', () =>
      channel.command('feishu.app.check', { deviceId, appId }),
    )
    if (result) setFresh(result.app)
  }
  const upgrade = async () => {
    const result = await run('upgrade', () =>
      channel.command('feishu.app.upgrade', { deviceId, appId, operationId: operationId() }),
    )
    if (result) setFresh(result.app)
  }
  const remove = async () => {
    if (!app) return
    const result = await run('remove', () =>
      channel.command('feishu.app.remove', { deviceId, appId, expectedRevision: app.revision }),
    )
    if (result) navigation.goBack()
  }

  const title = app?.name || route.params.title || appId
  if (!app) {
    return (
      <Screen title={title} testID="feishu-app">
        <Empty
          busy={apps === null && online}
          title={t(
            apps === null
              ? online
                ? 'feishu.loading'
                : 'feishu.offline'
              : 'feishu.error.app_not_found',
          )}
        />
      </Screen>
    )
  }
  const options = managerOptions(apps ?? [], managers, appId)
  const managerName = app.managerId
    ? (options.find((one) => one.id === app.managerId)?.name ?? app.managerId)
    : t('feishu.unassigned')
  const capability = app.capability
  const block = writeBlock(online, view?.admin)
  const writable = block === null && busy === null
  const note = [styles.note, { color: c.ink3, fontSize: font.size.meta }]
  return (
    <Screen
      title={title}
      subtitle={device ? `${t('feishu.title')} · ${t.text(device.name)}` : undefined}
      wire={device ? c.wire[device.wire] : undefined}
      testID="feishu-app"
    >
      <ScrollView>
        {error ? (
          <Text testID="feishu:error" style={[styles.note, { color: c.err }]}>
            {error}
          </Text>
        ) : null}
        {!online ? <Text style={note}>{t('feishu.offlineCached')}</Text> : null}
        {block === 'readOnly' ? (
          <Text style={note} testID="feishu:read-only">
            {t('feishu.readOnly')}
          </Text>
        ) : null}
        <SectionLabel>{t('feishu.app.overview')}</SectionLabel>
        <Row
          left={<BotAvatar app={app} />}
          title={t('feishu.app.state')}
          detail={stateText(app, t)}
          right={<View style={[styles.dot, { backgroundColor: stateColor(app, c) }]} />}
          trail="none"
        />
        <InfoLine label={t('feishu.appId')} value={app.appId} />
        <Row
          title={t('feishu.app.enabled')}
          detail={t('feishu.app.disableNote')}
          right={
            <Switch
              accessibilityLabel={t('feishu.app.enabled')}
              testID="feishu:enabled"
              value={app.enabled}
              disabled={!writable}
              onValueChange={(enabled) => void update({ enabled })}
              trackColor={{ true: c.accent, false: c.line2 }}
            />
          }
        />
        <ValueRow
          title={t('feishu.app.manager')}
          value={managerName}
          testID="feishu:manager"
          onPress={() => (writable ? setPicking(true) : undefined)}
        />
        {options.length === 0 ? <Text style={note}>{t('feishu.app.noManagers')}</Text> : null}

        <SectionLabel
          right={
            <IconButton
              icon="reload"
              label={t('feishu.cap.check')}
              busy={busy === 'check'}
              disabled={!writable}
              testID="feishu:check"
              onPress={() => void check()}
            />
          }
        >
          {t('feishu.cap.title')}
        </SectionLabel>
        <InfoLine
          label={capability ? t(`feishu.cap.state.${capability.state}`) : t('feishu.cap.never')}
          value={
            capability
              ? t('feishu.cap.checkedAt', {
                  time: stamp(capability.checkedAt * 1000, Date.now(), t.lang),
                })
              : ''
          }
          testID="feishu:capability"
        />
        {pendingReview(capability) ? (
          <Text testID="feishu:pending" style={[styles.note, { color: c.wait }]}>
            {t('feishu.cap.pending')}
          </Text>
        ) : null}
        {capability
          ? missingGroups(capability).map((group) => (
              <InfoLine
                key={group.kind}
                label={t(`feishu.cap.${group.kind}`)}
                value={group.items.join('\n')}
              />
            ))
          : null}
        {canUpgrade(capability) ? (
          <View style={styles.block}>
            <Text style={note}>{t('feishu.cap.upgradeNote')}</Text>
            <View style={styles.buttons}>
              <Button
                kind="plain"
                label={t('feishu.cap.upgrade')}
                testID="feishu:upgrade"
                busy={busy === 'upgrade'}
                disabled={!writable}
                onPress={() => void upgrade()}
              />
            </View>
          </View>
        ) : null}

        <FeishuChats
          deviceId={deviceId}
          appId={appId}
          online={online}
          onOpen={(chat) =>
            navigation.navigate('FeishuChat', {
              deviceId,
              appId,
              chatId: chat.chatId,
              title: chat.name || chat.chatId,
            })
          }
        />

        <FeishuBindings deviceId={deviceId} app={app} block={block} />

        <FeishuOutbox deviceId={deviceId} appId={appId} block={block} />

        <SectionLabel>{t('feishu.secret.title')}</SectionLabel>
        <InfoLine
          label={t('feishu.secret.updated', {
            time: stamp(app.credential.updatedAt * 1000, Date.now(), t.lang),
          })}
          value={t('mfs.secretDesktop')}
        />
        <View style={styles.buttons}>
          <Button
            kind="danger"
            label={t('feishu.remove')}
            testID="feishu:remove"
            busy={busy === 'remove'}
            disabled={!writable}
            onPress={() => setRemoving(true)}
          />
        </View>
      </ScrollView>
      <Sheet
        visible={picking}
        title={t('feishu.app.manager')}
        note={t('feishu.app.managerNote')}
        onClose={() => setPicking(false)}
        actions={[
          {
            label: t('feishu.unassigned'),
            selected: app.managerId === null,
            testID: 'feishu:manager:none',
            onPress: () => void update({ managerId: null }),
          },
          ...options.map((one) => ({
            label: one.name,
            selected: app.managerId === one.id,
            testID: `feishu:manager:${one.id}`,
            ...(one.takenBy
              ? { disabled: t('feishu.app.managerTaken', { name: one.name, app: one.takenBy }) }
              : {}),
            onPress: () => void update({ managerId: one.id }),
          })),
        ]}
      />
      <Confirm
        visible={removing}
        title={t('feishu.remove.title', { name: app.name || app.appId })}
        detail={t('feishu.remove.note')}
        confirmLabel={t('feishu.remove')}
        danger
        onConfirm={() => void remove()}
        onClose={() => setRemoving(false)}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  note: { lineHeight: 18, paddingHorizontal: 16, paddingVertical: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  block: { paddingTop: 4 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 16 },
})
