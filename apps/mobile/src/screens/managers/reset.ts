import type {
  ManagerResetPreview,
  ManagerResetSettings,
  ManagerResetTarget,
  ManagerView,
} from '@litch/core'
import { harnessIdentity } from '../../../../../packages/protocol/src/harness-identity.mts'
import { EFFORT_TEXT } from '../../../../../packages/ui/src/composer/efforts'
import type { Translator } from '../../ui/i18n'

/** 入口只排用户确认过的重置；摘要失败的再次确认才允许仅凭看板接手。 */
export function managerResetState(
  manager: Pick<ManagerView, 'harness' | 'status' | 'reset'>,
  online: boolean,
  sending = false,
) {
  const phase = manager.reset?.phase
  const busy = sending || ['waiting', 'summarizing', 'applying'].includes(phase ?? '')
  const boardOnly = phase === 'summaryFailed'
  const handoverFailed =
    manager.reset?.operation?.committed === true && manager.reset.operation.handover === 'failed'
  const replace = manager.reset
    ? manager.reset.mode === 'replace'
    : manager.harness !== 'claude-code'
  return {
    replace,
    handoverFailed,
    cancellable: phase === 'waiting' && manager.status === 'active',
    cancelDisabled: !online || sending,
    attention:
      manager.status === 'active' &&
      (manager.reset?.outdated === true || phase === 'failed' || boardOnly || handoverFailed),
    boardOnly,
    disabled:
      manager.status !== 'active'
        ? ('manager.readOnly' as const)
        : !online
          ? ('manager.offline' as const)
          : busy
            ? phase === 'waiting'
              ? replace
                ? ('manager.resetWaitingReplace' as const)
                : ('manager.resetWaiting' as const)
              : ('manager.resetApplying' as const)
            : null,
  }
}

export function resetSettingsLabel(settings: ManagerResetSettings, t: Translator): string {
  const name = t.harness(settings.harness, harnessIdentity(settings.harness)?.displayName)
  return [name, settings.model, settings.effort ? resetEffortLabel(settings.effort, t) : null]
    .filter(Boolean)
    .join(' · ')
}

export function resetEffortLabel(effort: string, t: Translator): string {
  return EFFORT_TEXT[effort] ? t(EFFORT_TEXT[effort]) : effort
}

export function resetPermissionLabel(permission: string | null, t: Translator): string {
  return permission === ':danger-full-access'
    ? t('permission.fullAccess')
    : permission === ':workspace'
      ? t('permission.workspace')
      : permission === ':read-only'
        ? t('permission.readOnly')
        : (permission ?? t('manager.resetPermissionUnknown'))
}

/** 只有设备确认的计划进入提交；失败重试始终沿用持久操作的目标。 */
export function resetTargetParams(
  manager: Pick<ManagerView, 'deviceId' | 'id' | 'reset'>,
  preview: ManagerResetPreview | null,
  requestId: string,
) {
  const operation = manager.reset?.phase === 'summaryFailed' ? manager.reset.operation : null
  const plan = operation ?? preview
  return {
    deviceId: manager.deviceId,
    managerId: manager.id,
    ...(operation ? { boardOnly: true } : {}),
    ...(plan
      ? {
          target: plan.target,
          expectedThreadId:
            'expectedThreadId' in plan ? plan.expectedThreadId : plan.source.threadId,
          expectedSettingsHash: plan.expectedSettingsHash,
          requestId: operation?.requestId ?? requestId,
        }
      : {}),
  }
}

export function resetNextTarget(
  preview: ManagerResetPreview,
  patch: Partial<ManagerResetTarget>,
): ManagerResetTarget {
  const target = { ...preview.target, ...patch }
  // 型号和强度属于目标目录，换引擎或型号后请设备重新解析默认值。
  if (patch.harness && patch.harness !== preview.target.harness) {
    target.model = null
    target.effort = null
  } else if ('model' in patch && patch.model !== preview.target.model) target.effort = null
  target.permission = preview.target.permission
  return target
}

export function resetPreviewDetail(preview: ManagerResetPreview, t: Translator): string {
  const value = (field: string, entry: string | null) =>
    field === 'harness' && entry
      ? resetSettingsLabel({ harness: entry, model: null, effort: null, permission: null }, t)
      : field === 'effort' && entry
        ? resetEffortLabel(entry, t)
        : (entry ?? t('manager.same'))
  return [
    `${t('manager.resetSource')}: ${resetSettingsLabel(preview.source, t)} →\n${t('manager.resetTarget')}: ${resetSettingsLabel(preview.target, t)}`,
    `${t('manager.resetPermission')}: ${resetPermissionLabel(preview.target.permission, t)}`,
    t(
      preview.target.harness === 'claude-code'
        ? 'manager.resetPermissionClaude'
        : 'manager.resetPermissionCodex',
    ),
    t('manager.resetFixed'),
    t(preview.mode === 'replace' ? 'manager.resetTargetReplace' : 'manager.resetRefresh'),
    t('manager.resetTargetNote'),
    ...preview.capabilityChanges
      .filter((change) => change.before !== change.after)
      .map(
        (change, i) =>
          `${i === 0 ? `${t('manager.resetCapabilities')}\n` : ''}${t(`manager.resetCapability.${change.capability}` as Parameters<Translator>[0])}: ${t(change.before ? 'manager.resetSupported' : 'manager.resetUnsupported')} → ${t(change.after ? 'manager.resetSupported' : 'manager.resetUnsupported')}`,
      ),
    ...(preview.dispatchChanges.length
      ? [
          t('manager.resetDispatchChanges'),
          ...preview.dispatchChanges.map(
            (change) =>
              `${t(change.field === 'harness' ? 'manager.lineHarness' : (`manager.${change.field}` as Parameters<Translator>[0]))}: ${value(change.field, change.before)} → ${value(change.field, change.after)}`,
          ),
          t('manager.resetDispatchNote'),
        ]
      : []),
  ].join('\n\n')
}
