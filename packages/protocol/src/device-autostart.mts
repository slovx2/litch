// 系统自启独立于外部来源；变更被接受后，实际结果须在设备重连后读取。
export const DEVICE_AUTOSTART_EXTENSION = 'litchDeviceAutostart'
export const DEVICE_AUTOSTART_METHOD = {
  get: 'litch/device/autostart/get',
  enable: 'litch/device/autostart/enable',
  disable: 'litch/device/autostart/disable',
} as const
export const DEVICE_AUTOSTART_CHANGED = 'litch/device/autostart/changed'

export interface DeviceAutostartStatus {
  revision: number
  serviceManager: 'launchd' | 'systemd' | 'taskScheduler' | 'unsupported'
  state: 'disabled' | 'enabled' | 'degraded' | 'unsupported'
  serviceId?: string
  instance?: { pid: number; mode: 'managed' | 'manual' }
  requiresLogin: boolean
  linger: 'enabled' | 'disabled' | 'unavailable' | 'notApplicable'
  lastOperation?: {
    operationId: string
    action: 'enable' | 'disable'
    state: 'pending' | 'completed' | 'failed'
  }
  repair?: { code: string; text: { 'zh-CN': string; en: string } }
}

export interface DeviceAutostartDisableParams {
  operationId: string
  expectedRevision: number
  confirmStop?: boolean
  resumeAfterRestart?: boolean
}
export interface DeviceAutostartEnableParams extends DeviceAutostartDisableParams {
  takeover?: boolean
  allowLinger?: boolean
}
export type DeviceAutostartMutationResult =
  | { state: 'completed'; status: DeviceAutostartStatus }
  | { state: 'accepted'; operationId: string; reconnect: boolean }

export interface DeviceAutostartRequests {
  [DEVICE_AUTOSTART_METHOD.get]: {
    params: Record<string, never>
    result: DeviceAutostartStatus
  }
  [DEVICE_AUTOSTART_METHOD.enable]: {
    params: DeviceAutostartEnableParams
    result: DeviceAutostartMutationResult
  }
  [DEVICE_AUTOSTART_METHOD.disable]: {
    params: DeviceAutostartDisableParams
    result: DeviceAutostartMutationResult
  }
}
export interface DeviceAutostartChanged {
  revision: number
}

export function isDeviceAutostartMutationParams(
  method: typeof DEVICE_AUTOSTART_METHOD.enable | typeof DEVICE_AUTOSTART_METHOD.disable,
  value: unknown,
): value is DeviceAutostartEnableParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const p = value as Record<string, unknown>
  const flags =
    method === DEVICE_AUTOSTART_METHOD.enable
      ? ['confirmStop', 'resumeAfterRestart', 'takeover', 'allowLinger']
      : ['confirmStop', 'resumeAfterRestart']
  return (
    typeof p.operationId === 'string' &&
    p.operationId.length > 0 &&
    p.operationId.length <= 128 &&
    typeof p.expectedRevision === 'number' &&
    Number.isSafeInteger(p.expectedRevision) &&
    p.expectedRevision >= 0 &&
    Object.entries(p).every(
      ([key, val]) =>
        key === 'operationId' ||
        key === 'expectedRevision' ||
        (flags.includes(key) && typeof val === 'boolean'),
    )
  )
}
