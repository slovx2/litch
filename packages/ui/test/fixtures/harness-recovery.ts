// 两端正式设备列表共用的隔离状态和重启应答，不连接真实设备。
import type { CoreChannel, DeviceView, HarnessView } from '@litch/core'

export const recoveryHarnesses: HarnessView[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    badge: 'CC',
    state: 'unavailable',
    down: 'starting',
    reason: '正在启动',
    detail: null,
  },
  {
    id: 'codex',
    name: 'Codex',
    badge: 'CX',
    state: 'unavailable',
    down: 'startFailed',
    reason: '启动失败',
    detail: {
      'zh-CN': '引擎启动超时：context deadline exceeded',
      en: 'Engine startup timed out: context deadline exceeded',
    },
  },
  {
    id: 'pi',
    name: 'Pi',
    badge: 'PI',
    state: 'unavailable',
    down: 'stopped',
    reason: '已停止',
    detail: null,
  },
] as HarnessView[]

export const recoveryDevice = (id: string, harnesses: HarnessView[]) =>
  ({
    id,
    name: id === 'local' ? '本机' : '隔离远程设备',
    connection: 'online',
    harnesses,
  }) as DeviceView

export function recoveryChannel(channel: CoreChannel, restored: (id: string) => void) {
  const calls: { name: string; params: { deviceId: string; harness: string; force?: boolean } }[] =
    []
  const original = channel.command.bind(channel)
  const wrapped = new Proxy(channel, {
    get(target, key) {
      if (key === 'command')
        return async (name: string, params: any) => {
          if (name !== 'device.harness.restart')
            return Reflect.apply(original, channel, [name, params])
          calls.push({ name, params })
          if (!params.force)
            throw Object.assign(new Error('隔离夹具：还有回合在跑'), { code: 'busy' })
          restored(params.harness)
          return { running: true, text: null }
        }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { channel: wrapped, calls }
}
