import type {
  ManagerContactSettings,
  ManagerDispatchSettings,
  ManagerTemplate,
} from '../../../core/src/model-manager.mts'
import { EFFORT_TEXT } from '../composer/efforts.ts'
import type { Translator } from '../i18n/index.ts'

/** 用户规矩的初稿跟随界面语言；手写后由表单保存原文，不再自动拼接。 */
export function managerRules(
  t: Translator,
  template: ManagerTemplate,
  dispatch: ManagerDispatchSettings,
  contact: ManagerContactSettings,
  harnessName: string,
): string {
  const effortKey = dispatch.effort ? EFFORT_TEXT[dispatch.effort] : undefined
  return [
    t('manager.rules.line', {
      harness: dispatch.harness ? harnessName : t('manager.rules.sameHarness'),
      model: dispatch.model ?? t('manager.rules.modelDefault'),
      effort: effortKey ? t(effortKey) : (dispatch.effort ?? t('manager.rules.effortDefault')),
    }),
    t(dispatch.worktree ? 'manager.rules.worktree' : 'manager.rules.sharedFolder'),
    t('manager.rules.limit', { n: dispatch.maxRunningLines }),
    t(dispatch.merge === 'manager' ? 'manager.rules.managerMerge' : 'manager.rules.userMerge'),
    t('manager.rules.wait'),
    t(contact.desktopNotification ? 'manager.rules.notify' : 'manager.rules.noNotify'),
    template === 'blank' ? '' : t(`manager.rules.${template}`),
  ]
    .filter(Boolean)
    .join('\n')
}
