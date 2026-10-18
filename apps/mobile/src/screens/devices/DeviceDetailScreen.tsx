// 设备详情：连接（状态、没连上的原因和该怎么办、重新连接、重新信任主机钥匙）、这台设备（改名、线色、主机、
// 钥匙和公钥、主机指纹、对面是什么）、定时任务（几个，点进这台设备的任务列表）、各 harness 的启停与设置（对面有设置接口时，manage 主题，ManageSection）、移除。
import { type DeviceView, keys } from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import type { RootStackParamList } from '../../nav/routes'
import { keyInfo } from '../../platform/keys'
import { knownHost } from '../../platform/known-hosts'
import { useChannel, useKey } from '../../shell/services'
import { type Translator, useT } from '../../ui/i18n'
import { Button, Empty, Row, SectionLabel } from '../../ui/kit/controls'
import { Confirm, Prompt } from '../../ui/kit/overlays'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'
import { shownState } from './failure'
import { forgetUnusedKey } from './forget'
import { HarnessList, ManageSection } from './ManageSection'
import { FailureCard, InfoLine, PublicKeyCard, useHostTrust, WirePicker } from './parts'

type Props = NativeStackScreenProps<RootStackParamList, 'DeviceDetail'>

function peerText(device: DeviceView, t: Translator): string {
  if (device.harnesses.length === 0) return t('devices.detail.peer.unknown')
  const service = device.service ? ` ${device.service.version}` : ''
  return device.mode === 'full'
    ? t('devices.peer.service', { count: device.harnesses.length }) + service
    : t('devices.peer.only', { name: device.harnesses[0]?.name ?? '' })
}

/** 这台设备上的定时任务：几个、几次没看；服务不支持时说一句 */
function TasksLine({ deviceId, onPress }: { deviceId: string; onPress(): void }) {
  const available = useKey<boolean | null>(keys.tasksAvailable(deviceId))
  const ids = useKey<string[]>(keys.taskIds(deviceId)) ?? []
  const t = useT()
  return (
    <Row
      testID="detail:tasks"
      title={t('timed.entry.count', { count: ids.length })}
      detail={available === false ? t('tasks.unsupported') : t('timed.entry.none')}
      onPress={onPress}
    />
  )
}

