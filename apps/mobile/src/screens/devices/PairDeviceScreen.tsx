// 扫码添加：扫电脑上的配对二维码（或者粘贴配对文本）→ 确认要加的设备（地址是电脑上定的，这里不能改）
// → 添加：生成手机自己的钥匙、用一次性钥匙登记（显示确认码，等电脑上点允许）、记下主机指纹、用自己的钥匙检查并添加。
// 流程本身在 src/platform/pairing.ts。配对文本是秘密（短时、一次），只放在这一页的状态里，不进路由参数、不落盘。
// Tailscale 方式的码在确认页多一句“先打开手机上的 Tailscale”；Tailscale 要浏览器验证时给打开链接和重试。
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { CameraView, useCameraPermissions } from 'expo-camera'
import * as Clipboard from 'expo-clipboard'
import { useEffect, useRef, useState } from 'react'
import { Keyboard, Linking, Platform, StyleSheet, Text, View } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { ssh } from '../../../modules/litch-ssh/src'
import type { RootStackParamList } from '../../nav/routes'
import { ensureApprovalKey } from '../../platform/approval-key'
import { forgetKey, generateKey, keySecret } from '../../platform/keys'
import { trustHost } from '../../platform/known-hosts'
import {
  looksLikePair,
  type PairDeps,
  type PairPayload,
  type PairProblem,
  type PairStep,
  parsePairText,
  phoneNameOf,
  runPairing,
} from '../../platform/pairing'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button, Field, SectionLabel } from '../../ui/kit/controls'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'
import { InfoLine } from './parts'

type Props = NativeStackScreenProps<RootStackParamList, 'PairDevice'>

type Phase =
  | { kind: 'scan' }
  | { kind: 'confirm'; payload: PairPayload; expired: boolean }
  | { kind: 'run'; payload: PairPayload; step: PairStep }
  | { kind: 'failed'; payload: PairPayload; problem: PairProblem; detail: string | null }

/** 相机那一块：要权限、扫到配对文本就交出去。别的二维码不理 */
function Scanner({ onText }: { onText(text: string): boolean }) {
  const t = useT()
  const theme = useTheme()
  const [permission, request] = useCameraPermissions()
  // 相机一秒回调好几次：交出去一次就不再理
  const taken = useRef(false)
  if (!permission) return <View style={[styles.camera, { backgroundColor: theme.c.sunken }]} />
  if (!permission.granted) {
    return (
      <View style={styles.form}>
        <Text style={[styles.note, { color: theme.c.ink2 }]}>
          {t(permission.canAskAgain ? 'pair.camera.why' : 'pair.camera.denied')}
        </Text>
        {permission.canAskAgain ? (
          <Button
            label={t('pair.camera.allow')}
            testID="pair:camera:allow"
            onPress={() => void request()}
          />
        ) : (
          <Button
            kind="plain"
            label={t('pair.camera.settings')}
            onPress={() => void Linking.openSettings()}
          />
        )}
      </View>
    )
  }
  return (
    <View style={styles.cameraPad}>
      <CameraView
        style={styles.camera}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          if (taken.current || !looksLikePair(data)) return
          // 前缀对了内容却坏了（拍糊了不至于，多半是别的版本出的码）：不算数，接着扫
          taken.current = onText(data)
        }}
      />
    </View>
  )
}

