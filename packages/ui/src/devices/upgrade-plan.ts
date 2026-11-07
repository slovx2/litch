import type { DeviceView } from '@litch/core'

export type UpgradeChoice = 'none' | 'idle' | 'force'

/** 只列当前能连上、需要换版本且应用能管理的服务。忙闲不由会话列表推断。 */
export function upgradeCandidate(device: DeviceView, version: string): boolean {
  if (device.connection !== 'online' || device.mode !== 'full') return false
  if (device.kind === 'local') {
    const up = device.upgrade
    return (
      up?.bundled.version === version &&
      up.action === 'kept' &&
      up.reason === 'busy' &&
      !device.restart?.autoUpgrade &&
      device.restart?.blocked === null &&
      !['stopping', 'starting'].includes(device.restart.phase.step)
    )
  }
  const up = device.remoteUpgrade
  return (
    !!up &&
    up.target === version &&
    up.capable &&
    !up.managed &&
    (up.action === 'swap' || up.method !== null) &&
    up.phase.step === 'idle'
  )
}

export function upgradeChoices(device: DeviceView): UpgradeChoice[] {
  const up = device.remoteUpgrade
  const force =
    device.kind === 'local' ||
    (device.connection === 'online' &&
      device.mode === 'full' &&
      up?.capable &&
      !up.managed &&
      up.action === 'swap' &&
      up.phase.step === 'idle')
  return force ? ['none', 'idle', 'force'] : ['none', 'idle']
}
