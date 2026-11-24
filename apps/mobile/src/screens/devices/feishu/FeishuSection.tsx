// 设备详情的“飞书”一节：每个应用一行（头像、机器人名、分配的经理、连接状态，有待确认的配对时右上角写条数），点进应用详情；
// 小标题右边的 + 进添加应用（这条连接不是设备管理员时不可点，写明原因）。设备服务不支持（没有 litchFeishu）不出这一节。
import type { DeviceView } from '@litch/core'
import { Image, StyleSheet, Text, View } from 'react-native'
import {
  connectionReason,
  type FeishuApp,
  shownState,
  writeBlock,
} from '../../../../../../packages/ui/src/feishu/model.ts'
import { type Translator, useT } from '../../../ui/i18n'
import { Row, SectionLabel } from '../../../ui/kit/controls'
import { IconButton } from '../../../ui/kit/Icon'
import { type Theme, useTheme } from '../../../ui/theme'
import { useDeviceManagers, useFeishuDevice } from './use-feishu'

/** 连接状态一句话：失败、重连带原因 */
export function stateText(app: FeishuApp, t: Translator): string {
  const reason = connectionReason(app)
  return t(`feishu.state.${shownState(app)}`) + (reason ? ` · ${t(`feishu.conn.${reason}`)}` : '')
}

export function stateColor(app: FeishuApp, c: Theme['c']): string {
  const state = shownState(app)
  return state === 'connected'
    ? c.ok
    : state === 'failed'
      ? c.err
      : state === 'stopped'
        ? c.ink3
        : c.wait
}

/** 机器人头像：有地址画图，没有画名字首字 */
export function BotAvatar({ app, size = 28 }: { app: FeishuApp; size?: number }) {
  const { c, font } = useTheme()
  const box = { width: size, height: size, borderRadius: size / 2 }
  if (app.avatar)
    return <Image source={{ uri: app.avatar }} style={box} accessibilityIgnoresInvertColors />
  return (
    <View style={[box, styles.letter, { backgroundColor: c.sunken }]}>
      <Text style={{ color: c.ink2, fontSize: font.size.meta, fontWeight: '600' }}>
        {[...(app.name || app.appId)][0]?.toUpperCase()}
      </Text>
    </View>
  )
}

export function FeishuSection({
  device,
  onAdd,
  onOpen,
}: {
  device: DeviceView
  onAdd(): void
  onOpen(app: FeishuApp): void
}) {
  const t = useT()
  const { c } = useTheme()
  const supported = device.feishu === true
  const view = useFeishuDevice(device.id, supported)
  const managers = useDeviceManagers(device.id)
  if (!supported) return null
  const online = device.connection === 'online'
  const block = writeBlock(online, view?.admin)
  const apps = view?.apps.value ?? null
  const error = view?.apps.error ?? null
  const managerName = (id: string | null) =>
    id ? (managers.find((one) => one.id === id)?.name ?? id) : t('feishu.unassigned')
  return (
    <View testID="detail:feishu">
      <SectionLabel
        right={
          <IconButton
            icon="plus"
            label={t('feishu.add')}
            disabled={block !== null}
            testID="feishu:add"
            onPress={onAdd}
          />
        }
      >
        {t('feishu.title')}
      </SectionLabel>
      {block === 'readOnly' ? (
        <Text style={[styles.note, { color: c.ink3 }]}>{t('feishu.readOnly')}</Text>
      ) : null}
      {error ? (
        <Text style={[styles.note, { color: c.err }]}>
          {error.text ? t.text(error.text) : error.message}
        </Text>
      ) : null}
      {apps === null && !error ? (
        <Text style={[styles.note, { color: c.ink3 }]}>
          {t(online ? 'feishu.loading' : 'feishu.offline')}
        </Text>
      ) : null}
      {apps?.length === 0 ? (
        <Text style={[styles.note, { color: c.ink3 }]}>{t('feishu.none')}</Text>
      ) : null}
      {(apps ?? []).map((app) => (
        <Row
          key={app.appId}
          testID={`feishu:app:${app.appId}`}
          left={<BotAvatar app={app} />}
          title={app.name || app.appId}
          detail={`${managerName(app.managerId)} · ${stateText(app, t)}`}
          {...(app.pendingPairings
            ? { meta: t('feishu.binding.pending', { n: app.pendingPairings }) }
            : {})}
          right={<View style={[styles.dot, { backgroundColor: stateColor(app, c) }]} />}
          trail="forward"
          onPress={() => onOpen(app)}
        />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  note: { fontSize: 14, lineHeight: 20, paddingHorizontal: 16, paddingVertical: 6 },
  letter: { alignItems: 'center', justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4 },
})