export function PairDeviceScreen({ navigation }: Props) {
  const t = useT()
  const theme = useTheme()
  const channel = useChannel()
  const [phase, setPhase] = useState<Phase>({ kind: 'scan' })
  const [pasted, setPasted] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )

  const take = (text: string): boolean => {
    const parsed = parsePairText(text, Date.now())
    if (!parsed.ok) return false
    setPhase({ kind: 'confirm', payload: parsed.payload, expired: parsed.expired })
    return true
  }
  const submitPasted = () => {
    Keyboard.dismiss()
    setPasteError(take(pasted) ? null : t('pair.notPair'))
  }

  const add = async (payload: PairPayload) => {
    // 停在确认页上的这段时间里可能过期了
    if (payload.e <= Date.now()) {
      setPhase({ kind: 'confirm', payload, expired: true })
      return
    }
    const deps: PairDeps = {
      makeKey: generateKey,
      dropKey: forgetKey,
      privateKey: async (id) => (await keySecret(id))?.privateKey ?? null,
      approvalKey: async () => (await ensureApprovalKey()).approvalKey,
      confirmCode: ssh.pairConfirmCode,
      enroll: ssh.enrollPair,
      trust: trustHost,
      check: (target) => channel.command('remote.check', { target }),
      add: async (name, target) => (await channel.command('device.add', { name, target })).deviceId,
      phoneName: phoneNameOf(Platform.constants as unknown as Record<string, unknown>, Platform.OS),
    }
    const result = await runPairing(payload, deps, (step) => {
      if (alive.current) setPhase({ kind: 'run', payload, step })
    }).catch(
      (error: unknown) =>
        ({
          ok: false,
          problem: 'unknown',
          detail: error instanceof Error ? error.message : String(error),
        }) as const,
    )
    if (!alive.current) return
    if (!result.ok) {
      setPhase({ kind: 'failed', payload, problem: result.problem, detail: result.detail })
      return
    }
    // 自己的钥匙没连上时去设备详情：那里有原因和重试；连上了直接进会话。
    // 加设备页和这一页都不留在栈里：从那里返回就回到首页
    navigation.reset({
      index: 1,
      routes: [
        { name: 'Devices' },
        result.checked
          ? { name: 'Sessions', params: { deviceId: result.deviceId } }
          : { name: 'DeviceDetail', params: { deviceId: result.deviceId } },
      ],
    })
  }

  const again = () => {
    setPasted('')
    setPasteError(null)
    setPhase({ kind: 'scan' })
  }

  return (
    <Screen title={t('pair.title')} testID="pair-device">
      <KeyboardAwareScrollView keyboardShouldPersistTaps="handled" bottomOffset={24}>
        {phase.kind === 'scan' ? (
          <>
            <Scanner onText={take} />
            <SectionLabel>{t('pair.paste')}</SectionLabel>
            <View style={styles.form}>
              <Field
                label={t('pair.paste')}
                hint={t('pair.paste.hint')}
                error={pasteError ?? undefined}
                value={pasted}
                onChangeText={(text) => {
                  setPasted(text)
                  setPasteError(null)
                }}
                multiline
                testID="pair:paste"
              />
              <View style={styles.row}>
                <Button
                  kind="plain"
                  label={t('pair.paste.clipboard')}
                  onPress={() => {
                    void Clipboard.getStringAsync().then((text) => setPasted(text.trim()))
                  }}
                />
                <Button
                  label={t('pair.paste.go')}
                  disabled={!pasted.trim()}
                  testID="pair:paste:go"
                  onPress={submitPasted}
                />
              </View>
            </View>
          </>
        ) : (
          <Target payload={phase.payload} />
        )}

        {phase.kind === 'confirm' ? (
          <View style={styles.form}>
            {phase.payload.m === 'tailscale' ? (
              <Text style={[styles.note, { color: theme.c.ink2 }]} testID="pair:tailscale">
                {t('pair.tailscale')}
              </Text>
            ) : null}
            <Text style={[styles.note, { color: theme.c.ink3 }]}>{t('pair.confirm.fixed')}</Text>
            {phase.expired ? (
              <Text style={[styles.note, { color: theme.c.err }]} testID="pair:expired">
                {t('pair.expired')}
              </Text>
            ) : null}
            <Button
              label={t('pair.add')}
              disabled={phase.expired}
              testID="pair:add"
              onPress={() => void add(phase.payload)}
            />
            <Button kind="plain" label={t('pair.again')} onPress={again} />
          </View>
        ) : null}

        {phase.kind === 'run' ? <Progress step={phase.step} /> : null}

        {phase.kind === 'failed' ? (
          <View style={styles.form} testID={`pair:failed:${phase.problem}`}>
            <Text style={[styles.title, { color: theme.c.err }]}>{t('pair.failed')}</Text>
            <Text style={[styles.note, { color: theme.c.ink }]}>
              {t(`pair.why.${phase.problem}`, { host: phase.payload.h, port: phase.payload.p })}
            </Text>
            {phase.problem === 'verify' && phase.detail ? (
              <>
                <Button
                  label={t('pair.verify.open')}
                  testID="pair:verify"
                  onPress={() => {
                    const url = phase.detail
                    if (url) void Linking.openURL(url)
                  }}
                />
                <Button
                  kind="plain"
                  label={t('pair.retry')}
                  testID="pair:retry"
                  onPress={() => void add(phase.payload)}
                />
              </>
            ) : phase.detail ? (
              <Text selectable style={[styles.detail, { color: theme.c.ink3 }]}>
                {t('pair.detail', { detail: phase.detail })}
              </Text>
            ) : null}
            <Button
              kind={phase.problem === 'verify' ? 'plain' : undefined}
              label={t('pair.again')}
              testID="pair:again"
              onPress={again}
            />
          </View>
        ) : null}
      </KeyboardAwareScrollView>
    </Screen>
  )
}

/** 要加的那台设备：名字和地址四项，只读 */
function Target({ payload }: { payload: PairPayload }) {
  const t = useT()
  return (
    <>
      <SectionLabel>{t('pair.confirm')}</SectionLabel>
      <InfoLine label={t('pair.confirm.name')} value={payload.n || payload.h} testID="pair:name" />
      <InfoLine label={t('pair.confirm.host')} value={payload.h} testID="pair:host" />
      <InfoLine label={t('pair.confirm.port')} value={String(payload.p)} />
      <InfoLine label={t('pair.confirm.user')} value={payload.u} />
    </>
  )
}

/** 进行到哪一步。等电脑上允许时把确认码放大显示 */
function Progress({ step }: { step: PairStep }) {
  const t = useT()
  const theme = useTheme()
  const label = {
    key: t('pair.step.key'),
    enroll: t('pair.step.enroll'),
    check: t('pair.step.check'),
    add: t('pair.step.add'),
  }[step.step]
  return (
    <View style={styles.form} testID={`pair:step:${step.step}`}>
      <Text style={[styles.title, { color: theme.c.ink }]}>{label}</Text>
      {step.step === 'enroll' ? (
        <>
          <Text style={[styles.note, { color: theme.c.ink3 }]}>{t('pair.code')}</Text>
          <Text
            selectable
            testID="pair:code"
            style={[styles.code, { color: theme.c.ink, fontFamily: theme.font.mono }]}
          >
            {`${step.code.slice(0, 3)} ${step.code.slice(3)}`}
          </Text>
          <Text style={[styles.note, { color: theme.c.ink2 }]}>{t('pair.code.hint')}</Text>
        </>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  form: { padding: 16, gap: 14 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'flex-end' },
  note: { fontSize: 14, lineHeight: 20 },
  detail: { fontSize: 12, lineHeight: 18 },
  title: { fontSize: 17, fontWeight: '600' },
  code: { fontSize: 36, letterSpacing: 4, textAlign: 'center', paddingVertical: 8 },
  cameraPad: { padding: 16 },
  camera: { width: '100%', aspectRatio: 1 },
})
