// MCP 这一块：这个 harness 配着的 MCP 服务，一个一行：名字、怎么连、现在连没连上、开关；
// 改、删（先问）、需要授权的走 OAuth 登录（和 provider 的登录一样一步一步来）。新增和改是同一个表单：
// 本地命令（stdio）填命令、参数、目录、环境变量（可以标成密钥，只写不读）；远程（http、sse）填地址、请求头。
// 对面声明的额外字段按配置项的样子画在表单最后。
import type {
  DeviceView,
  HarnessConfigTopicView,
  HcMcpServer,
  HcMcpView,
  HcValue,
} from '@litch/core'
import { type ReactNode, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { Confirm } from '../../app/Confirm.tsx'
import { whyNot } from '../../app/errors.ts'
import { useServices } from '../../app/services.tsx'
import { showToast } from '../../app/toasts.tsx'
import { HcControl } from './HcControl.tsx'
import { formOf, type HcDraft, type McpForm, parseDraft, serverOf } from './logic.ts'
import { AttemptView, HcDialog, SlotState, useRun } from './parts.tsx'

const STATUS_CLASS: Record<string, string> = {
  connected: 'pill ok',
  failed: 'pill err',
  needsAuth: 'pill wait',
  disabled: 'pill mute',
  unknown: 'pill mute',
}

interface McpTabProps {
  device: DeviceView
  harnessId: string
  view: HarnessConfigTopicView
}

export function McpTab({ device, harnessId, view }: McpTabProps) {
  const t = useT()
  const { channel } = useServices()
  const slot = view.mcp
  const data = slot.data
  /** 正在新增（null）或改的服务 */
  const [editing, setEditing] = useState<{ server: HcMcpServer | null } | null>(null)
  if (!data) {
    return (
      <SlotState
        slot={slot}
        onRetry={() =>
          void channel
            .command('harnessConfig.reload', {
              deviceId: device.id,
              harness: harnessId,
              part: 'mcp',
            })
            .catch(() => {})
        }
      />
    )
  }
  return (
    <div className="hc-tab" data-hc-tab="mcp" data-version={data.version}>
      {data.servers.length === 0 ? (
        <div className="mng-state" data-hc-mcp-empty>
          {t('hc.mcp.empty')}
        </div>
      ) : (
        <div className="mng-h">
          <div className="mng-rows">
            {data.servers.map((server) => (
              <McpRow
                key={server.name}
                device={device}
                harnessId={harnessId}
                data={data}
                server={server}
                attempts={view.attempts.filter((one) => one.mcpServer === server.name)}
                onEdit={() => setEditing({ server })}
              />
            ))}
          </div>
        </div>
      )}
      <div className="hc-actions">
        <button
          type="button"
          className="btn"
          data-act="hc-mcp-add"
          onClick={() => setEditing({ server: null })}
        >
          {t('hc.mcp.add')}
        </button>
      </div>
      {data.files.length > 0 ? (
        <div className="hc-files form-note">
          {t('hc.files')}
          {data.files.map((file) => (
            <code key={file.path} className="mono">
              {file.path}
            </code>
          ))}
        </div>
      ) : null}
      {editing ? (
        <McpDialog
          device={device}
          harnessId={harnessId}
          data={data}
          server={editing.server}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  )
}

interface RowProps {
  device: DeviceView
  harnessId: string
  data: HcMcpView
  server: HcMcpServer
  attempts: HarnessConfigTopicView['attempts']
  onEdit(): void
}

function McpRow({ device, harnessId, data, server, attempts, onEdit }: RowProps) {
  const t = useT()
  const { channel } = useServices()
  const run = useRun()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const base = { deviceId: device.id, harness: harnessId }
  const id = `hc-mcp:${device.id}:${harnessId}:${server.name}`
  const remote = server.transport !== 'stdio'
  const live = attempts.some((one) => one.step.kind !== 'done' && one.step.kind !== 'failed')
  const state = server.status?.state ?? null
  const restartToast = (restart: boolean) => {
    if (restart)
      showToast({ id, text: (say) => say('hc.saved.restart', { count: 1 }), lifeMs: 4000 })
  }

  const toggle = async () => {
    setBusy(true)
    const result = await run(id, () =>
      channel.command('harnessConfig.mcp.upsert', {
        ...base,
        // 改已有的都带上原来的名字（只有新增不带），对面才认这是替换
        previousName: server.name,
        // 密钥不带值（对面保留原来的），别的变量原样带上
        server: {
          ...server,
          enabled: !server.enabled,
          env: Object.fromEntries(
            Object.entries(server.env).filter(([name]) => !server.secretKeys.includes(name)),
          ),
        },
        expectedVersion: data.version,
      }),
    )
    setBusy(false)
    if (result) restartToast(result.restartRequired)
  }
  const remove = async () => {
    setAsking(false)
    const result = await run(id, () =>
      channel.command('harnessConfig.mcp.remove', {
        ...base,
        name: server.name,
        expectedVersion: data.version,
      }),
    )
    if (result) restartToast(result.restartRequired)
  }
  const login = () =>
    void run(id, () => channel.command('harnessConfig.mcp.login', { ...base, name: server.name }))

  return (
    <div
      className="mng-row wide hc-mcp"
      data-hc-mcp={server.name}
      data-enabled={server.enabled}
      data-status={state ?? ''}
    >
      <div className="mng-row-text">
        <div className="mng-row-head">
          <span className="mng-row-title">
            {server.name}
            <span className="mng-tag">{server.transport}</span>
          </span>
          {state ? (
            <span className={STATUS_CLASS[state] ?? 'pill mute'}>
              {t(`hc.mcp.status.${state}`)}
            </span>
          ) : null}
          <span className="grow" />
          {remote && data.oauth ? (
            <button
              type="button"
              className="mini"
              data-act="hc-mcp-login"
              disabled={live}
              onClick={login}
            >
              {t('hc.mcp.login')}
            </button>
          ) : null}
          <button type="button" className="mini" data-act="hc-mcp-edit" onClick={onEdit}>
            {t('hc.edit')}
          </button>
          <button
            type="button"
            className="mini"
            data-act="hc-mcp-remove"
            onClick={() => setAsking(true)}
          >
            {t('hc.remove')}
          </button>
          <button
            type="button"
            role="switch"
            className="switch"
            data-act="hc-mcp-toggle"
            aria-checked={server.enabled}
            aria-label={t('hc.mcp.enabled')}
            disabled={busy}
            onClick={() => void toggle()}
          >
            <i />
          </button>
        </div>
        <code className="mono ell form-note">
          {remote ? server.url : [server.command, ...server.args].filter(Boolean).join(' ')}
        </code>
        {server.status?.message ? (
          <span className={state === 'failed' ? 'form-note err' : 'form-note'}>
            {server.status.message}
          </span>
        ) : null}
      </div>
      {attempts.map((attempt) => (
        <AttemptView
          key={attempt.attemptId}
          deviceId={device.id}
          harness={harnessId}
          attempt={attempt}
          title={server.name}
        />
      ))}
      {asking ? (
        <Confirm
          title={t('hc.mcp.remove.title', { name: server.name })}
          note={t('hc.mcp.remove.note')}
          yes={t('hc.remove')}
          no={t('permission.confirm.no')}
          onYes={() => void remove()}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </div>
  )
}

function McpDialog({
  device,
  harnessId,
  data,
  server,
  onClose,
}: {
  device: DeviceView
  harnessId: string
  data: HcMcpView
  server: HcMcpServer | null
  onClose(): void
}) {
  const t = useT()
  const { channel } = useServices()
  const [form, setForm] = useState<McpForm>(() => formOf(server, data.transports))
  const [extra, setExtra] = useState<Record<string, HcDraft>>({})
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const set = (patch: Partial<McpForm>) => setForm((current) => ({ ...current, ...patch }))
  const remote = form.transport !== 'stdio'

  // 额外字段：改过的按配置项的规矩解析，合进 form.extra
  const merged: Record<string, HcValue> = { ...(form.extra as Record<string, HcValue>) }
  let wrong = false
  for (const spec of data.extraFields) {
    const draft = extra[spec.key]
    if (!draft) continue
    const parsed = parseDraft(spec, draft)
    if (!parsed.ok) wrong = true
    else if (parsed.value === null) delete merged[spec.key]
    else merged[spec.key] = parsed.value
  }
  const result = serverOf({ ...form, extra: merged })

  const submit = async () => {
    if (!result.ok || wrong) return
    setBusy(true)
    setFailure(null)
    try {
      const reply = await channel.command('harnessConfig.mcp.upsert', {
        deviceId: device.id,
        harness: harnessId,
        // 改已有的（改没改名）都带上原来的名字；只有新增不带
        ...(server ? { previousName: server.name } : {}),
        server: result.server,
        expectedVersion: data.version,
      })
      showToast({
        id: `hc-mcp-save:${device.id}:${harnessId}`,
        text: (say) =>
          say(reply.restartRequired ? 'hc.saved.restart' : 'manage.saved', { count: 1 }),
        lifeMs: 4000,
      })
      onClose()
    } catch (error) {
      setBusy(false)
      setFailure(whyNot(error, t))
    }
  }

  const field = (key: string, label: string, control: ReactNode, note?: string) => (
    <div className="form-field" data-hc-field={key}>
      <label className="form-label" htmlFor={`hc-mcp-${key}`}>
        {label}
      </label>
      {control}
      {note ? <span className="form-note">{note}</span> : null}
    </div>
  )
  const input = (key: 'name' | 'command' | 'cwd' | 'url' | 'bearerTokenEnvVar', mono = true) => (
    <input
      id={`hc-mcp-${key}`}
      className={mono ? 'req-input mono' : 'req-input'}
      value={form[key]}
      disabled={busy}
      autoComplete="off"
      spellCheck={false}
      onChange={(event) => set({ [key]: event.target.value })}
    />
  )
  const area = (key: 'args' | 'headers') => (
    <textarea
      id={`hc-mcp-${key}`}
      className="req-input hc-area mono"
      rows={3}
      value={form[key]}
      disabled={busy}
      spellCheck={false}
      onChange={(event) => set({ [key]: event.target.value })}
    />
  )
  const setEnv = (index: number, patch: Partial<McpForm['env'][number]>) =>
    set({ env: form.env.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)) })

  return (
    <HcDialog
      title={server ? t('hc.mcp.edit', { name: server.name }) : t('hc.mcp.add')}
      kind="mcp"
      wide
      busy={busy}
      failure={failure ?? (!result.ok && form.name.trim() !== '' ? t(result.problem) : null)}
      yes={t('manage.save')}
      ready={result.ok && !wrong}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      {field('name', t('hc.mcp.name'), input('name'))}
      {data.transports.length > 1 ? (
        <div className="form-field">
          <span className="form-label">{t('hc.mcp.transport')}</span>
          {/* biome-ignore lint/a11y/useSemanticElements: 分段按钮，不用 fieldset */}
          <div className="seg" role="group" aria-label={t('hc.mcp.transport')}>
            {data.transports.map((one) => (
              <button
                key={one}
                type="button"
                data-transport={one}
                aria-pressed={form.transport === one}
                disabled={busy}
                onClick={() => set({ transport: one })}
              >
                {t(`hc.mcp.transport.${one}`)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {remote ? (
        <>
          {field('url', t('hc.mcp.url'), input('url'))}
          {field('headers', t('hc.mcp.headers'), area('headers'), t('hc.mcp.headers.note'))}
          {field(
            'bearerTokenEnvVar',
            t('hc.mcp.bearer'),
            input('bearerTokenEnvVar'),
            t('hc.mcp.bearer.note'),
          )}
        </>
      ) : (
        <>
          {field('command', t('hc.mcp.command'), input('command'))}
          {field('args', t('hc.mcp.args'), area('args'), t('hc.list.placeholder'))}
          {field('cwd', t('hc.mcp.cwd'), input('cwd'))}
        </>
      )}
      <div className="form-field" data-hc-field="env">
        <span className="form-label">{t('hc.mcp.env')}</span>
        {form.env.map((entry, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 一行环境变量没有别的稳定标识，名字也在改
          <div className="hc-env-row" key={index} data-hc-env={index}>
            <input
              className="req-input mono"
              aria-label={t('hc.mcp.env.name')}
              placeholder={t('hc.mcp.env.name')}
              value={entry.name}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setEnv(index, { name: event.target.value })}
            />
            <input
              className="req-input mono"
              type={entry.secret ? 'password' : 'text'}
              aria-label={t('hc.mcp.env.value')}
              placeholder={
                entry.kept && entry.secret ? t('hc.mcp.env.kept') : t('hc.mcp.env.value')
              }
              value={entry.value}
              disabled={busy}
              autoComplete={entry.secret ? 'new-password' : 'off'}
              spellCheck={false}
              onChange={(event) => setEnv(index, { value: event.target.value })}
            />
            <label className="hc-check">
              <input
                type="checkbox"
                checked={entry.secret}
                disabled={busy}
                onChange={(event) => setEnv(index, { secret: event.target.checked, kept: false })}
              />
              {t('hc.mcp.env.secret')}
            </label>
            <button
              type="button"
              className="mini"
              data-act="hc-env-remove"
              disabled={busy}
              onClick={() => set({ env: form.env.filter((_, at) => at !== index) })}
            >
              {t('hc.remove')}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="mini"
          data-act="hc-env-add"
          disabled={busy}
          onClick={() =>
            set({ env: [...form.env, { name: '', value: '', secret: false, kept: false }] })
          }
        >
          {t('hc.mcp.env.add')}
        </button>
      </div>
      {data.extraFields.map((spec) => {
        const draft = extra[spec.key]
        const parsed = draft ? parseDraft(spec, draft) : null
        const stored = form.extra[spec.key] as HcValue | undefined
        return (
          <div className="form-field" key={spec.key} data-hc-field={spec.key}>
            <label className="form-label" htmlFor={`hc-mcp-x-${spec.key}`}>
              {t.said(spec.title)}
            </label>
            <HcControl
              id={`hc-mcp-x-${spec.key}`}
              spec={spec}
              stored={stored}
              draft={draft}
              disabled={busy}
              wrong={parsed !== null && !parsed.ok}
              label={t.said(spec.title)}
              onDraft={(next) => setExtra((current) => ({ ...current, [spec.key]: next }))}
            />
            {spec.description ? (
              <span className="form-note">{t.said(spec.description)}</span>
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
