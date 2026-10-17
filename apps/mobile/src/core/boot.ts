// 把核心装起来：和界面在同一个 JS 线程里，经一对内存端口相连（界面在浏览器里对着模拟核心时也是这样装的，
// packages/ui/src/boot/channel.ts）。核心不知道自己在手机上，传输由这边注入。
import {
  type Clock,
  type CoreChannel,
  connectChannel,
  createCore,
  createPortPair,
  serveChannel,
} from '../../../../packages/core/src/index.mts'
import { type RemoteConfig, sshOpener } from './transport'

export const DEVICE_ID = 'remote'

export interface Booted {
  channel: CoreChannel
  stop(): void
}

const clock: Clock = {
  now: () => Date.now(),
  setTimer(callback, delayMs) {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
}

export function bootCore(config: RemoteConfig): Booted {
  const { target } = config
  const core = createCore({
    clock,
    version: '0.0.0-proto',
    devices: [
      {
        id: DEVICE_ID,
        name: '测试机',
        host: `${target.host}:${target.port}`,
        kind: 'ssh',
        target: { kind: 'host', host: target.host, port: target.port, user: target.user, keyFile: null },
        wire: 'orange',
        open: sshOpener(config),
      },
    ],
    log: (line) => console.log(`[核心] ${line}`),
  })
  const [uiPort, corePort] = createPortPair()
  const unserve = serveChannel(corePort, core, { clock })
  const channel = connectChannel(uiPort)
  core.start()
  return {
    channel,
    stop() {
      channel.close()
      unserve()
      core.stop()
    },
  }
}

/** 开发时的连接配置：apps/mobile/scripts/fixture.mjs --serve 给的，经 adb reverse 映射进来 */
export async function fetchDevConfig(port: number): Promise<RemoteConfig> {
  const response = await fetch(`http://127.0.0.1:${port}/config`)
  if (!response.ok) throw new Error(`取连接配置失败：${response.status}`)
  const config = (await response.json()) as RemoteConfig
  return config
}
