// 工具进程的入口：核心就住在这个进程里。主进程每给一个端口，就在上面开一条通道。
// 平台能力（定时器、端口、传输）在这里做成核心要的接口再交进去，核心自己不碰 Node 和 Electron。
import { execFileSync } from 'node:child_process'
import { arch, homedir, hostname, release, userInfo } from 'node:os'
import {
  type ClientToolPort,
  type Clock,
  type Core,
  createCore,
  createMockCore,
  type MockCore,
  type Port,
  phrase,
  serveChannel,
  type ToolToCore,
  type ToolToMain,
} from '@litch/core'
import type { MessagePortMain } from 'electron'
import { CLIENT_TOOL, type ClientToolToCore, type ClientToolToMain } from './client-tools/types.mjs'
import { fileDeviceStore } from './device-store.mjs'
import { ATTACH, LANGUAGE, TERMINALS } from './ipc.mjs'
import { type AdapterLang, localDevice, upgradeReport } from './local-adapter.mjs'
import { desktopPairing } from './pairing.mjs'
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

// ---------- 客户端工具：核心经这里和主进程说话 ----------
// 核心和外壳各有一份同形的消息类型（核心不认识 Electron）：这两个函数在编译时对一遍，两边改了形状这里过不去
const toMain = (message: ToolToMain): ClientToolToMain => message
const toCore = (message: ClientToolToCore): ToolToCore => message

/** 主进程报来的、这台桌面能执行的命名空间。还没报之前是空的 */
let toolNamespaces: string[] = []
/** 核心收主进程消息的那个函数 */
let toolInbox: ((message: ToolToCore) => void) | null = null
const toolPort: ClientToolPort = {
  namespaces: () => toolNamespaces,
  platform: () => process.platform,
  post: (message) => process.parentPort.postMessage(toMain(message)),
  listen(handler) {
    toolInbox = handler
  },
}

/** 跑一个很快的系统命令拿一行字；没有这个命令、出错都是空串 */
function quick(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
    }).trim()
  } catch {
    return ''
  }
}

/**
 * 这台桌面端自己的情况（litch_machine）：远程会话的说明开头写它、machines 工具列它、
 * 握手时报给设备进程。核心就住在这台电脑上，所以在这里现查，不绕本机设备服务
 */
function desktopFacts() {
  const user = userInfo()
  const host = hostname()
  const mac = process.platform === 'darwin'
  // 系统设置里“电脑名称”那一栏，比主机名好认
  const computerName = mac ? quick('scutil', ['--get', 'ComputerName']) : ''
  const version = mac ? quick('sw_vers', ['-productVersion']) : ''
  const system =
    process.platform === 'darwin'
      ? `macOS${version ? ` ${version}` : ''} ${arch()}`
      : process.platform === 'linux'
        ? `Linux ${arch()}`
        : process.platform === 'win32'
          ? `Windows ${release()} ${arch()}`
          : `${process.platform} ${arch()}`
  return {
    name: computerName || host,
    hostname: host,
    system,
    user: user.username,
    home: homedir(),
    shell: user.shell ?? process.env.SHELL ?? '',
  }
}

function createHost(): Core | MockCore {
  // LITCH_MOCK=1：不连任何设备，用示例数据。界面开发和不带入口的自检用
  // 示例数据用哪种语言由主进程定（LITCH_LANG），和界面的语言对上
  if (process.env.LITCH_MOCK === '1') {
    // 扫码绑定手机的码多久作废：自检里试“到期自动换码”时调短，平时和真的一样
    const pairTtlMs = Number(process.env.LITCH_MOCK_PAIR_TTL_MS)
    return createMockCore({
      clock,
      version,
      lang: process.env.LITCH_LANG === 'en' ? 'en' : 'zh-CN',
      ...(pairTtlMs > 0 ? { pairTtlMs } : {}),
    })
  }
  // 设备配置和侧栏快照放在用户数据目录里，目录由主进程告诉我们
  const dataDir = process.env.LITCH_DATA_DIR
  const desktop = desktopFacts()
  const core = createCore({
    clock,
    version,
    log: (line) => console.error(`[core] ${line}`),
    remote: { opener: sshOpener, discover: discoverHosts, check: checkRemote },
    clientTools: toolPort,
    // 操作这台电脑（litch_machine）的脚本只有 POSIX 的写法：Windows 的桌面端不提供，远程设备上就没有这个工具和开关
    ...(process.platform === 'win32' ? {} : { machine: { desktop } }),
    // 扫码绑定手机：一次性私钥的临时文件放在用户数据目录下；本机给手机看的名字用电脑名称
    pairing: desktopPairing({ dataDir, localName: () => desktop.name }),
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
  return core
}

const core = createHost()

/**
 * 真的核心等主进程报完能执行哪些命名空间再开始连设备：握手时要照它声明（客户端工具）。
 * 主进程一拉起工具进程就报，正常是立刻到；万一没到，过一会儿照样开始，只是这一次握手不声明
 */
let begun = false
const begin = () => {
  if (begun) return
  begun = true
  clearTimeout(waitTools)
  if ('start' in core) core.start()
}
const waitTools = setTimeout(begin, 3000)

process.parentPort.on('message', (event) => {
  if (event.data?.type === CLIENT_TOOL) {
    const message = toCore(event.data as ClientToolToCore)
    if (message.op === 'namespaces') {
      toolNamespaces = message.namespaces.filter((one) => typeof one === 'string')
      begin()
      return
    }
    toolInbox?.(message)
    return
  }
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
