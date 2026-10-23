// 一个 provider 一张卡：登没登录、是不是在用（能切换的可以改用它）、能怎么登录（浏览器授权、设备码、
// 粘贴授权码直接开始；API key、只认环境变量的先在卡里填）、登出；自定义的能改、能删（先问）。
// 进行中的登录挂在卡下面一步一步往下走（Attempt.tsx）。
import type { HcAttempt, HcAuthField, HcAuthMethod, HcProvider, HcProvidersView } from '@litch/core'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { usableMethods } from '../../../../../../packages/ui/src/devices/hconfig/logic.ts'
import { useChannel } from '../../../shell/services'
import { useT } from '../../../ui/i18n'
import { Button, Chip } from '../../../ui/kit/controls'
import { Confirm } from '../../../ui/kit/overlays'
import { useTheme } from '../../../ui/theme'
import { AttemptView } from './Attempt'
import { isLive } from './logic'
import { AuthFields, filled, inputsOf, Note, SaidNote, useSaid } from './parts'

/** 要先填点东西再开始的登录方式：API key、环境变量。OAuth 要填的在后面的步骤里问 */
const needsForm = (method: HcAuthMethod): boolean =>
  method.kind === 'env' || method.kind === 'apiKey'

export function ProviderCard({
  deviceId,
  harnessId,
  data,
  provider,
  attempts,
  onEdit,
}: {
  deviceId: string
  harnessId: string
  data: HcProvidersView
  provider: HcProvider
  attempts: HcAttempt[]
  onEdit(): void
}) {
  const theme = useTheme()
  const t = useT()
  const channel = useChannel()
  const { c } = theme
  const { said, busy, run } = useSaid()
  const [method, setMethod] = useState<HcAuthMethod | null>(null)
  const [asking, setAsking] = useState<'logout' | 'remove' | null>(null)
  const base = { deviceId, harness: harnessId, providerId: provider.id }
  const methods = usableMethods(provider.methods)
  const { auth } = provider
  const live = attempts.some(isLive)
  const title = t.said(provider.title)
  const tid = `hc:provider:${provider.id}`

  const start = (one: HcAuthMethod) => {
    if (needsForm(one)) {
      setMethod(one)
      return
    }
    setMethod(null)
    void run(() => channel.command('harnessConfig.auth.start', { ...base, methodId: one.id }))
  }
  const activate = () =>
    void run(
      () =>
        channel.command('harnessConfig.providers.activate', {
          ...base,
          expectedVersion: data.version,
        }),
      (result) =>
        t(result.restartRequired ? 'hc.provider.activated.restart' : 'hc.provider.activated', {
          name: title,
        }),
    )
  const confirmed = (what: 'logout' | 'remove') =>
    void run<unknown>(() =>
      what === 'logout'
        ? channel.command('harnessConfig.auth.logout', base)
        : channel.command('harnessConfig.providers.remove', base),
    )

  const authText = auth.signedIn
    ? auth.label
      ? t('hc.auth.signedInAs', { label: auth.label })
      : t(`hc.auth.kind.${auth.kind}`)
    : t('hc.auth.signedOut')
  return (
    <View
      style={[
        styles.card,
        { borderBottomColor: c.line1 },
        provider.active ? { borderLeftColor: c.accent, borderLeftWidth: 3 } : null,
      ]}
      testID={tid}
    >
      <View style={styles.head}>
        <Text style={[styles.title, { color: c.ink }]} numberOfLines={1}>
          {title}
          {provider.kind === 'custom' ? (
            <Text style={{ color: c.ink3 }}> · {t('hc.provider.custom')}</Text>
          ) : null}
        </Text>
        {provider.active ? (
          <Text style={[styles.tag, { color: c.invFg, backgroundColor: c.invBg }]}>
            {t('hc.provider.active')}
          </Text>
        ) : data.switchable ? (
          <Chip
            label={t('hc.provider.activate')}
            disabled={busy}
            testID={`${tid}:activate`}
            onPress={activate}
          />
        ) : null}
      </View>
      <Text style={[styles.small, { color: auth.signedIn ? c.ok : c.ink3 }]} testID={`${tid}:auth`}>
        {authText}
      </Text>
      {auth.detail ? (
        <Text style={[styles.small, { color: c.ink3 }]}>{t.said(auth.detail)}</Text>
      ) : null}
      {provider.kind === 'custom' && provider.definition ? (
        <Definition data={data} provider={provider} />
      ) : null}
      <View style={styles.acts}>
        {methods.map((one) => (
          <Chip
            key={one.id}
            label={t.said(one.title)}
            on={method?.id === one.id}
            disabled={live || busy}
            testID={`${tid}:method:${one.id}`}
            onPress={() => start(one)}
          />
        ))}
        {provider.kind === 'custom' ? (
          <>
            <Chip label={t('hc.edit')} testID={`${tid}:edit`} onPress={onEdit} />
            <Chip
              label={t('hc.remove')}
              testID={`${tid}:remove`}
              onPress={() => setAsking('remove')}
            />
          </>
        ) : null}
        {provider.canLogout && auth.signedIn ? (
          <Chip
            label={t('hc.auth.logout')}
            testID={`${tid}:logout`}
            onPress={() => setAsking('logout')}
          />
        ) : null}
      </View>
      {method ? (
        <MethodForm
          deviceId={deviceId}
          harnessId={harnessId}
          provider={provider}
          method={method}
          onClose={() => setMethod(null)}
        />
      ) : null}
      {attempts.map((attempt) => (
        <AttemptView
          key={attempt.attemptId}
          deviceId={deviceId}
          harness={harnessId}
          attempt={attempt}
          title={title}
        />
      ))}
      <SaidNote said={said} testID={`${tid}:said`} />
      <Confirm
        visible={asking !== null}
        danger
        title={t(asking === 'logout' ? 'hc.auth.logout.title' : 'hc.provider.remove.title', {
          name: title,
        })}
        detail={t(asking === 'logout' ? 'hc.auth.logout.note' : 'hc.provider.remove.note')}
        confirmLabel={t(asking === 'logout' ? 'hc.auth.logout' : 'hc.remove')}
        onConfirm={() => {
          if (asking) confirmed(asking)
        }}
        onClose={() => setAsking(null)}
      />
    </View>
  )
}

