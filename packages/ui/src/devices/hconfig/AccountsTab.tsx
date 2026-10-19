// 账号这一块：这个 harness 的各个 provider，每个一张卡：登没登录、是不是在用（能切换的可以切）、
// 能怎么登录（浏览器授权、设备码、粘贴授权码、API key、只认环境变量的写进设备设置），登出；
// 自定义的 provider 按模板新增、改、删。进行中的登录挂在它那张卡下面，一步一步往下走。
import type {
  DeviceView,
  HarnessConfigTopicView,
  HcAuthMethod,
  HcProvider,
  HcProvidersView,
  HcTemplate,
  HcValue,
} from '@litch/core'
import { useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { Confirm } from '../../app/Confirm.tsx'
import { whyNot } from '../../app/errors.ts'
import { useServices } from '../../app/services.tsx'
import { showToast } from '../../app/toasts.tsx'
import { HcControl } from './HcControl.tsx'
import { type HcDraft, parseDraft, usableMethods } from './logic.ts'
import { AttemptView, AuthFields, filled, HcDialog, inputsOf, SlotState, useRun } from './parts.tsx'

interface AccountsTabProps {
  device: DeviceView
  harnessId: string
  view: HarnessConfigTopicView
}

/** 要先填点东西再开始的登录方式：API key（fields 只对它有意义）、环境变量。OAuth 要填的在后面的步骤里问 */
const needsForm = (method: HcAuthMethod): boolean =>
  method.kind === 'env' || method.kind === 'apiKey'

export function AccountsTab({ device, harnessId, view }: AccountsTabProps) {
  const t = useT()
  const { channel } = useServices()
  const slot = view.providers
  const data = slot.data
  /** 正在新增（null 是新的）或改的自定义 provider */
  const [custom, setCustom] = useState<{ provider: HcProvider | null } | null>(null)
  if (!data) {
    return (
      <SlotState
        slot={slot}
        onRetry={() =>
          void channel
            .command('harnessConfig.reload', {
              deviceId: device.id,
              harness: harnessId,
              part: 'providers',
            })
            .catch(() => {})
        }
      />
    )
  }
  return (
    <div className="hc-tab" data-hc-tab="accounts" data-version={data.version}>
      <p className="mng-sec-note">
        {t(data.switchable ? 'hc.accounts.note.switch' : 'hc.accounts.note')}
      </p>
      <div className="hc-cards">
        {data.providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            device={device}
            harnessId={harnessId}
            data={data}
            provider={provider}
            attempts={view.attempts.filter((one) => one.providerId === provider.id)}
            onEdit={() => setCustom({ provider })}
          />
        ))}
      </div>
      {data.templates.length > 0 ? (
        <div className="hc-actions">
          <button
            type="button"
            className="btn"
            data-act="hc-provider-add"
            onClick={() => setCustom({ provider: null })}
          >
            {t('hc.provider.add')}
          </button>
        </div>
      ) : null}
      {custom ? (
        <CustomDialog
          device={device}
          harnessId={harnessId}
          data={data}
          provider={custom.provider}
          onClose={() => setCustom(null)}
        />
      ) : null}
    </div>
  )
}

interface CardProps {
  device: DeviceView
  harnessId: string
  data: HcProvidersView
  provider: HcProvider
  attempts: HarnessConfigTopicView['attempts']
  onEdit(): void
}

