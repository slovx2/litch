// 设备几页共用的小块：没连上的原因卡、公钥卡、主机钥匙的确认、线色选择、一行“名字：值”。
import { type ConnectFailureView, type RemoteTarget, WIRES, type WireColor } from '@litch/core'
import * as Clipboard from 'expo-clipboard'
import { type ReactNode, useCallback, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { HostKey } from '../../../modules/litch-ssh/src'
import { ssh } from '../../../modules/litch-ssh/src'
import { knownHost, trustHost } from '../../platform/known-hosts'
import { sshProblem } from '../../platform/ssh-errors'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { Confirm } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'
import { authorizeCommand, hostKeyCommand, reasonText, stepsOf } from './failure'

/** 一行“名字：值”。值用等宽字，能长按选中复制 */
export function InfoLine({
  label,
  value,
  testID,
}: {
  label: string
  value: string
  testID?: string
}) {
  const theme = useTheme()
  return (
    <View style={styles.info}>
      <Text style={[styles.infoLabel, { color: theme.c.ink3 }]}>{label}</Text>
      <Text
        selectable
        testID={testID}
        style={[styles.infoValue, { color: theme.c.ink, fontFamily: theme.font.mono }]}
      >
        {value}
      </Text>
    </View>
  )
}

/** 一段等宽的、能复制的字（命令、公钥）加一个复制按钮 */
export function CopyBlock({
  text,
  label,
  testID,
}: {
  text: string
  label: string
  testID?: string
}) {
  const theme = useTheme()
  const t = useT()
  const [copied, setCopied] = useState(false)
  return (
    <View style={styles.copy}>
      <Text
        selectable
        style={[
          styles.code,
          { color: theme.c.ink, backgroundColor: theme.c.sunken, fontFamily: theme.font.mono },
        ]}
      >
        {text}
      </Text>
      <Button
        kind="plain"
        testID={testID}
        label={copied ? t('devices.key.copied') : label}
        onPress={() => {
          void Clipboard.setStringAsync(text).then(() => setCopied(true))
        }}
      />
    </View>
  )
}

/** 公钥和把它加到那台机器上的那一句 */
export function PublicKeyCard({ publicKey }: { publicKey: string }) {
  const theme = useTheme()
  const t = useT()
  return (
    <View style={styles.block}>
      <CopyBlock text={publicKey} label={t('devices.key.copy')} testID="key:copy" />
      <Text style={[styles.note, { color: theme.c.ink2 }]}>{t('devices.key.authorize')}</Text>
      <CopyBlock
        text={authorizeCommand(publicKey)}
        label={t('devices.key.copyCommand')}
        testID="key:copyCommand"
      />
    </View>
  )
}

/** 没连上的原因、该怎么办、对面的原话。publicKey 给了的话，登录被拒时把公钥卡也摆上 */
export function FailureCard({
  failure,
  target,
  publicKey,
  actions,
}: {
  failure: ConnectFailureView
  target: RemoteTarget | null
  publicKey?: string | null
  actions?: ReactNode
}) {
  const theme = useTheme()
  const t = useT()
  const [open, setOpen] = useState(false)
  const steps = stepsOf(failure, target)
  return (
    <View
      style={[
        styles.failure,
        {
          borderColor: theme.c.err,
          backgroundColor: theme.c.raised,
          borderRadius: theme.radius.l,
        },
      ]}
      testID={`failure:${failure.stage}`}
    >
      <Text style={[styles.failureStage, { color: theme.c.err }]}>
        {t(`add.stage.${failure.stage}`)}
      </Text>
      <Text style={[styles.note, { color: theme.c.ink }]} testID="failure:reason">
        {reasonText(failure, t)}
      </Text>
      {steps.map((step) => (
        <View key={step.text} style={styles.block}>
          <Text style={[styles.note, { color: theme.c.ink2 }]}>{t(step.text)}</Text>
          {step.command ? <CopyBlock text={step.command} label={t('devices.guide.copy')} /> : null}
        </View>
      ))}
      {failure.stage === 'auth' && publicKey ? <PublicKeyCard publicKey={publicKey} /> : null}
      {actions}
      {failure.detail ? (
        <Pressable accessibilityRole="button" onPress={() => setOpen(!open)} testID="failure:said">
          <Text style={[styles.toggle, { color: theme.c.ink3 }]}>
            {open ? '▾' : '▸'} {t('harness.said')}
          </Text>
          {open ? (
            <Text
              selectable
              style={[styles.code, { color: theme.c.ink2, fontFamily: theme.font.mono }]}
            >
              {failure.detail}
            </Text>
          ) : null}
        </Pressable>
      ) : null}
    </View>
  )
}

interface Pending {
  host: string
  key: HostKey
  old: string | null
  answer: boolean
  resolve(trusted: boolean): void
}

/**
 * 确认主机钥匙：读对面的指纹，没信任过或者变了就问一声，点了信任才记下。
 * 返回的 confirm 解析成“现在信任的是对面给的这一个”；dialog 要放进页面里
 */
export function useHostTrust(): {
  confirm(host: string, port: number, user: string): Promise<boolean>
  dialog: ReactNode
  error: string | null
  notice: string | null
} {
  const t = useT()
  const [pending, setPending] = useState<Pending | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const current = useRef<Pending | null>(null)
  const confirm = useCallback(
    async (host: string, port: number, user: string) => {
      setError(null)
      setNotice(null)
      let key: HostKey
      try {
        key = await ssh.probeHost(host, port, user)
      } catch (failed) {
        setError(t('devices.trust.failed', { reason: sshProblem(failed).message }))
        return false
      }
      const known = knownHost(host, port)
      if (known?.fingerprint === key.fingerprint) {
        setNotice(t('devices.trust.same', { fingerprint: key.fingerprint }))
        return true
      }
      return new Promise<boolean>((resolve) => {
        const next: Pending = {
          host,
          key,
          old: known?.fingerprint ?? null,
          answer: false,
          resolve: (trusted) => {
            if (trusted) trustHost(host, port, key)
            resolve(trusted)
          },
        }
        current.current = next
        setPending(next)
      })
    },
    [t],
  )
  const close = () => {
    const was = current.current
    current.current = null
    setPending(null)
    // 确认框先关、再调“确认”：等这一拍过完再看答的是什么
    if (was) void Promise.resolve().then(() => was.resolve(was.answer))
  }
  const dialog = pending ? (
    <Confirm
      visible
      danger={pending.old !== null}
      title={t(pending.old ? 'devices.trust.changed.title' : 'devices.trust.title')}
      detail={
        pending.old
          ? t('devices.trust.changed.detail', {
              host: pending.host,
              fingerprint: pending.key.fingerprint,
              old: pending.old,
            })
          : t('devices.trust.detail', {
              host: pending.host,
              type: pending.key.keyType,
              fingerprint: pending.key.fingerprint,
              command: hostKeyCommand(pending.key.keyType),
            })
      }
      confirmLabel={t(pending.old ? 'devices.trust.changed.yes' : 'devices.trust.yes')}
      onConfirm={() => {
        pending.answer = true
      }}
      onClose={close}
    />
  ) : null
  return { confirm, dialog, error, notice }
}

/** 八种线色排一行，点哪个换哪个 */
export function WirePicker({ value, onPick }: { value: WireColor; onPick(wire: WireColor): void }) {
  const theme = useTheme()
  const t = useT()
  return (
    <View style={styles.wires}>
      {WIRES.map((wire) => (
        <Pressable
          key={wire}
          accessibilityRole="button"
          accessibilityLabel={t(`devices.color.${wire}`)}
          accessibilityState={{ selected: wire === value }}
          testID={`wire:${wire}`}
          onPress={() => onPick(wire)}
          style={[
            styles.wire,
            {
              backgroundColor: theme.c.wire[wire],
              borderColor: wire === value ? theme.c.line3 : 'transparent',
              borderRadius: theme.radius.s,
            },
          ]}
        />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  info: { paddingHorizontal: 16, paddingVertical: 8, gap: 2 },
  infoLabel: { fontSize: 12 },
  infoValue: { fontSize: 13 },
  copy: { gap: 6 },
  code: { fontSize: 12, padding: 8, lineHeight: 17 },
  block: { gap: 8 },
  note: { fontSize: 14, lineHeight: 20 },
  failure: { margin: 16, padding: 12, borderWidth: 1, gap: 10 },
  failureStage: { fontSize: 13, fontWeight: '600' },
  toggle: { fontSize: 13, paddingVertical: 4 },
  wires: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  wire: { width: 36, height: 36, borderWidth: 3 },
})
