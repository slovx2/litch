import { type DeviceView, keys, projectPermissionChoice, type WorkspaceView } from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import type { ManagerDraft, ManagerView } from '../../../core/src/model-manager.mts'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
} from '../../../protocol/src/manager.mts'
import { managerSelectionIssue } from '../../../protocol/src/manager-validation.mts'
import type { Selection } from '../app/App.tsx'
import type { ManagersRoute } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { nameOf } from '../app/device.ts'
import { reasonOf } from '../app/errors.ts'
import { useKey, useServices } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'
import { EFFORT_TEXT } from '../composer/efforts.ts'
import { useProjectPermission } from '../composer/project-permission.ts'
import { SettingsBar, useComposeOptions, useNewSessionDefaults } from '../composer/SettingsBar.tsx'
import { PathPicker } from '../path-picker/PathPicker.tsx'
import {
  MANAGER_FORM_STEPS,
  type ManagerFormStep,
  managerFieldStep,
  managerStepError,
  managerTabTarget,
} from './form-steps.ts'
import {
  fitManagerHarness,
  fitManagerModels,
  type ManagerFormDraft,
  managerDevice,
  managerWorkspace,
  recallManager,
  rememberManager,
} from './remembered.ts'

function emptyDraft(): ManagerFormDraft {
  return {
    name: '',
    cwd: '',
    harness: '',
    model: null,
    effort: null,
    dispatch: { ...MANAGER_DEFAULT_DISPATCH },
    contact: { ...MANAGER_DEFAULT_CONTACT },
    rules: '',
    firstTask: '',
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
  const [deviceId, setDeviceId] = useState(() => managerDevice(devices, initial.deviceId))
  const device = devices.find((entry) => entry.id === deviceId)
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId)) ?? []
  const [workspaceId, setWorkspaceId] = useState(() => managerWorkspace(deviceId, initial))
  const workspace = workspaces.find((entry) => entry.id === workspaceId)
  const [draft, setForm] = useState<ManagerFormDraft>(() => {
    if (manager) return { ...manager, firstTask: '' }
    return recallManager(device, emptyDraft())
  })
  const [step, setStep] = useState<ManagerFormStep>('basic')
  const stepIndex = MANAGER_FORM_STEPS.findIndex((entry) => entry.id === step)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [errorField, setErrorField] = useState('')
  const formRef = useRef<HTMLFormElement>(null)
  const showError = (message: string, field = '') => {
    setError(message)
    setErrorField(field)
    const targetStep = managerFieldStep(field)
    if (targetStep) setStep(targetStep)
  }
  useEffect(() => {
    if (!error || busy || !errorField) return
    const exact = [
      ...(formRef.current?.querySelectorAll<HTMLElement>('[data-manager-field]') ?? []),
    ].find((entry) => entry.dataset.managerField === errorField)
    const target =
      exact ?? formRef.current?.querySelector<HTMLElement>(`[data-manager-panel="${step}"]`)
    const control = target?.matches('input, select, textarea')
      ? target
      : target?.querySelector<HTMLElement>('input, select, textarea, button')
    // 项目目录只读时，定位到项目选择，让用户可以更换目录来源。
    const focus =
      control instanceof HTMLInputElement && control.readOnly
        ? formRef.current?.querySelector<HTMLElement>('[data-manager-workspace]')
        : (control ?? target)
    focus?.focus()
    target?.scrollIntoView({ block: 'nearest' })
  }, [error, errorField, busy, step])
  const fieldProps = (field: string) => ({
    'data-manager-field': field,
    'aria-invalid': error && errorField === field ? true : undefined,
    'aria-describedby': error && errorField === field ? 'manager-form-error' : undefined,
  })
  const environment = manager ? draft : fitManagerHarness(draft, device)
  const options = useComposeOptions(deviceId, environment.harness || undefined)
  const lineOptions = useComposeOptions(
    deviceId,
    environment.dispatch.harness ?? environment.harness,
  )
  const form = manager ? draft : fitManagerModels(environment, options, lineOptions)
  const optionsLoading = !manager && (!options || !lineOptions)
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
  const project = useProjectPermission(useServices(), deviceId, cwd.trim(), form.harness, options)
  const defaults = useNewSessionDefaults(deviceId, form.harness, cwd || null)
  const { permission: rememberedPermission, fallback: permissionFallback } =
    projectPermissionChoice(project.permission, options)
  const permission = rememberedPermission ?? defaults?.permission ?? null
  const change = (patch: Partial<Omit<ManagerDraft, 'template' | 'scope'>>) => {
    setForm((was) => ({ ...was, ...patch }))
    setError('')
  }
  const save = async () => {
    if (busy || disabled || (step === 'dispatch' && optionsLoading)) return
    const issue = managerStepError(manager ? 'dispatch' : step, {
      cwd,
      harnessReady: Boolean(
        device?.harnesses.some((entry) => entry.id === form.harness && entry.state === 'ready'),
      ),
      maxRunningLines: form.dispatch.maxRunningLines,
    })
    if (issue) {
      showError(
        t(issue),
        issue === 'manager.updateRequired'
          ? 'dispatch.maxRunningLines'
          : issue === 'manager.harnessRequired'
            ? 'harness'
            : 'cwd',
      )
      return
    }
    if (step !== 'basic') {
      const harness = step === 'runtime' ? form.harness : (form.dispatch.harness ?? form.harness)
      if (!device?.harnesses.some((entry) => entry.id === harness && entry.state === 'ready')) {
        showError(t('manager.harnessRequired'), step === 'runtime' ? 'harness' : 'dispatch.harness')
        return
      }
      const catalog = step === 'runtime' ? options : lineOptions
      const model =
        step === 'runtime' ? form.model : (form.dispatch.model ?? (sameHarness ? form.model : null))
      const effort = step === 'runtime' ? form.effort : form.dispatch.effort
      const prefix = step === 'runtime' ? '' : 'dispatch.'
      if (!catalog) {
        showError(t('manager.optionsLoading'), `${prefix}model`)
        return
      }
      const selected = managerSelectionIssue(
        catalog.models.map((entry) => ({ ...entry, efforts: entry.efforts.map((one) => one.id) })),
        model,
        effort,
        prefix,
      )
      if (selected) {
        showError(
          t(
            selected.reason === 'unavailableModel'
              ? 'manager.invalidModel'
              : 'manager.invalidEffort',
          ),
          selected.field,
        )
        return
      }
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
        onCreated({ deviceId, sessionId: manager.threadId, managerId: manager.id })
        return
      }
      // 保留已发布的 template 字段以维持协议形状；界面固定发送 blank。
      const notice = await project.persist(permission)
      if (notice) showToast({ id: 'permission-memory', text: () => notice, lifeMs: 8000 })
      const result = await channel.command('managers.create', {
        deviceId,
        manager: { ...form, permission, template: 'blank', scope: '', cwd: cwd.trim() },
      })
      rememberManager(deviceId, workspace?.id ?? '', { ...form, cwd: cwd.trim() })
      onCreated({ deviceId, sessionId: result.threadId, managerId: result.manager.id })
    } catch (cause) {
      showError(
        reasonOf(cause, t),
        typeof (cause as { key?: unknown })?.key === 'string' ? (cause as { key: string }).key : '',
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      ref={formRef}
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
          tabIndex={-1}
          hidden={step !== 'basic'}
          role={manager ? 'tabpanel' : undefined}
          aria-labelledby="manager-tab-basic"
        >
          <label className="form-field">
            {t('manager.name')}
            <input
              className="req-input"
              {...fieldProps('name')}
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
              {...fieldProps('rules')}
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
                {...fieldProps('firstTask')}
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
          tabIndex={-1}
          hidden={step !== 'runtime'}
          role={manager ? 'tabpanel' : undefined}
          aria-labelledby="manager-tab-runtime"
        >
          {manager ? (
            (
              [
                ['manager.device', device ? t.text(device.name) : manager.deviceId],
                ['manager.cwd', manager.cwd],
                ['manager.harness', nameOf(device, manager.harness, t)],
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
                    setDeviceId(id)
                    setWorkspaceId(managerWorkspace(id))
                    const last = recallManager(next, emptyDraft())
                    // 换设备只换运行参数，保留前一步已经写好的内容和通知选择。
                    change({
                      cwd: last.cwd,
                      harness: last.harness,
                      model: last.model,
                      effort: last.effort,
                      dispatch: last.dispatch,
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
                  data-manager-workspace
                  value={workspace?.id ?? ''}
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
                <span className="ws-pathrow">
                  <input
                    className="req-input"
                    required
                    {...fieldProps('cwd')}
                    value={cwd}
                    readOnly={Boolean(workspace)}
                    onChange={(event) => change({ cwd: event.target.value })}
                  />
                  <PathPicker
                    deviceId={deviceId}
                    value={cwd}
                    kind="directory"
                    onPick={(path) => {
                      setWorkspaceId('')
                      change({ cwd: path })
                    }}
                  />
                </span>
                {project.notice ? (
                  <span className="form-note" role="status">
                    {project.notice}
                  </span>
                ) : project.loading ? (
                  <span className="form-note">{t('permission.project.loading')}</span>
                ) : project.view?.record ? (
                  <span className="form-note">
                    {t('manager.resolvedDirectory', { path: project.view.record.cwd })}
                  </span>
                ) : null}
              </label>
              <label className="form-field">
                {t('manager.harness')}
                <select
                  {...fieldProps('harness')}
                  value={form.harness}
                  onChange={(event) =>
                    change({ harness: event.target.value, model: null, effort: null })
                  }
                >
                  {device?.harnesses
                    .filter((entry) => entry.state === 'ready')
                    .map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {t.harness(entry.id, entry.name)}
                      </option>
                    ))}
                </select>
              </label>
              <label className="form-field">
                {t('manager.model')}
                <select
                  {...fieldProps('model')}
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
              <div className="form-field" {...fieldProps('permission')}>
                <span>{t('composer.permission')}</span>
                <SettingsBar
                  projectPermission={project}
                  deviceId={deviceId}
                  harness={form.harness}
                  cwd={cwd}
                  fresh
                  options={options ? { ...options, models: [], plan: false } : null}
                  settings={{ model: null, effort: null, speed: null, mode: null, permission }}
                  onChange={() => {}}
                />
                {permissionFallback ? (
                  <span role="status">{t('permission.project.fallback')}</span>
                ) : null}
              </div>
              <label className="form-field">
                {t('manager.effort')}
                <select
                  {...fieldProps('effort')}
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
          tabIndex={-1}
          hidden={step !== 'dispatch'}
          role={manager ? 'tabpanel' : undefined}
          aria-labelledby="manager-tab-dispatch"
        >
          <section className="mng-sec">
            <h2>{t('manager.dispatch')}</h2>
            <label className="form-field">
              {t('manager.lineHarness')}
              <select
                {...fieldProps('dispatch.harness')}
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
                      {t.harness(entry.id, entry.name)}
                    </option>
                  ))}
              </select>
            </label>
            <label className="form-field">
              {t('manager.lineModel')}
              <select
                {...fieldProps('dispatch.model')}
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
                {...fieldProps('dispatch.effort')}
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
                {...fieldProps('dispatch.worktree')}
                checked={form.dispatch.worktree}
                aria-describedby="manager-worktree-note"
                onChange={(event) =>
                  change({ dispatch: { ...form.dispatch, worktree: event.target.checked } })
                }
              />
              <span>
                {t('manager.worktree')}
                <br />
                <small id="manager-worktree-note" className="form-note">
                  {t('manager.worktreeNote')}
                </small>
              </span>
            </label>
            <label className="form-field">
              {t('manager.merge')}
              <select
                {...fieldProps('dispatch.merge')}
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
                {...fieldProps('dispatch.maxRunningLines')}
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
                {...fieldProps('contact.desktopNotification')}
                checked={form.contact.desktopNotification}
                onChange={(event) =>
                  change({
                    contact: { ...form.contact, desktopNotification: event.target.checked },
                  })
                }
              />
              {t('manager.notify')}
            </label>
            <p className="dim" tabIndex={-1} {...fieldProps('contact.unanswered')}>
              {t('manager.unanswered')}
            </p>
          </section>
        </section>
      </fieldset>
      <footer className="tk-form-foot mg-form-foot">
        {error ? (
          <p className="err" role="alert" id="manager-form-error">
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
          disabled={busy || disabled || (!manager && step === 'dispatch' && optionsLoading)}
          title={
            disabled
              ? t('manager.offline')
              : optionsLoading
                ? t('manager.optionsLoading')
                : undefined
          }
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
