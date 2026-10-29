import { type DeviceView, keys, type WorkspaceView } from '@litch/core'
import { useState } from 'react'
import type { ManagerDraft, ManagerTemplate } from '../../../core/src/model-manager.mts'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
} from '../../../protocol/src/manager.mts'
import type { Selection } from '../app/App.tsx'
import type { ManagersRoute } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { nameOf } from '../app/device.ts'
import { reasonOf } from '../app/errors.ts'
import { useKey, useServices } from '../app/services.tsx'
import { EFFORT_TEXT } from '../composer/efforts.ts'
import { useComposeOptions } from '../composer/SettingsBar.tsx'
import { managerRules } from './rules.ts'

const templates = ['release', 'investigation', 'research', 'blank'] as const
const placeholders = {
  release: 'manager.scopeRelease',
  investigation: 'manager.scopeInvestigation',
  research: 'manager.scopeResearch',
  blank: 'manager.scopeBlank',
} as const

function remembered(deviceId: string) {
  try {
    return JSON.parse(localStorage.getItem(`litch.manager.defaults:${deviceId}`) ?? '{}') as {
      harness?: string
      model?: string | null
      effort?: string | null
    }
  } catch {
    return {}
  }
}
function lastTemplate(): ManagerTemplate {
  try {
    const value = localStorage.getItem('litch.manager.template')
    return templates.find((template) => template === value) ?? 'release'
  } catch {
    return 'release'
  }
}