/** 自定义 provider 现在的定义：按模板的字段摆成几行（密钥只说设没设） */
function Definition({ data, provider }: { data: HcProvidersView; provider: HcProvider }) {
  const theme = useTheme()
  const t = useT()
  const template = data.templates.find((one) => one.id === provider.templateId)
  const definition = provider.definition ?? {}
  if (!template) return null
  return template.fields.map((field) => {
    const value = definition[field.key]
    if (value === undefined || value === null || value === '') return null
    const shown =
      field.type === 'secret'
        ? t((value as { set?: boolean }).set ? 'manage.secret.set' : 'manage.secret.unset')
        : Array.isArray(value)
          ? value.map(String).join(', ')
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value)
    return (
      <Text key={field.key} numberOfLines={1} style={[styles.small, { color: theme.c.ink2 }]}>
        {t.said(field.title)}:{' '}
        <Text style={{ fontFamily: theme.font.mono, color: theme.c.ink }}>{shown}</Text>
      </Text>
    )
  })
}

/** 要先填东西的登录：API key；只认环境变量的写进设备设置里这个 harness 的环境变量表 */
function MethodForm({
  deviceId,
  harnessId,
  provider,
  method,
  onClose,
}: {
  deviceId: string
  harnessId: string
  provider: HcProvider
  method: HcAuthMethod
  onClose(): void
}) {
  const theme = useTheme()
  const t = useT()
  const channel = useChannel()
  const { said, setSaid, busy, run } = useSaid()
  const [values, setValues] = useState<Record<string, string>>({})
  const env = method.kind === 'env'
  const envName = method.envName ?? ''
  const one = (id: string, title: string): HcAuthField => ({
    id,
    title: { 'zh-CN': title, en: title },
    secret: true,
    optional: false,
    placeholder: null,
    options: [],
  })
  const fields = env
    ? [one('value', envName)]
    : method.fields.length > 0
      ? method.fields
      : // 没声明字段的 API key：就一栏 key
        [one('key', 'API key')]
  const base = { deviceId, harness: harnessId }
  const tid = `hc:provider:${provider.id}:form`

  const submit = async (clear: boolean) => {
    if (env) {
      const result = await run(() =>
        channel.command('harnessConfig.env.set', {
          ...base,
          name: envName,
          value: clear ? null : (values.value ?? ''),
        }),
      )
      if (!result) return
      setValues({})
      setSaid({
        text: t(result.restartRequired ? 'hc.env.saved.restart' : 'hc.env.saved', {
          name: envName,
        }),
        bad: false,
      })
      return
    }
    const done = await run(() =>
      channel.command('harnessConfig.auth.start', {
        ...base,
        providerId: provider.id,
        methodId: method.id,
        inputs: inputsOf(fields, values),
      }),
    )
    // API key 的结果（成了、没成）在下面的登录步骤里说
    if (done) onClose()
  }
  return (
    <View
      style={[styles.form, { borderColor: theme.c.line2, borderRadius: theme.radius.l }]}
      testID={tid}
    >
      <Text style={[styles.formTitle, { color: theme.c.ink }]}>{t.said(method.title)}</Text>
      {method.description ? <Note text={t.said(method.description)} tone="dim" /> : null}
      {env ? <Note text={t('hc.env.note', { name: envName })} tone="dim" /> : null}
      <View style={styles.fields}>
        <AuthFields
          idPrefix={tid}
          fields={fields}
          values={values}
          disabled={busy}
          onChange={setValues}
        />
      </View>
      <View style={styles.formActs}>
        {env ? (
          <Chip
            label={t('hc.env.clear', { name: envName })}
            disabled={busy}
            testID={`${tid}:clear`}
            onPress={() => void submit(true)}
          />
        ) : null}
        <View style={styles.grow} />
        <Button kind="plain" label={t('app.cancel')} onPress={onClose} />
        <Button
          label={t(env ? 'manage.save' : 'hc.auth.submit')}
          busy={busy}
          disabled={!filled(fields, values)}
          testID={`${tid}:submit`}
          onPress={() => void submit(false)}
        />
      </View>
      <SaidNote said={said} testID={`${tid}:said`} />
    </View>
  )
}

const styles = StyleSheet.create({
  card: { paddingVertical: 10, gap: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16 },
  title: { flex: 1, fontSize: 15, fontWeight: '600' },
  tag: { fontSize: 12, paddingHorizontal: 6, paddingVertical: 2 },
  small: { fontSize: 12, lineHeight: 17, paddingHorizontal: 16 },
  acts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingTop: 6 },
  form: { borderWidth: 1, marginHorizontal: 12, marginTop: 10, paddingVertical: 8, gap: 6 },
  formTitle: { fontSize: 14, fontWeight: '600', paddingHorizontal: 16 },
  fields: { gap: 10, paddingHorizontal: 16 },
  formActs: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  grow: { flex: 1 },
})
