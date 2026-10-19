// 一次登录走到哪一步（provider 的登录和 MCP 的授权共用；手机上 MCP 只能看，实际只有 provider 用）：
// 打开授权页、设备码（码和网址都能复制、能在手机浏览器里打开）、要填的表单（粘贴授权码）、成了、没成。
// 授权完要回调到设备端口的（核心给了转发状态，说明设备不是本机）：手机转不了端口。能粘贴的照样走完，
// 不能粘贴的只说一句“请在桌面端完成”，不给打开授权页（打开了也回调不回去）。
import type { HcAttempt, HcAuthField } from '@litch/core'
import * as Clipboard from 'expo-clipboard'
import { type ReactNode, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useChannel } from '../../../shell/services'
import { useT } from '../../../ui/i18n'
import { Button } from '../../../ui/kit/controls'
import { useTheme } from '../../../ui/theme'
import { callbackOf, isLive } from './logic'
import { AuthFields, filled, inputsOf, Note, openOutside, SaidNote, useSaid } from './parts'

export function AttemptView({
  deviceId,
  harness,
  attempt,
  title,
}: {
  deviceId: string
  harness: string
  attempt: HcAttempt
  /** 登的是谁（provider 或 MCP 服务的名字） */
  title: string
}) {
  const theme = useTheme()
  const t = useT()
  const channel = useChannel()
  const { c } = theme
  const { said, setSaid, run } = useSaid()
  const [values, setValues] = useState<Record<string, string>>({})
  const { step, busy } = attempt
  const base = { deviceId, harness, attemptId: attempt.attemptId }
  const tid = `hc:attempt:${attempt.attemptId}`
  const callback = callbackOf(attempt)
  const send = (fields: readonly HcAuthField[]) => {
    if (!filled(fields, values)) return
    void run(() =>
      channel.command('harnessConfig.auth.continue', { ...base, inputs: inputsOf(fields, values) }),
    ).then((done) => {
      if (done) setValues({})
    })
  }
  const copy = (text: string) => {
    void Clipboard.setStringAsync(text).then(() => setSaid({ text: t('hcm.copied'), bad: false }))
  }
  const mono = (text: string, big = false) => (
    <Text
      selectable
      testID={big ? `${tid}:userCode` : `${tid}:url`}
      style={[
        big ? styles.code : styles.url,
        { color: c.ink, fontFamily: theme.font.mono, backgroundColor: c.sunken },
      ]}
    >
      {text}
    </Text>
  )
  const form = (fields: readonly HcAuthField[], yes: string) =>
    fields.length > 0 ? (
      <View style={styles.form}>
        <AuthFields
          idPrefix={tid}
          fields={fields}
          values={values}
          disabled={busy}
          onChange={setValues}
        />
        <View style={styles.formActs}>
          <Button
            label={busy ? t('hc.auth.sending') : yes}
            busy={busy}
            disabled={!filled(fields, values)}
            testID={`${tid}:send`}
            onPress={() => send(fields)}
          />
        </View>
      </View>
    ) : null

  let body: ReactNode = null
  switch (step.kind) {
    case 'openUrl':
      body =
        callback && !callback.paste ? (
          <Note text={t('hcm.callback.desktop', { port: callback.port })} tone="wait" />
        ) : (
          <>
            <Note text={step.message ? t.said(step.message) : t('hc.auth.openUrl')} />
            {mono(step.url)}
            <View style={styles.acts}>
              <Button kind="plain" label={t('hc.auth.copy')} onPress={() => copy(step.url)} />
              <Button
                label={t('hc.auth.open')}
                testID={`${tid}:open`}
                onPress={() => openOutside(step.url)}
              />
            </View>
            {callback ? (
              <Note text={t('hcm.callback.paste', { port: callback.port })} tone="wait" />
            ) : null}
            {form(step.prompt, t('hc.auth.paste'))}
          </>
        )
      break
    case 'deviceCode':
      body = (
        <>
          <Note text={step.message ? t.said(step.message) : t('hc.auth.deviceCode')} />
          {mono(step.userCode, true)}
          {mono(step.url)}
          <View style={styles.acts}>
            <Button
              kind="plain"
              label={t('hc.auth.copy')}
              testID={`${tid}:copy`}
              onPress={() => copy(step.userCode)}
            />
            <Button
              label={t('hc.auth.open')}
              testID={`${tid}:open`}
              onPress={() => openOutside(step.url)}
            />
          </View>
        </>
      )
      break
    case 'prompt':
      body = (
        <>
          {step.message ? <Note text={t.said(step.message)} /> : null}
          {form(step.fields, t('hc.auth.submit'))}
        </>
      )
      break
    case 'done':
      body = (
        <Note
          tone="ok"
          testID={`${tid}:done`}
          text={
            step.auth.label ? t('hc.auth.doneAs', { label: step.auth.label }) : t('hc.auth.done')
          }
        />
      )
      break
    case 'failed':
      body = (
        <Note
          tone="err"
          testID={`${tid}:failed`}
          text={t('hc.auth.failed', { reason: t.said(step.message) })}
        />
      )
      break
  }
  return (
    <View style={[styles.attempt, { borderColor: c.line2, backgroundColor: c.panel }]} testID={tid}>
      <View style={styles.head}>
        <Text style={[styles.title, { color: c.ink }]} numberOfLines={1}>
          {t('hc.auth.title', { name: title })}
        </Text>
        <Button
          kind="plain"
          label={isLive(attempt) ? t('workspace.cancel') : t('hc.auth.dismiss')}
          testID={`${tid}:${isLive(attempt) ? 'cancel' : 'dismiss'}`}
          onPress={() =>
            void run(() =>
              channel.command(
                isLive(attempt) ? 'harnessConfig.auth.cancel' : 'harnessConfig.auth.dismiss',
                base,
              ),
            )
          }
        />
      </View>
      {body}
      <SaidNote said={said} />
    </View>
  )
}

const styles = StyleSheet.create({
  attempt: { borderWidth: 1, marginHorizontal: 12, marginTop: 10, paddingVertical: 8, gap: 4 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: 16,
    paddingRight: 8,
  },
  title: { flex: 1, fontSize: 14, fontWeight: '600' },
  url: { fontSize: 12, marginHorizontal: 16, padding: 8 },
  code: {
    fontSize: 24,
    letterSpacing: 2,
    textAlign: 'center',
    marginHorizontal: 16,
    paddingVertical: 10,
  },
  acts: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 16 },
  form: { gap: 10, paddingHorizontal: 16, paddingTop: 6 },
  formActs: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
})
