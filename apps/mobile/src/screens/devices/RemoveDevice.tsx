// 移除设备的确认框（设备列表的菜单和设备详情共用）。多一个勾选“同时在这台机器上撤掉这部手机的钥匙”，默认勾上：
// 连着时按自己钥匙的指纹在那台机器的已绑定手机里找到自己、撤掉那一行（核心的 pairing.phones、pairing.revoke）；
// 没连上、没撤成就先说一声，点“知道了”再从手机上移除。真正的移除（device.remove、删用不着的钥匙）由调用方做。
import type { DeviceView } from '@litch/core'
import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { keyInfo } from '../../platform/keys'
import { revokeOwnKey } from '../../platform/pairing'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { Dialog } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'
import { shownState } from './failure'

export function RemoveDevice({
  device,
  onClose,
  onRemove,
}: {
  /** 要移除的设备；null 是不显示 */
  device: DeviceView | null
  onClose(): void
  /** 确认了（撤钥匙那一步做完、提示也看过了）：调用方去移除 */
  onRemove(device: DeviceView): void
}) {
  const t = useT()
  const theme = useTheme()
  const channel = useChannel()
  const [revoke, setRevoke] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // 每次打开都回到默认：勾上
  useEffect(() => {
    if (device) {
      setRevoke(true)
      setBusy(false)
      setNotice(null)
    }
  }, [device])
  if (!device) return null
  const target = device.target?.kind === 'host' ? device.target : null
  const canRevoke = device.kind === 'ssh' && target !== null

  const finish = () => {
    onClose()
    onRemove(device)
  }
  const confirm = async () => {
    if (!canRevoke || !revoke) {
      finish()
      return
    }
    setBusy(true)
    const outcome = await revokeOwnKey({
      online: shownState(device) === 'online',
      fingerprint: keyInfo(target?.keyFile ?? null)?.fingerprint ?? null,
      phones: async () => (await channel.command('pairing.phones', { deviceId: device.id })).phones,
      revoke: async (phoneId) => {
        await channel.command('pairing.revoke', { deviceId: device.id, phoneId })
      },
    })
    setBusy(false)
    if (outcome.kind === 'offline') setNotice(t('pair.revoke.offline'))
    else if (outcome.kind === 'failed')
      setNotice(t('pair.revoke.failed', { reason: outcome.reason }))
    else finish()
  }

  if (notice) {
    return (
      <Dialog visible onClose={finish}>
        <Text style={[styles.title, { color: theme.c.ink }]}>{t('pair.revoke.done')}</Text>
        <Text style={[styles.detail, { color: theme.c.ink2 }]} testID="remove:notice">
          {notice}
        </Text>
        <View style={styles.buttons}>
          <Button label={t('pair.ok')} testID="remove:ok" onPress={finish} />
        </View>
      </Dialog>
    )
  }
  return (
    <Dialog visible onClose={busy ? () => {} : onClose}>
      <Text style={[styles.title, { color: theme.c.ink }]}>{t('devices.remove.title')}</Text>
      <Text style={[styles.detail, { color: theme.c.ink2 }]}>{t('devices.remove.note')}</Text>
      {canRevoke ? (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: revoke }}
          testID="remove:revoke"
          style={styles.check}
          onPress={() => setRevoke((value) => !value)}
        >
          <Text style={[styles.box, { color: theme.c.ink, fontFamily: theme.font.mono }]}>
            {revoke ? theme.check.on : theme.check.off}
          </Text>
          <Text style={[styles.detail, styles.checkLabel, { color: theme.c.ink }]}>
            {t('pair.revoke')}
          </Text>
        </Pressable>
      ) : null}
      <View style={styles.buttons}>
        <Button kind="plain" label={t('app.cancel')} disabled={busy} onPress={onClose} />
        <Button
          kind="danger"
          label={t('devices.remove')}
          busy={busy}
          testID="confirm:ok"
          onPress={() => void confirm()}
        />
      </View>
    </Dialog>
  )
}

const styles = StyleSheet.create({
  title: { fontSize: 17, fontWeight: '600' },
  detail: { fontSize: 14, lineHeight: 20 },
  check: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingVertical: 4 },
  box: { fontSize: 14, lineHeight: 20 },
  checkLabel: { flex: 1 },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
})