function ProviderCard({ device, harnessId, data, provider, attempts, onEdit }: CardProps) {
  const t = useT()
  const { channel } = useServices()
  const run = useRun()
  const [method, setMethod] = useState<HcAuthMethod | null>(null)
  const [asking, setAsking] = useState<'logout' | 'remove' | null>(null)
  const [busy, setBusy] = useState(false)
  const base = { deviceId: device.id, harness: harnessId, providerId: provider.id }
  const id = `hc-provider:${device.id}:${harnessId}:${provider.id}`
  const methods = usableMethods(provider.methods)
  const { auth } = provider
  const live = attempts.some((one) => one.step.kind !== 'done' && one.step.kind !== 'failed')
  const title = t.said(provider.title)

  const start = (one: HcAuthMethod) => {
    if (needsForm(one)) {
      setMethod(one)
      return
    }
    void run(id, () => channel.command('harnessConfig.auth.start', { ...base, methodId: one.id }))
  }
  const activate = async () => {
    setBusy(true)
    const result = await run(id, () =>
      channel.command('harnessConfig.providers.activate', {
        ...base,
        expectedVersion: data.version,
      }),
    )
    setBusy(false)
    if (result) {
      showToast({
        id,
        text: (say) =>
          say(result.restartRequired ? 'hc.provider.activated.restart' : 'hc.provider.activated', {
            name: title,
          }),
        lifeMs: 4000,
      })
    }
  }
  const confirmed = async () => {
    const what = asking
    setAsking(null)
    if (what === 'logout') await run(id, () => channel.command('harnessConfig.auth.logout', base))
    if (what === 'remove')
      await run(id, () => channel.command('harnessConfig.providers.remove', base))
  }

  return (
    <section
      className={provider.active ? 'hc-card active' : 'hc-card'}
      data-hc-provider={provider.id}
      data-signed-in={auth.signedIn}
      data-active={provider.active}
    >
      <div className="hc-card-head">
        <b className="ell">{title}</b>
        {provider.kind === 'custom' ? (
          <span className="mng-tag">{t('hc.provider.custom')}</span>
        ) : null}
        <span className="grow" />
        <span className={auth.signedIn ? 'pill ok' : 'pill mute'} data-hc-auth>
          {auth.signedIn
            ? auth.label
              ? t('hc.auth.signedInAs', { label: auth.label })
              : t(`hc.auth.kind.${auth.kind}`)
            : t('hc.auth.signedOut')}
        </span>
        {provider.active ? (
          <span className="pill" data-hc-active>
            {t('hc.provider.active')}
          </span>
        ) : data.switchable ? (
          <button
            type="button"
            className="mini"
            data-act="hc-provider-activate"
            disabled={busy}
            onClick={() => void activate()}
          >
            {t('hc.provider.activate')}
          </button>
        ) : null}
      </div>
      {auth.detail ? <span className="form-note">{t.said(auth.detail)}</span> : null}
      {provider.kind === 'custom' && provider.definition ? (
        <Definition data={data} provider={provider} />
      ) : null}
      <div className="hc-card-acts">
        {methods.map((one) => (
          <button
            key={one.id}
            type="button"
            className="btn"
            data-act="hc-method"
            data-method={one.id}
            data-kind={one.kind}
            disabled={live}
            title={one.description ? t.said(one.description) : undefined}
            onClick={() => start(one)}
          >
            {t.said(one.title)}
          </button>
        ))}
        <span className="grow" />
        {provider.kind === 'custom' ? (
          <>
            <button type="button" className="mini" data-act="hc-provider-edit" onClick={onEdit}>
              {t('hc.edit')}
            </button>
            <button
              type="button"
              className="mini"
              data-act="hc-provider-remove"
              onClick={() => setAsking('remove')}
            >
              {t('hc.remove')}
            </button>
          </>
        ) : null}
        {provider.canLogout && auth.signedIn ? (
          <button
            type="button"
            className="mini"
            data-act="hc-logout"
            onClick={() => setAsking('logout')}
          >
            {t('hc.auth.logout')}
          </button>
        ) : null}
      </div>
      {attempts.map((attempt) => (
        <AttemptView
          key={attempt.attemptId}
          deviceId={device.id}
          harness={harnessId}
          attempt={attempt}
          title={title}
        />
      ))}
      {method ? (
        <MethodDialog
          device={device}
          harnessId={harnessId}
          provider={provider}
          method={method}
          onClose={() => setMethod(null)}
        />
      ) : null}
      {asking ? (
        <Confirm
          title={t(asking === 'logout' ? 'hc.auth.logout.title' : 'hc.provider.remove.title', {
            name: title,
          })}
          note={t(asking === 'logout' ? 'hc.auth.logout.note' : 'hc.provider.remove.note')}
          yes={t(asking === 'logout' ? 'hc.auth.logout' : 'hc.remove')}
          no={t('permission.confirm.no')}
          onYes={() => void confirmed()}
          onClose={() => setAsking(null)}
        />
      ) : null}
    </section>
  )
}

