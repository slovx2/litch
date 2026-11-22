// 经理设置里“空闲自动压缩”的草稿：桌面与手机共用的校验、脏状态和提交补丁。
import type { ManagerDraft, ManagerEdit, ManagerView } from '../../../core/src/model-manager.mts'
import {
  IDLE_COMPACT_MINUTES,
  IDLE_COMPACT_PERCENT,
  idleCompactInteger,
  type ManagerIdleCompactSettings,
} from '../../../protocol/src/manager-idle-compact.mts'

export interface IdleCompactDraft {
  enabled: boolean
  minutes: string
  percent: string
}

export interface IdleCompactCheck {
  minutesOk: boolean
  percentOk: boolean
  /** 可以提交的设置；开着且有越界值时为 null。 */
  value: ManagerIdleCompactSettings | null
  changed: boolean
}

export const idleCompactDraft = (saved: ManagerIdleCompactSettings): IdleCompactDraft => ({
  enabled: saved.enabled,
  minutes: String(saved.idleMinutes),
  percent: String(saved.contextPercent),
})

/** 关着时数值输入不可改，越界的草稿沿用已保存的值，不拦保存。 */
export function checkIdleCompact(
  draft: IdleCompactDraft,
  saved: ManagerIdleCompactSettings,
): IdleCompactCheck {
  const minutes = Number(draft.minutes)
  const percent = Number(draft.percent)
  const minutesValid =
    draft.minutes.trim() !== '' && idleCompactInteger(minutes, IDLE_COMPACT_MINUTES)
  const percentValid =
    draft.percent.trim() !== '' && idleCompactInteger(percent, IDLE_COMPACT_PERCENT)
  const minutesOk = minutesValid || !draft.enabled
  const percentOk = percentValid || !draft.enabled
  const value =
    minutesOk && percentOk
      ? {
          enabled: draft.enabled,
          idleMinutes: minutesValid ? minutes : saved.idleMinutes,
          contextPercent: percentValid ? percent : saved.contextPercent,
        }
      : null
  const changed =
    draft.enabled !== saved.enabled ||
    (value
      ? value.idleMinutes !== saved.idleMinutes || value.contextPercent !== saved.contextPercent
      : true)
  return { minutesOk, percentOk, value, changed }
}

type EditableFields = Pick<ManagerDraft, 'name' | 'rules' | 'dispatch' | 'contact'>

const settingsStamp = (fields: EditableFields) =>
  JSON.stringify([fields.name, fields.rules, fields.dispatch, fields.contact])

/**
 * 编辑保存的补丁。只改了空闲压缩时只发 idleCompact，设备不会把经理规则当作新改动再记一遍；
 * 其它情况照旧整份发送可编辑字段，压缩设置改了才附带。
 */
export function managerEditPatch(
  manager: Pick<ManagerView, keyof EditableFields>,
  form: EditableFields,
  idleCompact: ManagerIdleCompactSettings | null,
): ManagerEdit {
  const settingsChanged = settingsStamp(form) !== settingsStamp(manager)
  if (idleCompact && !settingsChanged) return { idleCompact }
  return {
    name: form.name,
    scope: '',
    rules: form.rules,
    dispatch: form.dispatch,
    contact: form.contact,
    ...(idleCompact ? { idleCompact } : {}),
  }
}
