// 任务卡、offer 卡、派子会话弹窗上的“新工作树”勾选：勾上子会话有自己的工作树和分支，不勾共用当前目录。
// 设备不能建工作树（没有 git、旧设备服务）时不出。初值照设备算的缺省（父会话在工作树里就勾上）或模型定的
import { type DeviceView, keys } from '@litch/core'
import { useT } from '../app/appearance.ts'
import { useKey } from '../app/services.tsx'

export function WorktreeCheck({
  deviceId,
  checked,
  disabled,
  onChange,
}: {
  deviceId: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  const t = useT()
  const device = useKey<DeviceView>(keys.device(deviceId))
  if (!device?.worktrees) return null
  return (
    <label className="wt-check" title={t('worktree.check.hint')}>
      <input
        type="checkbox"
        data-act="worktree"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {t('worktree.check')}
    </label>
  )
}

/** 设备能不能建工作树：能的话卡片上的开关算数，按钮把它带上 */
export const useWorktreesOn = (deviceId: string): boolean =>
  useKey<DeviceView>(keys.device(deviceId))?.worktrees === true
