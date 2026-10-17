// 把核心装起来：和界面在同一个 JS 线程里，经一对内存端口相连（界面在浏览器里对着模拟核心时也是这样装的，
// packages/ui/src/boot/channel.ts）。核心不知道自己在手机上，传输、存储由这边注入。三种装法：
//   stored   正式用：设备配置存在手机上，远程设备经 SSH 连（src/platform/，连接线负责）
//   mock     模拟核心：不连任何设备，示例数据和假的流式回答。各条线在没有 SSH 的时候开发界面用
//   fixture  测试夹具：从电脑上的 apps/mobile/scripts/fixture.mjs --serve 取连接配置（经 adb reverse），
//            连夹具里真的适配器。跑分脚本（scripts/bench.mjs）和端到端验收用
import {
  type Clock,
  type CoreChannel,
  connectChannel,
  createCore,
  createMockCore,
  createPortPair,
  type DeviceConfig,
  serveChannel,
} from '@litch/core'
import { mobilePlatform } from '../platform'
import { type RemoteConfig, sshOpener } from '../platform/ssh-transport'

export type BootMode = 'stored' | 'mock' | 'fixture'

export interface Booted {
  mode: BootMode
  channel: CoreChannel
  /** fixture 时夹具给的新会话工作目录；别的装法是 null */
  work: string | null
  stop(): void
}

export const clock: Clock = {
  now: () => Date.now(),
  setTimer(callback, delayMs) {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
}

export const VERSION = '0.8.0'

/** fixture 装法里那台设备的标识 */
export const FIXTURE_DEVICE = 'fixture'
/** 夹具的配置从这个端口取（电脑上 fixture.mjs --serve 的端口经 adb reverse 映射到手机的这个端口） */
const FIXTURE_CONFIG_PORT = 8765

function serve(core: Parameters<typeof serveChannel>[1], start?: () => void, stop?: () => void) {
  const [uiPort, corePort] = createPortPair()
  const unserve = serveChannel(corePort, core, { clock })
  const channel = connectChannel(uiPort)
  start?.()
  return {
    channel,
    stop() {
      channel.close()
      unserve()
      stop?.()
    },
  }
}

const log = (line: string) => console.log(`[核心] ${line}`)

export async function boot(mode: BootMode, lang: 'zh-CN' | 'en'): Promise<Booted> {
  if (mode === 'mock') {
    const served = serve(createMockCore({ clock, version: VERSION, lang }))
    return { mode, work: null, ...served }
  }
  if (mode === 'fixture') {
    const config = await fetchFixtureConfig()
    const { target } = config
    const device: DeviceConfig = {
      id: FIXTURE_DEVICE,
      name: '测试夹具',
      host: `${target.host}:${target.port}`,
      kind: 'ssh',
      target: {
        kind: 'host',
        host: target.host,
        port: target.port,
        user: target.user,
        keyFile: null,
      },
      wire: 'orange',
      open: sshOpener(config),
    }
    const core = createCore({ clock, version: VERSION, devices: [device], log })
    const served = serve(
      core,
      () => core.start(),
      () => core.stop(),
    )
    return { mode, work: config.work ?? null, ...served }
  }
  const platform = mobilePlatform({ clock, version: VERSION })
  const core = createCore({
    clock,
    version: VERSION,
    devices: [],
    ...(platform.remote ? { remote: platform.remote } : {}),
    ...(platform.store ? { store: platform.store } : {}),
    log,
  })
  const served = serve(
    core,
    () => core.start(),
    () => core.stop(),
  )
  return { mode, work: null, ...served }
}

async function fetchFixtureConfig(): Promise<RemoteConfig> {
  const response = await fetch(`http://127.0.0.1:${FIXTURE_CONFIG_PORT}/config`)
  if (!response.ok) throw new Error(`取夹具的连接配置失败：${response.status}`)
  return (await response.json()) as RemoteConfig
}
