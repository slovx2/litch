// 工具进程的入口：核心就住在这个进程里。主进程每给一个端口，就在上面开一条通道。
// 平台能力（定时器、端口、传输）在这里做成核心要的接口再交进去，核心自己不碰 Node 和 Electron。
import { hostname, userInfo } from 'node:os'
import {
  type Clock,
  type Core,
  createCore,
  createMockCore,
  type MockCore,
  type Port,
  phrase,
  serveChannel,
} from '@litch/core'
import type { MessagePortMain } from 'electron'
import { fileDeviceStore } from './device-store.mjs'
import { ATTACH, LANGUAGE, TERMINALS } from './ipc.mjs'
import { type AdapterLang, localDevice, upgradeReport } from './local-adapter.mjs'
import { discoverHosts } from './ssh/hosts.mjs'
import { checkRemote, sshOpener } from './transport-ssh.mjs'

const clock: Clock = {
  now: () => Date.now(),
  setTimer(callback, delayMs) {
    const handle = setTimeout(callback, delayMs)
    return () => clearTimeout(handle)
  },
}

function fromElectronPort(port: MessagePortMain): Port {
  return {
    post: (message) => port.postMessage(message),
    listen(handler) {
      port.on('message', (event) => handler(event.data))
      port.start()
    },
    close: () => port.close(),
  }
}

const version = process.env.LITCH_VERSION ?? '0.0.0'

/**
 * 本机的适配器用哪种语言说话（它的原话会显示在“详情”里）。跟界面的语言：界面起来之后经主进程报过来；
 * 还没报的时候用主进程按系统定的那个（LITCH_LANG），和应用菜单一开始的判断一致。
 */
let adapterLang: AdapterLang = process.env.LITCH_LANG === 'en' ? 'en' : 'zh-CN'

/**
 * 本机设备连到哪（见 local-adapter.mts）。平时就是应用自带的那份适配器：它在哪由主进程告诉我们
 * （LITCH_ADAPTER_ROOT），状态目录可以用 LITCH_ADAPTER_HOME 换成别处。
 * 设了 LITCH_ENTRY 就不管内置的，直接连那个套接字：适配器某个 harness 的，或者原生 codex 的。
 */
const local = localDevice({
  entry: process.env.LITCH_ENTRY,
  adapterRoot: process.env.LITCH_ADAPTER_ROOT,
  adapterHome: process.env.LITCH_ADAPTER_HOME,
  lang: () => adapterLang,
})

function createHost(): Core | MockCore {
  // LITCH_MOCK=1：不连任何设备，用示例数据。界面开发和不带入口的自检用
  // 示例数据用哪种语言由主进程定（LITCH_LANG），和界面的语言对上
  if (process.env.LITCH_MOCK === '1') {
    return createMockCore({
      clock,
      version,
      lang: process.env.LITCH_LANG === 'en' ? 'en' : 'zh-CN',
    })
  }
  // 设备配置和侧栏快照放在用户数据目录里，目录由主进程告诉我们
  const dataDir = process.env.LITCH_DATA_DIR
  const core = createCore({
    clock,
    version,
    log: (line) => console.error(`[core] ${line}`),
    remote: { opener: sshOpener, discover: discoverHosts, check: checkRemote },
    ...(dataDir ? { store: fileDeviceStore(dataDir) } : {}),
    devices: [
      {
        id: 'local',
        name: phrase('device.local'),
        host: `${userInfo().username}@${hostname()}`,
        kind: 'local',
        target: null,
        wire: 'green',
        open: local.open,
        // 每次连上之后核心来取：这一次打开时在跑的服务换没换成自带的、没换是因为什么
        upgrade: () => upgradeReport(local),
      },
    ],
  })
  core.start()
  return core
}

const core = createHost()

process.parentPort.on('message', (event) => {
  if (event.data?.type === TERMINALS) {
    // 退出应用之前主进程来问：还有几个终端活着，或者把它们都结束。答的只有个数
    const { id, op } = event.data as { id: number; op: string }
    const reply = () =>
      process.parentPort.postMessage({ type: TERMINALS, id, alive: core.terminalsAlive() })
    if (op === 'end') {
      core.endTerminals().then(reply, (error: unknown) => {
        console.error(`[core] 结束终端失败：${String(error)}`)
        reply()
      })
    } else reply()
    return
  }
  if (event.data?.type === LANGUAGE) {
    const { lang } = event.data
    if (lang === 'zh-CN' || lang === 'en') adapterLang = lang
    return
  }
  if (event.data?.type !== ATTACH) return
  const [port] = event.ports
  if (!port) return
  const stop = serveChannel(fromElectronPort(port), core, { clock })
  // 窗口关掉或者页面重新加载时，对面那头的端口会关闭：取消它的命令，退掉它的订阅
  port.on('close', stop)
})