export function DeviceDetailScreen({ route, navigation }: Props) {
  const { deviceId } = route.params
  const device = useKey<DeviceView>(keys.device(deviceId))
  const channel = useChannel()
  const theme = useTheme()
  const t = useT()
  const trust = useHostTrust()
  const [renaming, setRenaming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 重新信任之后要重画一次：记下的主机指纹不在订阅里 */
  const [, setTrusted] = useState(0)
  if (!device) {
    return (
      <Screen title={t('devices.menu.detail')} testID="device-detail">
        <Empty title={t('devices.detail.peer.unknown')} />
      </Screen>
    )
  }
  const target = device.target?.kind === 'host' ? device.target : null
  const port = target?.port ?? 22
  const key = keyInfo(target?.keyFile ?? null)
  const hostKey = target ? knownHost(target.host, port) : null
  const state = shownState(device)
  const run = (work: Promise<unknown>) => {
    setError(null)
    work.catch((failed) =>
      setError(t('devices.failed', { reason: String(failed?.message ?? failed) })),
    )
  }
  const reconnect = () => run(channel.command('device.reconnect', { deviceId }))
  const retrust = async () => {
    if (!target) return
    if (await trust.confirm(target.host, port, target.user ?? '')) {
      setTrusted((n) => n + 1)
      reconnect()
    }
  }
  return (
    <Screen
      title={t.text(device.name)}
      subtitle={device.host}
      wire={theme.c.wire[device.wire]}
      testID="device-detail"
    >
      <ScrollView keyboardShouldPersistTaps="handled">
        <SectionLabel>{t('devices.detail.connection')}</SectionLabel>
        <InfoLine
          label={t(`devices.state.${state}`)}
          value={
            device.note && !device.failure && state !== 'online' ? t.text(device.note) : device.host
          }
          testID="detail:state"
        />
        {device.failure ? (
          <FailureCard failure={device.failure} target={device.target} publicKey={key?.publicKey} />
        ) : null}
        <View style={styles.buttons}>
          <Button
            kind="plain"
            label={t('devices.reconnect')}
            testID="detail:reconnect"
            onPress={reconnect}
          />
          {target ? (
            <Button
              kind={device.failure?.stage === 'hostKey' ? 'solid' : 'plain'}
              label={t('devices.retrust')}
              testID="detail:retrust"
              onPress={() => void retrust()}
            />
          ) : null}
        </View>
        {trust.notice ? (
          <Text style={[styles.note, { color: theme.c.ink2 }]}>{trust.notice}</Text>
        ) : null}
        {trust.error || error ? (
          <Text style={[styles.note, { color: theme.c.err }]} testID="detail:error">
            {trust.error ?? error}
          </Text>
        ) : null}

        <SectionLabel>{t('manage.device')}</SectionLabel>
        <Row
          title={t.text(device.name)}
          detail={t('devices.rename')}
          testID="detail:rename"
          onPress={device.kind === 'ssh' ? () => setRenaming(true) : undefined}
        />
        <InfoLine label={t('devices.wire')} value={t(`devices.color.${device.wire}`)} />
        <WirePicker
          value={device.wire}
          onPick={(wire) => run(channel.command('device.update', { deviceId, wire }))}
        />
        <InfoLine label={t('devices.host')} value={device.host} />
        {target ? <InfoLine label={t('devices.detail.user')} value={target.user ?? ''} /> : null}
        <InfoLine
          label={t('devices.detail.hostKey')}
          value={
            hostKey
              ? `${hostKey.fingerprint} (${hostKey.keyType})`
              : t('devices.detail.hostKey.none')
          }
          testID="detail:hostKey"
        />
        <InfoLine label={t('devices.peer')} value={peerText(device, t)} />
        {key ? (
          <View style={styles.pad}>
            <InfoLine label={t('devices.detail.key')} value={key.fingerprint} />
            <View style={styles.side}>
              <PublicKeyCard publicKey={key.publicKey} />
            </View>
          </View>
        ) : null}

        <SectionLabel>{t('tasks.title')}</SectionLabel>
        <TasksLine deviceId={deviceId} onPress={() => navigation.navigate('Tasks', { deviceId })} />

        <SectionLabel>{t('manage.harness.title')}</SectionLabel>
        {device.manageable && state === 'online' ? (
          <ManageSection device={device} />
        ) : (
          <>
            <Text style={[styles.note, { color: theme.c.ink3 }]}>
              {t(state === 'online' ? 'devices.detail.noManage' : 'manage.offline')}
            </Text>
            <HarnessList device={device} />
          </>
        )}

        {device.kind === 'ssh' ? (
          <View style={styles.remove}>
            <Button
              kind="danger"
              label={t('devices.remove')}
              testID="detail:remove"
              onPress={() => setRemoving(true)}
            />
          </View>
        ) : null}
      </ScrollView>
      {trust.dialog}
      <Prompt
        visible={renaming}
        title={t('devices.rename')}
        initial={t.text(device.name)}
        placeholder={t('devices.nameLabel')}
        submitLabel={t('devices.save')}
        onSubmit={(name) => run(channel.command('device.update', { deviceId, name }))}
        onClose={() => setRenaming(false)}
      />
      <Confirm
        visible={removing}
        danger
        title={t('devices.remove.title')}
        detail={t('devices.remove.note')}
        confirmLabel={t('devices.remove')}
        onConfirm={() => {
          const was = device.target
          navigation.popToTop()
          void channel.command('device.remove', { deviceId }).then(() => forgetUnusedKey(was))
        }}
        onClose={() => setRemoving(false)}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  buttons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  note: { fontSize: 14, lineHeight: 20, paddingHorizontal: 16, paddingVertical: 8 },
  pad: { paddingBottom: 12, gap: 8 },
  side: { paddingHorizontal: 16 },
  remove: { padding: 16, paddingBottom: 40 },
})
