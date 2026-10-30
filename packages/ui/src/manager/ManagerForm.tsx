import { type DeviceView, keys, type WorkspaceView } from '@litch/core'
import { useState } from 'react'
import type { ManagerDraft, ManagerView } from '../../../core/src/model-manager.mts'
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
import {
  MANAGER_FORM_STEPS,
  type ManagerFormStep,
  managerStepError,
  managerTabTarget,
} from './form-steps.ts'

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
export function ManagerForm({
  devices,
  initial,
  onCancel,
  onCreated,
  manager,
  disabled = false,
}: {
  devices: DeviceView[]
  initial: Extract<ManagersRoute, { view: 'new' }>
  onCancel(): void
  onCreated(selection: Selection): void
  manager?: ManagerView
  disabled?: boolean
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
  const [form, setForm] = useState<Omit<ManagerDraft, 'template' | 'scope'>>(() => {
    if (manager) return { ...manager, firstTask: '' }
    const last = remembered(deviceId)
    return {
      name: '',
      cwd: '',
      harness:
        device?.harnesses.find((entry) => entry.id === last.harness && entry.state === 'ready')
          ?.id ??
        device?.harnesses.find((entry) => entry.state === 'ready')?.id ??
        '',
      model: last.model ?? null,
      effort: last.effort ?? null,
      dispatch: { ...MANAGER_DEFAULT_DISPATCH },
      contact: { ...MANAGER_DEFAULT_CONTACT },
      rules: '',
      firstTask: '',
    }
  })
  const [step, setStep] = useState<ManagerFormStep>('basic')
  const stepIndex = MANAGER_FORM_STEPS.findIndex((entry) => entry.id === step)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const options = useComposeOptions(deviceId, form.harness || undefined)
  const lineOptions = useComposeOptions(deviceId, form.dispatch.harness ?? form.harness)
  const sameHarness = !form.dispatch.harness || form.dispatch.harness === form.harness
  const lineModel = lineOptions?.models.find((entry) =>
    form.dispatch.model
      ? entry.id === form.dispatch.model
      : !sameHarness
        ? entry.isDefault
        : form.model
          ? entry.id === form.model
          : entry.isDefault,
  )
  const model = options?.models.find((entry) =>
    form.model ? entry.id === form.model : entry.isDefault,
  )
  const cwd = workspace?.roots[0] ?? form.cwd
  const change = (patch: Partial<Omit<ManagerDraft, 'template' | 'scope'>>) => {
    setForm((was) => ({ ...was, ...patch }))
    setError('')
  }
  const save = async () => {
    if (busy || disabled) return
    const issue = managerStepError(manager ? 'dispatch' : step, {
      cwd,
      harnessReady: Boolean(
        device?.harnesses.some((entry) => entry.id === form.harness && entry.state === 'ready'),
      ),
      maxRunningLines: form.dispatch.maxRunningLines,
    })
    if (issue) {
      if (manager) setStep('dispatch')
      setError(t(issue))
      return
    }
    if (!manager && step !== 'dispatch') {
      setStep(step === 'basic' ? 'runtime' : 'dispatch')
      setError('')
      return
    }
    setBusy(true)
    try {
      if (manager) {
        await channel.command('managers.update', {
          deviceId,
          managerId: manager.id,
          patch: {
            name: form.name,
            scope: '',
            rules: form.rules,
            dispatch: form.dispatch,
            contact: form.contact,
          },
        })
        onCreated({ deviceId, sessionId: manager.threadId })
        return
      }
      // 保留已发布的 template 字段以维持协议形状；界面固定发送 blank。
      const result = await channel.command('managers.create', {
        deviceId,
        manager: { ...form, template: 'blank', scope: '', cwd: cwd.trim() },
      })
      // 创建已成功；偏好存储失败不能把它显示成创建失败，也不能重复创建。
      try {
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
      data-manager-mode={manager ? 'edit' : 'create'}
      data-manager-step={step}
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <nav
        className="mg-form-nav"
        role={manager ? 'tablist' : undefined}
        aria-label={t('manager.formSections')}
      >
        {MANAGER_FORM_STEPS.map((entry, index) => (
          <button
            key={entry.id}
            id={`manager-tab-${entry.id}`}
            data-form-tab={entry.id}
            type="button"
            {...(manager
              ? { role: 'tab', 'aria-selected': step === entry.id }
              : { 'aria-current': step === entry.id ? 'step' : undefined })}
            aria-controls={`manager-panel-${entry.id}`}
            tabIndex={manager && step !== entry.id ? -1 : 0}
            disabled={busy || (!manager && index > stepIndex)}
            title={!manager && index > stepIndex ? t('manager.stepUnavailable') : undefined}
            onClick={() => {
              setStep(entry.id)
              setError('')
            }}
            onKeyDown={(event) => {
              if (!manager || busy) return
              const next = managerTabTarget(step, event.key)
              if (!next) return
              event.preventDefault()
              setStep(next)
              setError('')
              event.currentTarget.parentElement
                ?.querySelector<HTMLButtonElement>(`[data-form-tab="${next}"]`)
                ?.focus()
            }}
          >
            {!manager ? <span className="mg-step-number">{index + 1}</span> : null}
            {t(entry.label)}
          </button>
        ))}
      </nav>
      <fieldset className="mg-fields" disabled={busy || disabled}>
        <section
          className="mng-sec mg-panel"
          id="manager-panel-basic"
          data-manager-panel="basic"
          hidden={step !== 'basic'}
          role={manager ? 'tabpanel' : undefined}
          aria-labelledby="manager-tab-basic"
        >
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
            {t('manager.prompt')}
            <textarea
              className="req-input"
              rows={3}
              value={form.rules}
              placeholder={t('manager.promptPlaceholder')}
              onChange={(event) => change({ rules: event.target.value })}
            />
          </label>
          {!manager ? (
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
          ) : null}
        </section>
        <section
          className="mng-sec mg-form-grid mg-panel"
          id="manager-panel-runtime"
          data-manager-panel="runtime"
          hidden={step !== 'runtime'}
          role={manager ? 'tabpanel' : undefined}
          aria-labelledby="manager-tab-runtime"
        >
          {manager ? (
            (
              [
                ['manager.device', device ? t.text(device.name) : manager.deviceId],
                ['manager.cwd', manager.cwd],
                ['manager.harness', nameOf(device, manager.harness)],
                ['manager.model', manager.model ?? t('manager.default')],
                ['manager.effort', manager.effort ?? t('manager.default')],
              ] as const
            ).map(([label, value]) => (
              <div className="form-field" key={label}>
                <span>{t(label)}</span>
                <span className="mg-fixed">{value}</span>
              </div>
            ))
          ) : (
            <>
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
                <select
                  value={workspaceId}
                  onChange={(event) => setWorkspaceId(event.target.value)}
                >
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
            </>
          )}
        </section>
        <section
          className="mg-panel"
          id="manager-panel-dispatch"
          data-manager-panel="dispatch"
          hidden={step !== 'dispatch'}
          role={manager ? 'tabpanel' : undefined}
          aria-labelledby="manager-tab-dispatch"
        >
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
            <label className="form-field">
              {t('manager.lineModel')}
              <select
                value={form.dispatch.model ?? ''}
                onChange={(event) =>
                  change({
                    dispatch: { ...form.dispatch, model: event.target.value || null, effort: null },
                  })
                }
              >
                <option value="">{t(sameHarness ? 'manager.same' : 'manager.default')}</option>
                {form.dispatch.model &&
                !lineOptions?.models.some((entry) => entry.id === form.dispatch.model) ? (
                  <option value={form.dispatch.model}>{form.dispatch.model}</option>
                ) : null}
                {lineOptions?.models.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-field">
              {t('manager.lineEffort')}
              <select
                value={form.dispatch.effort ?? ''}
                onChange={(event) =>
                  change({
                    dispatch: { ...form.dispatch, effort: event.target.value || null },
                  })
                }
              >
                <option value="">{t(sameHarness ? 'manager.same' : 'manager.default')}</option>
                {form.dispatch.effort &&
                !lineModel?.efforts.some((entry) => entry.id === form.dispatch.effort) ? (
                  <option value={form.dispatch.effort}>{form.dispatch.effort}</option>
                ) : null}
                {lineModel?.efforts.map((entry) => {
                  const label = EFFORT_TEXT[entry.id]
                  return (
                    <option key={entry.id} value={entry.id}>
                      {label ? t(label) : entry.id}
                    </option>
                  )
                })}
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
                  change({
                    contact: { ...form.contact, desktopNotification: event.target.checked },
                  })
                }
              />
              {t('manager.notify')}
            </label>
            <p className="dim">{t('manager.unanswered')}</p>
          </section>
        </section>
      </fieldset>
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
        {!manager && step !== 'basic' ? (
          <button
            type="button"
            className="btn ghost"
            data-act="manager-previous"
            disabled={busy}
            onClick={() => {
              setStep(step === 'dispatch' ? 'runtime' : 'basic')
              setError('')
            }}
          >
            {t('manager.previous')}
          </button>
        ) : null}
        <button
          type="submit"
          className="btn primary"
          disabled={busy || disabled}
          title={disabled ? t('manager.offline') : undefined}
        >
          {t(
            manager
              ? busy
                ? 'manager.saving'
                : 'manager.save'
              : step !== 'dispatch'
                ? 'manager.next'
                : busy
                  ? 'manager.creating'
                  : 'manager.create',
          )}
        </button>
      </footer>
    </form>
  )
}
