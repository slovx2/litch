import type {
  ManagerDispatchSettings,
  ManagerResetPreview,
  ManagerResetTarget,
} from '../../../core/src/model-manager.mts'
import { useT } from '../app/appearance.ts'
import { useComposeOptions } from '../composer/SettingsBar.tsx'
import type { MessageKey } from '../i18n/index.ts'
import {
  RESET_CAPABILITY_KEYS,
  resetEffortName,
  resetHarnessName,
  resetIssueText,
  resetPermissionName,
  resetSettingsText,
} from './reset-target.ts'

/** 候选、默认值与变更结果均由设备预检返回；界面只发用户选择。 */
export function ResetTargetSettings({
  preview,
  dispatch,
  onChange,
  disabled,
}: {
  preview: ManagerResetPreview
  dispatch: ManagerDispatchSettings
  onChange(target: ManagerResetTarget): void
  disabled: boolean
}) {
  const t = useT()
  const target = preview.target
  const candidate = preview.candidates.find((one) => one.harness === target.harness)
  const model = candidate?.models.find((one) => one.id === target.model)
  const line = target.dispatch ?? dispatch
  const lineCandidate = preview.candidates.find(
    (one) => one.harness === (line.harness ?? target.harness),
  )
  const lineFollowsHarness = !line.harness || line.harness === target.harness
  const lineModel = lineCandidate?.models.find(
    (one) =>
      one.id === (line.model ?? (lineFollowsHarness ? target.model : lineCandidate.defaultModel)),
  )
  const changeLine = (patch: Partial<ManagerDispatchSettings>) =>
    onChange({ ...target, dispatch: { ...line, ...patch } })
  return (
    <details className="reset-target-settings">
      <summary>{t('manager.resetSettings')}</summary>
      <span>{t('manager.resetSettingsHint')}</span>
      <fieldset disabled={disabled}>
        <label>
          {t('manager.harness')}
          <select
            data-reset-field="harness"
            value={target.harness}
            onChange={(event) =>
              onChange({ ...target, harness: event.target.value, model: null, effort: null })
            }
          >
            {preview.candidates.map((one) => {
              const reasons = one.reasons.map((reason) => resetIssueText(reason, t))
              const enabled = one.enabled && one.permissions.includes(target.permission)
              if (!one.permissions.includes(target.permission))
                reasons.push(t('manager.resetPermissionMismatch'))
              return (
                <option key={one.harness} value={one.harness} disabled={!enabled}>
                  {resetHarnessName(one.harness, t)}
                  {reasons.length ? ` — ${reasons.join(' · ')}` : ''}
                </option>
              )
            })}
          </select>
        </label>
        <label>
          {t('manager.model')}
          <select
            data-reset-field="model"
            value={target.model ?? ''}
            onChange={(event) =>
              onChange({ ...target, model: event.target.value || null, effort: null })
            }
          >
            {!candidate?.models.some((one) => one.id === target.model) ? (
              <option value={target.model ?? ''}>{target.model ?? t('manager.default')}</option>
            ) : null}
            {candidate?.models.map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('manager.effort')}
          <select
            data-reset-field="effort"
            value={target.effort ?? ''}
            onChange={(event) => onChange({ ...target, effort: event.target.value || null })}
          >
            {!model?.efforts.includes(target.effort ?? '') ? (
              <option value={target.effort ?? ''}>{resetEffortName(target.effort, t)}</option>
            ) : null}
            {model?.efforts.map((effort) => (
              <option key={effort} value={effort}>
                {resetEffortName(effort, t)}
              </option>
            ))}
          </select>
        </label>
        <b>{t('manager.dispatch')}</b>
        <span>{t('manager.resetDispatchNote')}</span>
        <label>
          {t('manager.lineHarness')}
          <select
            data-reset-field="dispatch-harness"
            value={line.harness ?? ''}
            onChange={(event) => changeLine({ harness: event.target.value || null })}
          >
            <option value="">{t('manager.same')}</option>
            {preview.candidates.map((one) => (
              <option key={one.harness} value={one.harness} disabled={!one.enabled}>
                {resetHarnessName(one.harness, t)}
                {one.reasons.length
                  ? ` — ${one.reasons.map((reason) => resetIssueText(reason, t)).join(' · ')}`
                  : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('manager.model')}
          <select
            data-reset-field="dispatch-model"
            value={line.model ?? ''}
            onChange={(event) => changeLine({ model: event.target.value || null })}
          >
            <option value="">{t(lineFollowsHarness ? 'manager.same' : 'manager.default')}</option>
            {line.model && !lineCandidate?.models.some((one) => one.id === line.model) ? (
              <option value={line.model}>{line.model}</option>
            ) : null}
            {lineCandidate?.models.map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('manager.effort')}
          <select
            data-reset-field="dispatch-effort"
            value={line.effort ?? ''}
            onChange={(event) => changeLine({ effort: event.target.value || null })}
          >
            <option value="">
              {t(lineFollowsHarness && !line.model ? 'manager.same' : 'manager.default')}
            </option>
            {line.effort && !lineModel?.efforts.includes(line.effort) ? (
              <option value={line.effort}>{resetEffortName(line.effort, t)}</option>
            ) : null}
            {lineModel?.efforts.map((effort) => (
              <option key={effort} value={effort}>
                {resetEffortName(effort, t)}
              </option>
            ))}
          </select>
        </label>
      </fieldset>
    </details>
  )
}

function ResetPermissionDetail({
  deviceId,
  harness,
  permission,
}: {
  deviceId: string
  harness: string
  permission: string | null
}) {
  const t = useT()
  const options = useComposeOptions(deviceId, harness)
  const preset = options?.permissions.find((one) => one.id === permission)
  const keys: Record<string, MessageKey> = {
    ':read-only': 'permission.readOnly.note',
    ':workspace': 'permission.workspace.note',
    ':danger-full-access': 'permission.fullAccess.note',
  }
  const key = permission ? keys[permission] : undefined
  const note = preset?.note ? t.said(preset.note) : harness === 'codex' && key ? t(key) : null
  return (
    <span>
      {resetHarnessName(harness, t)}:{' '}
      {note ??
        t(
          harness === 'claude-code'
            ? 'manager.resetPermissionClaude'
            : 'manager.resetPermissionCodex',
        )}
    </span>
  )
}

export function ResetTargetPreview({
  preview,
  deviceId,
}: {
  preview: ManagerResetPreview
  deviceId: string
}) {
  const t = useT()
  const capabilityChanges = preview.capabilityChanges.filter(
    (change) => change.before !== change.after,
  )
  return (
    <div className="reset-target-preview">
      <b>{t('manager.resetSource')}</b>
      <span>{resetSettingsText(preview.source, t)}</span>
      <b>→ {t('manager.resetTarget')}</b>
      <span>{resetSettingsText(preview.target, t)}</span>
      <span>
        {t('manager.device')}: {deviceId}
      </span>
      <span>
        {t('manager.cwd')}: {preview.cwd}
      </span>
      <span>
        {t('manager.resetPermission')}: {resetPermissionName(preview.source.permission, t)}
      </span>
      <ResetPermissionDetail
        deviceId={deviceId}
        harness={preview.source.harness}
        permission={preview.source.permission}
      />
      {preview.source.harness !== preview.target.harness ? (
        <ResetPermissionDetail
          deviceId={deviceId}
          harness={preview.target.harness}
          permission={preview.target.permission}
        />
      ) : null}
      <span>{t('manager.resetFixed')}</span>
      {capabilityChanges.length ? (
        <>
          <b>{t('manager.resetCapabilities')}</b>
          <ul>
            {capabilityChanges.map((change) => {
              const key = RESET_CAPABILITY_KEYS[change.capability]
              return (
                <li key={change.capability}>
                  {key ? t(key) : change.capability}:{' '}
                  {t(change.before ? 'manager.resetSupported' : 'manager.resetUnsupported')} →{' '}
                  {t(change.after ? 'manager.resetSupported' : 'manager.resetUnsupported')}
                </li>
              )
            })}
          </ul>
        </>
      ) : null}
      {preview.dispatchChanges.length ? (
        <>
          <b>{t('manager.resetDispatchChanges')}</b>
          <ul>
            {preview.dispatchChanges.map((change) => (
              <li key={change.field}>
                {t(
                  change.field === 'harness'
                    ? 'manager.lineHarness'
                    : change.field === 'model'
                      ? 'manager.model'
                      : 'manager.effort',
                )}
                :{' '}
                {change.field === 'harness'
                  ? resetHarnessName(change.before ?? '', t)
                  : change.field === 'effort'
                    ? resetEffortName(change.before, t)
                    : (change.before ?? t('manager.default'))}{' '}
                →{' '}
                {change.field === 'harness'
                  ? resetHarnessName(change.after ?? '', t)
                  : change.field === 'effort'
                    ? resetEffortName(change.after, t)
                    : (change.after ?? t('manager.default'))}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {preview.reasons.map((reason) => (
        <span role="alert" key={`${reason.code}-${reason.field ?? ''}-${reason.message}`}>
          {resetIssueText(reason, t)}
        </span>
      ))}
      {preview.source.permission === null ? (
        <span role="alert">{t('manager.resetPermissionUnknown')}</span>
      ) : null}
    </div>
  )
}