/** 自定义 provider 现在的定义：按模板的字段摆成几行（密钥只说设没设） */
function Definition({ data, provider }: { data: HcProvidersView; provider: HcProvider }) {
  const t = useT()
  const template = data.templates.find((one) => one.id === provider.templateId)
  const definition = provider.definition ?? {}
  if (!template) return null
  return (
    <dl className="hc-def">
      {template.fields.map((field) => {
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
          <div key={field.key}>
            <dt>{t.said(field.title)}</dt>
            <dd className="mono ell">{shown}</dd>
          </div>
        )
      })}
    </dl>
  )
}

/** 要先填东西的登录：API key；只认环境变量的写进设备设置里这个 harness 的环境变量表 */
function MethodDialog({
  device,
  harnessId,
  provider,
  method,
  onClose,
}: {
  device: DeviceView
  harnessId: string
  provider: HcProvider
  method: HcAuthMethod
  onClose(): void
}) {
  const t = useT()
  const { channel } = useServices()
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const env = method.kind === 'env'
  const envName = method.envName ?? ''
  const fields = env
    ? [
        {
          id: 'value',
          title: { 'zh-CN': envName, en: envName },
          secret: true,
          optional: false,
          placeholder: null,
          options: [],
        },
      ]
    : method.fields.length > 0
      ? method.fields
      : // 没声明字段的 API key：就一栏 key
        [
          {
            id: 'key',
            title: { 'zh-CN': 'API key', en: 'API key' },
            secret: true,
            optional: false,
            placeholder: null,
            options: [],
          },
        ]
  const base = { deviceId: device.id, harness: harnessId }

  const setEnv = async (value: string | null) => {
    const result = await channel.command('harnessConfig.env.set', { ...base, name: envName, value })
    showToast({
      id: `hc-env:${device.id}:${harnessId}:${envName}`,
      text: (say) =>
        say(result.restartRequired ? 'hc.env.saved.restart' : 'hc.env.saved', { name: envName }),
      lifeMs: 5000,
    })
  }
  const submit = async (clear: boolean) => {
    setBusy(true)
    setFailure(null)
    try {
      if (env) await setEnv(clear ? null : (values.value ?? ''))
      else {
        await channel.command('harnessConfig.auth.start', {
          ...base,
          providerId: provider.id,
          methodId: method.id,
          inputs: inputsOf(fields, values),
        })
      }
      onClose()
    } catch (error) {
      setBusy(false)
      setFailure(whyNot(error, t))
    }
  }
  return (
    <HcDialog
      title={`${t.said(provider.title)} · ${t.said(method.title)}`}
      kind={`method-${method.kind}`}
      busy={busy}
      failure={failure}
      yes={t(env ? 'manage.save' : 'hc.auth.submit')}
      ready={filled(fields, values)}
      onSubmit={() => void submit(false)}
      onClose={onClose}
    >
      {method.description ? <p className="form-note">{t.said(method.description)}</p> : null}
      {env ? <p className="form-note">{t('hc.env.note', { name: envName })}</p> : null}
      <AuthFields
        idPrefix={`hc-method-${method.id}`}
        fields={fields}
        values={values}
        disabled={busy}
        onChange={setValues}
      />
      {env ? (
        <button
          type="button"
          className="mini"
          data-act="hc-env-clear"
          disabled={busy}
          onClick={() => void submit(true)}
        >
          {t('hc.env.clear', { name: envName })}
        </button>
      ) : null}
    </HcDialog>
  )
}

