// 本机设备服务的电源申请状态。只给声明 devicePower 的连接，不代表内核保证合盖运行。
export const DEVICE_POWER_READ = 'litch/device/power/read'
export const DEVICE_POWER_CHANGED = 'litch/device/power/changed'

export interface DevicePowerStatus {
  supported: boolean
  configuredForLocalService: boolean
  state: 'inactive' | 'requested' | 'degraded' | 'unsupported'
  reasons: ('working' | 'pluggedIn')[]
  powerSource: 'ac' | 'battery' | 'unknown'
  working: number
  text: { 'zh-CN': string; en: string }
}
