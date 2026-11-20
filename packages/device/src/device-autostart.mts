import { readFileSync, unwatchFile, watchFile } from 'node:fs'
import { join } from 'node:path'
import {
  DEVICE_AUTOSTART_EXTENSION,
  DEVICE_AUTOSTART_METHOD,
  type DeviceAutostartChanged,
  type DeviceAutostartMutationResult,
  type DeviceAutostartStatus,
  isDeviceAutostartMutationParams,
} from '../../protocol/src/device-autostart.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import { type ControlChannel, ControlFailure } from './control.mjs'
import { DeviceError, isObject } from './wire.mjs'

export interface DeviceAutostartAccess {
  declared: boolean
  canRead: boolean
  canConfigure: boolean
}

export interface DeviceAutostartReply {
  result: DeviceAutostartStatus | DeviceAutostartMutationResult
  /** 只在承载这条 RPC 的连接把 result 交给系统后调用。 */
  afterReply?: () => void
}

export interface DeviceAutostartReadiness {
  state: 'ready' | 'notReady' | 'unverified'
  checkedAt: string
  status: DeviceAutostartStatus
  repair?: NonNullable<DeviceAutostartStatus['repair']>
}

const controlTimeoutMs = 75_000

/** H 线接设备与会话路由。设备配置授权由会话传进来，不能由扩展声明或请求参数替代。 */
export class DeviceAutostart {
  private readonly control: ControlChannel | null
  private readonly log: (line: string) => void

  constructor(control: ControlChannel | null, log: (line: string) => void) {
    this.control = control
    this.log = log
  }

  async call(
    method: string,
    params: unknown,
    access: DeviceAutostartAccess,
  ): Promise<DeviceAutostartReply> {
    if (!access.declared)
      throw new DeviceError(
        'extensionRequired',
        `${method} requires ${DEVICE_AUTOSTART_EXTENSION}`,
        {
          method,
          required: [DEVICE_AUTOSTART_EXTENSION],
        },
      )
    if (!this.control) throw new DeviceError('unsupported', 'System autostart is unavailable')
    if (!access.canRead || (method !== DEVICE_AUTOSTART_METHOD.get && !access.canConfigure))
      throw new ProtocolError(-32600, 'This connection cannot access device autostart')

    switch (method) {
      case DEVICE_AUTOSTART_METHOD.get: {
        if (params !== undefined && (!isObject(params) || Object.keys(params).length !== 0))
          throw new ProtocolError(-32602, 'Invalid autostart status parameters')
        const result = (await this.request(
          this.control,
          'autostart.get',
          {},
        )) as DeviceAutostartStatus
        return { result }
      }
      case DEVICE_AUTOSTART_METHOD.enable:
      case DEVICE_AUTOSTART_METHOD.disable: {
        if (!isDeviceAutostartMutationParams(method, params))
          throw new ProtocolError(-32602, 'Invalid autostart operation parameters')
        const control = this.control
        const action = method === DEVICE_AUTOSTART_METHOD.enable ? 'enable' : 'disable'
        const result = (await this.request(
          control,
          `autostart.${action}`,
          params,
        )) as DeviceAutostartMutationResult
        if (result.state !== 'accepted') return { result }
        return {
          result,
          afterReply: () => {
            void control
              .request('autostart.release', { operationId: result.operationId }, controlTimeoutMs)
              .catch(() => this.log('未收到设备服务的自启交接确认'))
          },
        }
      }
      default:
        throw new DeviceError('unsupported', 'Unknown autostart method', { method })
    }
  }

  async readiness(): Promise<DeviceAutostartReadiness | null> {
    if (!this.control) return null
    return (await this.request(this.control, 'autostart.readiness', {})) as DeviceAutostartReadiness
  }

  private async request(
    control: ControlChannel,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    try {
      return await control.request(method, params, controlTimeoutMs)
    } catch (error) {
      if (!(error instanceof ControlFailure)) throw error
      const code = error.detail.reason === 'invalid' ? -32602 : -32000
      throw Object.assign(new ProtocolError(code, error.message), { data: error.detail })
    }
  }

  /** 独立助手通过原子日志换版；只通知版本。调用方应按每条连接的声明和读权限投递。 */
  watch(stateDir: string, changed: (params: DeviceAutostartChanged) => void): () => void {
    if (!this.control) return () => {}
    const path = join(stateDir, 'autostart.json')
    const revision = (): number => {
      try {
        const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
        if (
          isObject(value) &&
          typeof value.revision === 'number' &&
          Number.isSafeInteger(value.revision)
        )
          return value.revision
      } catch {
        // 未配置自启时没有日志文件。
      }
      return 0
    }
    let last = revision()
    const listener = () => {
      const current = revision()
      if (current <= last) return
      last = current
      changed({ revision: current })
    }
    watchFile(path, { interval: 750, persistent: false }, listener)
    listener()
    return () => unwatchFile(path, listener)
  }
}
