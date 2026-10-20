// 表单里“到点之后”那一块：每次新建会话（设备、项目或目录、harness、模型强度权限），
// 或者在已有的会话里接着发（设备、会话）。选择器和新建对话页、输入区底栏是同一套。
// 建好之后换不了的（哪一种、设备、harness、哪个会话）编辑时只显示不让改。
import {
  type DeviceView,
  keys,
  LOOSE,
  type SessionGroups,
  type SessionSummary,
  type WorkspaceView,
} from '@litch/core'
import { useT } from '../app/appearance.ts'
import { nameOf, wireStyle } from '../app/device.ts'
import { useKey, useKeys } from '../app/services.tsx'
import { Picker, type PickerOption } from '../composer/Picker.tsx'
import { SettingsBar, useComposeOptions } from '../composer/SettingsBar.tsx'
import type { FormProblems, TaskForm } from './form.ts'

interface TargetFieldsProps {
  form: TaskForm
  problems: FormProblems
  /** 设备那一头说目标哪里不对 */
  remote: string | null
  editing: boolean
  /** 能建定时任务的设备 */
  devices: DeviceView[]
  onChange(patch: Partial<TaskForm>): void
}

/** 换了设备：去处、harness、会话都要重新挑 */
export function placeOn(device: DeviceView | undefined): Partial<TaskForm> {
  const harness = device?.harnesses.find((entry) => entry.state === 'ready')
  return {
    deviceId: device?.id ?? '',
    harness: harness?.id ?? '',
    workspaceId: null,
    cwd: '',
    threadId: null,
    settings: { model: null, effort: null, permission: null },
  }
}

const EMPTY_GROUPS: SessionGroups = {}

/** 这台设备上能接着发的会话（侧栏里有的），按侧栏的顺序，同一个只列一次 */
function useSessions(deviceId: string): SessionSummary[] {
  const groups = useKey<SessionGroups>(keys.groups(deviceId)) ?? EMPTY_GROUPS
  const ids = [...new Set(Object.values(groups).flat())]
  const summaries = useKeys<SessionSummary>(ids.map((id) => keys.summary(deviceId, id)))
  return summaries.filter((entry) => entry !== undefined)
}

