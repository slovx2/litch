// 选择器只在用户打开后请求；设备没声明能力时保持手填，不放宽文件面板的范围。
import type { PathPickerListing } from '../../../protocol/src/path-picker.mjs'
import { type AbortSignalLike, ChannelError } from '../channel/protocol.mjs'
import { RpcError, type RpcRequestOptions } from '../connection/rpc.mjs'
import { managerValidationError } from './manager-validation.mjs'

interface Host {
  online(): boolean
  supported(): boolean
  request(params: { path: string | null }, options?: RpcRequestOptions): Promise<PathPickerListing>
  fail(error: unknown): ChannelError
}
const unavailable = () =>
  new ChannelError('unsupported', 'Device path picker is unavailable', undefined, {
    said: {
      'zh-CN': '设备服务版本较旧，不支持路径选择器。请手动填写路径，或在设备详情里升级设备服务。',
      en: 'This device service does not support the path picker. Enter the path manually or upgrade the device service in device details.',
    },
  })
export function createPathPicker(host: Host) {
  return {
    async list(path: string | null, signal?: AbortSignalLike): Promise<PathPickerListing> {
      if (!host.online())
        throw new ChannelError('offline', 'Device is offline', undefined, {
          said: {
            'zh-CN': '设备未连接，请连接后重试或手动填写路径。',
            en: 'Connect the device to browse, or enter the path manually.',
          },
        })
      if (!host.supported()) throw unavailable()
      try {
        return await host.request({ path }, signal ? { signal } : undefined)
      } catch (error) {
        if (error instanceof RpcError && error.code === -32601) throw unavailable()
        const data =
          error instanceof RpcError
            ? (error.data as {
                litch?: string
                reason?: string
                value?: string
                resolvedPath?: string
              } | null)
            : null
        if (data?.litch === 'invalidDirectory')
          throw managerValidationError(
            error instanceof Error ? error.message : String(error),
            'cwd',
            data.reason,
            data,
          )
        throw host.fail(error)
      }
    },
  }
}
