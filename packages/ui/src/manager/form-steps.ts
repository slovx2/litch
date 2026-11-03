// 新建时逐步校验；编辑时仅校验可修改的任务分配参数。
import { deviceDirectoryPath } from '../../../protocol/src/directory-validation.mts'
import { managerPositiveInteger } from '../../../protocol/src/manager-validation.mts'
export const MANAGER_FORM_STEPS = [
  { id: 'basic', label: 'manager.stepBasic' },
  { id: 'runtime', label: 'manager.stepRuntime' },
  { id: 'dispatch', label: 'manager.stepDispatch' },
] as const
export type ManagerFormStep = (typeof MANAGER_FORM_STEPS)[number]['id']

export function managerStepError(
  step: ManagerFormStep,
  input: { cwd: string; harnessReady: boolean; maxRunningLines: number },
):
  | 'manager.cwdRequired'
  | 'manager.cwdAbsolute'
  | 'manager.harnessRequired'
  | 'manager.updateRequired'
  | null {
  if (step === 'runtime') {
    if (!input.cwd.trim()) return 'manager.cwdRequired'
    if (!deviceDirectoryPath(input.cwd.trim())) return 'manager.cwdAbsolute'
    if (!input.harnessReady) return 'manager.harnessRequired'
  }
  if (step === 'dispatch' && !managerPositiveInteger(input.maxRunningLines))
    return 'manager.updateRequired'
  return null
}

/** 设备字段路径对应表单步骤；隐藏协议字段指向可重新填写的基本信息。 */
export function managerFieldStep(field: string): ManagerFormStep | null {
  if (['name', 'scope', 'rules', 'firstTask', 'template'].includes(field)) return 'basic'
  if (['cwd', 'harness', 'model', 'effort', 'permission'].includes(field)) return 'runtime'
  if (
    field === 'dispatch' ||
    field.startsWith('dispatch.') ||
    field === 'contact' ||
    field.startsWith('contact.')
  )
    return 'dispatch'
  return null
}

export function managerTabTarget(step: ManagerFormStep, key: string): ManagerFormStep | null {
  const index = MANAGER_FORM_STEPS.findIndex((entry) => entry.id === step)
  if (key === 'Home') return 'basic'
  if (key === 'End') return 'dispatch'
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null
  return MANAGER_FORM_STEPS[(index + (key === 'ArrowRight' ? 1 : 2)) % 3]?.id ?? null
}
