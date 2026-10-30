// 新建时逐步校验；编辑时仅校验可修改的任务分配参数。
export const MANAGER_FORM_STEPS = [
  { id: 'basic', label: 'manager.stepBasic' },
  { id: 'runtime', label: 'manager.stepRuntime' },
  { id: 'dispatch', label: 'manager.stepDispatch' },
] as const
export type ManagerFormStep = (typeof MANAGER_FORM_STEPS)[number]['id']

export function managerStepError(
  step: ManagerFormStep,
  input: { cwd: string; harnessReady: boolean; maxRunningLines: number },
): 'manager.environmentRequired' | 'manager.updateRequired' | null {
  if (step === 'runtime' && (!input.cwd.trim() || !input.harnessReady))
    return 'manager.environmentRequired'
  if (
    step === 'dispatch' &&
    (!Number.isSafeInteger(input.maxRunningLines) || input.maxRunningLines < 1)
  )
    return 'manager.updateRequired'
  return null
}

export function managerTabTarget(step: ManagerFormStep, key: string): ManagerFormStep | null {
  const index = MANAGER_FORM_STEPS.findIndex((entry) => entry.id === step)
  if (key === 'Home') return 'basic'
  if (key === 'End') return 'dispatch'
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null
  return MANAGER_FORM_STEPS[(index + (key === 'ArrowRight' ? 1 : 2)) % 3]?.id ?? null
}