/** 按模板新增或改一个自定义 provider。密钥字段不填表示不改 */
function CustomDialog({
  device,
  harnessId,
  data,
  provider,
  onClose,
}: {
  device: DeviceView
  harnessId: string
  data: HcProvidersView
  provider: HcProvider | null
  onClose(): void
}) {
  const t = useT()
  const { channel } = useServices()
  const [templateId, setTemplateId] = useState(provider?.templateId ?? data.templates[0]?.id ?? '')
  const [providerId, setProviderId] = useState(provider?.id ?? '')
  const [drafts, setDrafts] = useState<Record<string, HcDraft>>({})
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const template: HcTemplate | undefined = data.templates.find((one) => one.id === templateId)
  const stored = provider?.definition ?? {}
  const definition: Record<string, HcValue> = {}
  let wrong = false
  for (const field of template?.fields ?? []) {
    const draft = drafts[field.key]
    if (!draft) continue
    const parsed = parseDraft(field, draft)
    if (!parsed.ok) wrong = true
    else if (parsed.value !== null) definition[field.key] = parsed.value
  }
  const ready = !!template && /^[A-Za-z0-9_-]+$/.test(providerId.trim()) && !wrong

  const submit = async () => {
    if (!template) return
    setBusy(true)
    setFailure(null)
    try {
      const result = await channel.command('harnessConfig.providers.upsert', {
        deviceId: device.id,
        harness: harnessId,
        providerId: providerId.trim(),
        templateId: template.id,
        definition,
        expectedVersion: data.version,
      })
      showToast({
        id: `hc-custom:${device.id}:${harnessId}`,
        text: (say) =>
          say(result.restartRequired ? 'hc.saved.restart' : 'manage.saved', { count: 1 }),
        lifeMs: 4000,
      })
      onClose()
    } catch (error) {
      setBusy(false)
      setFailure(whyNot(error, t))
    }
  }
  return (
    <HcDialog
      title={
        provider ? t('hc.provider.edit', { name: t.said(provider.title) }) : t('hc.provider.add')
      }
      kind="provider"
      wide
      busy={busy}
      failure={failure}
      yes={t('manage.save')}
      ready={ready}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      {provider === null && data.templates.length > 1 ? (
        <div className="form-field">
          <label className="form-label" htmlFor="hc-template">
            {t('hc.provider.template')}
          </label>
          <select
            id="hc-template"
            className="req-input mng-select"
            value={templateId}
            onChange={(event) => {
              setTemplateId(event.target.value)
              setDrafts({})
            }}
          >
            {data.templates.map((one) => (
              <option key={one.id} value={one.id}>
                {t.said(one.title)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {template?.description ? <p className="form-note">{t.said(template.description)}</p> : null}
      <div className="form-field">
        <label className="form-label" htmlFor="hc-provider-id">
          {t('hc.provider.id')}
        </label>
        <input
          id="hc-provider-id"
          className="req-input mono"
          value={providerId}
          disabled={provider !== null || busy}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setProviderId(event.target.value)}
        />
        <span className="form-note">{t('hc.provider.id.note')}</span>
      </div>
      {(template?.fields ?? []).map((field) => {
        const draft = drafts[field.key]
        const parsed = draft ? parseDraft(field, draft) : null
        return (
          <div className="form-field" key={field.key} data-hc-field={field.key}>
            <label className="form-label" htmlFor={`hc-def-${field.key}`}>
              {t.said(field.title)}
            </label>
            <HcControl
              id={`hc-def-${field.key}`}
              spec={field}
              stored={field.key in stored ? stored[field.key] : undefined}
              draft={draft}
              disabled={busy}
              wrong={parsed !== null && !parsed.ok}
              label={t.said(field.title)}
              onDraft={(next) =>
                setDrafts((current) => {
                  const rest = { ...current }
                  // 密钥清空了等于不改
                  if (field.type === 'secret' && next.kind === 'value' && next.value === '')
                    delete rest[field.key]
                  else rest[field.key] = next
                  return rest
                })
              }
            />
            {field.description ? (
              <span className="form-note">{t.said(field.description)}</span>
            ) : null}
            {parsed && !parsed.ok ? (
              <span className="form-note err">{t(parsed.problem)}</span>
            ) : null}
          </div>
        )
      })}
    </HcDialog>
  )
}
