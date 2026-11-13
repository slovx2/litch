import type {
  ManagerDispatchSettings,
  ManagerResetIssue,
  ManagerResetSettings,
  ManagerResetTarget,
} from '../../../core/src/model-manager.mts'
import { harnessIdentity } from '../../../protocol/src/harness-identity.mts'
import { EFFORT_TEXT } from '../composer/efforts.ts'
import type { MessageKey, Translator } from '../i18n/index.ts'

export const resetHarnessName = (id: string, t: Translator) =>
  t.harness(id, harnessIdentity(id)?.displayName)
export const resetEffortName = (id: string | null, t: Translator) =>
  id ? (EFFORT_TEXT[id] ? t(EFFORT_TEXT[id]) : id) : t('manager.resetNoEffort')
export function resetPermissionName(id: string | null, t: Translator): string {
  const keys: Record<string, MessageKey> = {
    ':read-only': 'permission.readOnly',
    ':workspace': 'permission.workspace',
    ':danger-full-access': 'permission.fullAccess',
  }
  return id ? (keys[id] ? t(keys[id]) : id) : t('manager.unknown')
}
export function resetIssueText(issue: ManagerResetIssue, t: Translator): string {
  if (issue.code === 'notValidated') return t('manager.resetNotValidated')
  if (issue.code === 'permissionMismatch' || issue.code === 'unsupportedPermission')
    return t('manager.resetPermissionMismatch')
  return issue.message
}
export function resetSettingsText(settings: ManagerResetSettings, t: Translator): string {
  return [
    resetHarnessName(settings.harness, t),
    settings.model ?? t('manager.default'),
    resetEffortName(settings.effort, t),
    resetPermissionName(settings.permission, t),
  ].join(' · ')
}
export function resetTargetChanged(
  source: ManagerResetSettings,
  target: ManagerResetTarget,
  dispatch: ManagerDispatchSettings,
): boolean {
  return (
    (['harness', 'model', 'effort', 'permission'] as const).some(
      (field) => source[field] !== target[field],
    ) ||
    Boolean(
      target.dispatch &&
        (['harness', 'model', 'effort', 'worktree', 'merge', 'maxRunningLines'] as const).some(
          (field) => target.dispatch?.[field] !== dispatch[field],
        ),
    )
  )
}
export const RESET_CAPABILITY_KEYS: Record<string, MessageKey> = {
  nativeBackground: 'manager.resetCapability.nativeBackground',
  backgroundWake: 'manager.resetCapability.backgroundWake',
  managerQuestions: 'manager.resetCapability.managerQuestions',
  steer: 'manager.resetCapability.steer',
  goals: 'manager.resetCapability.goals',
  nativeSubagents: 'manager.resetCapability.nativeSubagents',
  clientTools: 'manager.resetCapability.clientTools',
  resume: 'manager.resetCapability.resume',
  fork: 'manager.resetCapability.fork',
}