export function ManagerForm({
  devices,
  initial,
  onCancel,
  onCreated,
}: {
  devices: DeviceView[]
  initial: Extract<ManagersRoute, { view: 'new' }>
  onCancel(): void
  onCreated(selection: Selection): void
}) {
  const t = useT()
  const { channel } = useServices()
  const [deviceId, setDeviceId] = useState(
    devices.find((entry) => entry.id === initial.deviceId)?.id ?? devices[0]?.id ?? '',
  )
  const device = devices.find((entry) => entry.id === deviceId)
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId)) ?? []
  const [workspaceId, setWorkspaceId] = useState(
    initial.deviceId === deviceId ? (initial.workspaceId ?? '') : '',
  )
  const workspace = workspaces.find((entry) => entry.id === workspaceId)
  const [form, setForm] = useState<ManagerDraft>(() => {
    const last = remembered(deviceId)
    return {
      name: '',
      scope: '',
      cwd: '',
      harness:
        device?.harnesses.find((entry) => entry.id === last.harness && entry.state === 'ready')
          ?.id ??
        device?.harnesses.find((entry) => entry.state === 'ready')?.id ??
        '',
      model: last.model ?? null,
      effort: last.effort ?? null,
      template: lastTemplate(),
      dispatch: { ...MANAGER_DEFAULT_DISPATCH },
      contact: { ...MANAGER_DEFAULT_CONTACT },
      rules: '',
      firstTask: '',
    }
  })
  const [edited, setEdited] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const options = useComposeOptions(deviceId, form.harness || undefined)
  const model = options?.models.find((entry) =>
    form.model ? entry.id === form.model : entry.isDefault,
  )
  const cwd = workspace?.roots[0] ?? form.cwd
  const rules = edited
    ? form.rules
    : managerRules(
        t,
        form.template,
        form.dispatch,
        form.contact,
        nameOf(device, form.dispatch.harness ?? form.harness),
      )
  const change = (patch: Partial<ManagerDraft>) => {
    setForm((was) => ({ ...was, ...patch }))
    setError('')
  }
  const save = async () => {
    if (busy) return
    if (
      !form.scope.trim() ||
      !cwd.trim() ||
      !device?.harnesses.some((entry) => entry.id === form.harness && entry.state === 'ready') ||
      !Number.isInteger(form.dispatch.maxRunningLines) ||
      form.dispatch.maxRunningLines < 1
    ) {
      setError(t('manager.required'))
      return
    }
    setBusy(true)
    try {
      const result = await channel.command('managers.create', {
        deviceId,
        manager: { ...form, scope: form.scope.trim(), cwd: cwd.trim(), rules },
      })
      // 创建已成功；偏好存储失败不能把它显示成创建失败，也不能重复创建。
      try {
        localStorage.setItem('litch.manager.template', form.template)
        localStorage.setItem(
          `litch.manager.defaults:${deviceId}`,
          JSON.stringify({ harness: form.harness, model: form.model, effort: form.effort }),
        )
      } catch {
        /* 偏好不影响设备上已经创建的经理。 */
      }
      onCreated({ deviceId, sessionId: result.threadId })
    } catch (cause) {
      setError(reasonOf(cause, t))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="mng-wrap mg-form"
      data-manager="form"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <fieldset className="mg-fields" disabled={busy}>
        <section className="mng-sec">
          <label className="form-field">
            {t('manager.template')}
            <select
              value={form.template}
              onChange={(event) => change({ template: event.target.value as ManagerTemplate })}
            >
              {templates.map((template) => (
                <option key={template} value={template}>
                  {t(`manager.${template}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            {t('manager.name')}
            <input
              className="req-input"
              value={form.name}
              placeholder={t('manager.optionalName')}
              onChange={(event) => change({ name: event.target.value })}
            />
          </label>
          <label className="form-field">
            {t('manager.scope')}
            <textarea
              required
              className="req-input"
              rows={3}
              value={form.scope}
              placeholder={t(placeholders[form.template])}
              onChange={(event) => change({ scope: event.target.value })}
            />
          </label>
        </section>
        <section className="mng-sec mg-form-grid">
          <label className="form-field">
            {t('manager.device')}
            <select
              value={deviceId}
              onChange={(event) => {
                const id = event.target.value
                const next = devices.find((entry) => entry.id === id)
                const last = remembered(id)
                setDeviceId(id)
                setWorkspaceId('')
                change({
                  cwd: '',
                  harness:
                    next?.harnesses.find(
                      (entry) => entry.state === 'ready' && entry.id === last.harness,
                    )?.id ??
                    next?.harnesses.find((entry) => entry.state === 'ready')?.id ??
                    '',
                  model: last.model ?? null,
                  effort: last.effort ?? null,
                })
              }}
            >
              {devices.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {t.text(entry.name)}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            {t('manager.workspace')}
            <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
              <option value="">{t('workspace.none')}</option>
              {workspaces.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            {t('manager.cwd')}
            <input
              className="req-input"
              required
              value={cwd}
              readOnly={Boolean(workspace)}
              onChange={(event) => change({ cwd: event.target.value })}
            />
          </label>
          <label className="form-field">
            {t('manager.harness')}
            <select
              value={form.harness}
              onChange={(event) =>
                change({ harness: event.target.value, model: null, effort: null })
              }
            >
              {device?.harnesses
                .filter((entry) => entry.state === 'ready')
                .map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="form-field">
            {t('manager.model')}
            <select
              value={form.model ?? ''}
              onChange={(event) => change({ model: event.target.value || null, effort: null })}
            >
              <option value="">{t('manager.default')}</option>
              {options?.models.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.title}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            {t('manager.effort')}
            <select
              value={form.effort ?? ''}
              onChange={(event) => change({ effort: event.target.value || null })}
            >
              <option value="">{t('manager.default')}</option>
              {model?.efforts.map((entry) => {
                const label = EFFORT_TEXT[entry.id]
                return (
                  <option key={entry.id} value={entry.id}>
                    {label ? t(label) : entry.id}
                  </option>
                )
              })}
            </select>
          </label>
        </section>
        <section className="mng-sec">
          <h2>{t('manager.dispatch')}</h2>
          <label className="form-field">
            {t('manager.lineHarness')}
            <select
              value={form.dispatch.harness ?? ''}
              onChange={(event) =>
                change({
                  dispatch: {
                    ...form.dispatch,
                    harness: event.target.value || null,
                    model: null,
                    effort: null,
                  },
                })
              }
            >
              <option value="">{t('manager.same')}</option>
              {device?.harnesses
                .filter((entry) => entry.state === 'ready')
                .map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="form-check">
            <input
              type="checkbox"
              checked={form.dispatch.worktree}
              onChange={(event) =>
                change({ dispatch: { ...form.dispatch, worktree: event.target.checked } })
              }
            />
            {t('manager.worktree')}
          </label>
          <label className="form-field">
            {t('manager.merge')}
            <select
              value={form.dispatch.merge}
              onChange={(event) =>
                change({
                  dispatch: { ...form.dispatch, merge: event.target.value as 'manager' | 'user' },
                })
              }
            >
              <option value="manager">{t('manager.mergeManager')}</option>
              <option value="user">{t('manager.mergeUser')}</option>
            </select>
          </label>
          <label className="form-field">
            {t('manager.max')}
            <input
              className="req-input"
              type="number"
              min={1}
              step={1}
              required
              value={form.dispatch.maxRunningLines}
              onChange={(event) =>
                change({
                  dispatch: { ...form.dispatch, maxRunningLines: Number(event.target.value) },
                })
              }
            />
          </label>
        </section>
        <section className="mng-sec">
          <h2>{t('manager.contact')}</h2>
          <label className="form-check">
            <input
              type="checkbox"
              checked={form.contact.desktopNotification}
              onChange={(event) =>
                change({ contact: { ...form.contact, desktopNotification: event.target.checked } })
              }
            />
            {t('manager.notify')}
          </label>
          <p className="dim">{t('manager.unanswered')}</p>
        </section>
        <label className="form-field">
          {t('manager.firstTask')}
          <textarea
            className="req-input"
            rows={3}
            value={form.firstTask}
            placeholder={t('manager.firstPlaceholder')}
            onChange={(event) => change({ firstTask: event.target.value })}
          />
        </label>
      </fieldset>
      <section className="mg-rules mng-sec">
        <div className="mg-rules-head">
          <h2>{t('manager.rules')}</h2>
          {!edited ? (
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                change({ rules })
                setEdited(true)
              }}
            >
              {t('manager.editRules')}
            </button>
          ) : null}
        </div>
        {edited ? <p className="form-note">{t('manager.rulesEdited')}</p> : null}
        <textarea
          aria-label={t('manager.rules')}
          className="req-input"
          value={rules}
          readOnly={!edited}
          disabled={busy}
          rows={20}
          onChange={(event) => change({ rules: event.target.value })}
        />
      </section>
      <footer className="tk-form-foot mg-form-foot">
        {error ? (
          <p className="err" role="alert">
            {error}
          </p>
        ) : null}
        <span className="grow" />
        <button type="button" className="btn ghost" disabled={busy} onClick={onCancel}>
          {t('manager.cancel')}
        </button>
        <button
          type="submit"
          className="btn primary"
          disabled={busy || !device}
          title={!device ? t('manager.noDevice') : undefined}
        >
          {t(busy ? 'manager.creating' : 'manager.create')}
        </button>
      </footer>
    </form>
  )
}