export function TargetFields({
  form,
  problems,
  remote,
  editing,
  devices,
  onChange,
}: TargetFieldsProps) {
  const t = useT()
  const device = useKey<DeviceView>(keys.device(form.deviceId))
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(form.deviceId)) ?? []
  const sessions = useSessions(form.deviceId)
  const options = useComposeOptions(form.deviceId, form.harness || undefined)
  const fixed = editing ? <span className="form-note">{t('tasks.form.fixed')}</span> : null

  const deviceOptions: PickerOption[] = devices.map((entry) => ({
    id: entry.id,
    title: t.text(entry.name),
    lead: <i className="wire-sq" style={wireStyle(entry.wire)} />,
    note: entry.host,
  }))
  const harnessOptions: PickerOption[] = (device?.harnesses ?? [])
    .filter((entry) => entry.state !== 'disabled')
    .map((entry) => ({
      id: entry.id,
      title: entry.name,
      ...(entry.state === 'ready' ? {} : { disabled: true }),
    }))
  const workspaceOptions: PickerOption[] = [
    ...workspaces.map((entry) => ({
      id: entry.id,
      title: entry.name,
      ...(entry.color ? { lead: <i className="ws-dot" style={wireStyle(entry.color)} /> } : {}),
      ...(entry.roots[0] ? { note: entry.roots[0] } : {}),
    })),
    { id: LOOSE, title: t('workspace.none') },
  ]
  const sessionOptions: PickerOption[] = sessions.map((entry) => ({
    id: entry.id,
    title: t.text(entry.title),
    note: nameOf(device, entry.harness),
  }))

  return (
    <>
      {editing ? (
        <div className="form-field">
          <span className="form-label">{t('tasks.form.target')}</span>
          <span>{t(form.target === 'thread' ? 'tasks.form.thread' : 'tasks.form.newThread')}</span>
          {fixed}
        </div>
      ) : (
        // biome-ignore lint/a11y/useSemanticElements: 这一组没有自己的边框和标题，不用 fieldset
        <div className="seg tk-seg" role="group" aria-label={t('tasks.form.target')}>
          <button
            type="button"
            data-target="newThread"
            aria-pressed={form.target === 'newThread'}
            onClick={() => onChange({ target: 'newThread', threadId: null })}
          >
            {t('tasks.form.newThread')}
          </button>
          <button
            type="button"
            data-target="thread"
            aria-pressed={form.target === 'thread'}
            onClick={() => onChange({ target: 'thread' })}
          >
            {t('tasks.form.thread')}
          </button>
        </div>
      )}
      <div className="tk-form-row">
        <div className="form-field">
          <span className="form-label">{t('tasks.form.device')}</span>
          {editing ? (
            <span>{device ? t.text(device.name) : form.deviceId}</span>
          ) : (
            <Picker
              kind="device"
              label={t('tasks.form.device')}
              value={form.deviceId || null}
              options={deviceOptions}
              onPick={(id) => onChange(placeOn(devices.find((entry) => entry.id === id)))}
            />
          )}
        </div>
        {form.target === 'newThread' ? (
          <div className="form-field">
            <span className="form-label">{t('tasks.form.harness')}</span>
            {editing ? (
              <span>{nameOf(device, form.harness)}</span>
            ) : harnessOptions.length > 0 ? (
              <Picker
                kind="harness"
                label={t('tasks.form.harness')}
                value={form.harness || null}
                options={harnessOptions}
                onPick={(harness) =>
                  onChange({ harness, settings: { model: null, effort: null, permission: null } })
                }
              />
            ) : (
              <span className="form-note err">{t('tasks.form.noHarness')}</span>
            )}
          </div>
        ) : null}
        {form.target === 'newThread' ? (
          <div className="form-field">
            <span className="form-label">{t('tasks.form.workspace')}</span>
            <Picker
              kind="workspace"
              label={t('tasks.form.workspace')}
              value={form.workspaceId ?? LOOSE}
              options={workspaceOptions}
              onPick={(id) => {
                const workspace = workspaces.find((entry) => entry.id === id)
                onChange({
                  workspaceId: workspace ? workspace.id : null,
                  cwd: workspace?.roots[0] ?? form.cwd,
                })
              }}
            />
          </div>
        ) : null}
      </div>
      {form.target === 'newThread' ? (
        <>
          <div className="form-field">
            <label className="form-label" htmlFor="tk-cwd">
              {t('tasks.form.cwd')}
            </label>
            <input
              id="tk-cwd"
              className={problems.cwd ? 'req-input mono wrong' : 'req-input mono'}
              value={form.cwd}
              placeholder={t('tasks.form.cwdPlaceholder')}
              aria-invalid={problems.cwd !== undefined}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => onChange({ cwd: event.target.value })}
            />
            {problems.cwd ? <span className="form-note err">{t(problems.cwd)}</span> : null}
          </div>
          {options ? (
            <div className="form-field">
              <span className="form-label">{t('tasks.form.settings')}</span>
              <div className="tk-settings">
                <SettingsBar
                  // 定时任务的设置里没有速度和计划模式：这两样不出选择器
                  options={{
                    ...options,
                    plan: false,
                    models: options.models.map((entry) => ({ ...entry, speeds: [] })),
                  }}
                  settings={{ ...form.settings, speed: null, mode: null }}
                  fresh
                  onChange={(patch) =>
                    onChange({
                      settings: {
                        model: patch.model !== undefined ? patch.model : form.settings.model,
                        effort: patch.effort !== undefined ? patch.effort : form.settings.effort,
                        permission:
                          patch.permission !== undefined
                            ? patch.permission
                            : form.settings.permission,
                      },
                    })
                  }
                />
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <div className="form-field">
          <span className="form-label">{t('tasks.form.session')}</span>
          {editing ? (
            <span>
              {t.text(
                sessions.find((entry) => entry.id === form.threadId)?.title ?? t('tasks.run.gone'),
              )}
            </span>
          ) : sessionOptions.length > 0 ? (
            <Picker
              kind="session"
              label={t('tasks.form.pickSession')}
              value={form.threadId}
              options={sessionOptions}
              search={t('tasks.form.pickSession')}
              onPick={(id) => {
                const session = sessions.find((entry) => entry.id === id)
                onChange({ threadId: id, harness: session?.harness ?? form.harness })
              }}
            />
          ) : (
            <span className="form-note">{t('tasks.form.noSessions')}</span>
          )}
          {problems.threadId ? <span className="form-note err">{t(problems.threadId)}</span> : null}
          {editing ? fixed : null}
        </div>
      )}
      {remote ? <div className="form-note err">{remote}</div> : null}
    </>
  )
}
