// 远程设备的连接配置：检查、显示用的主机标识，以及外壳要为远程设备提供的那几样能力。
// 核心不碰 ssh：怎么连、用户的 ssh 配置里有什么，都由外壳实现后注入（设计文档 01 第七节）。
import { type AbortSignalLike, ChannelError } from '../channel/protocol.mjs'
import type { TransportOpener } from '../connection/transport.mjs'
import type { DiscoveredHost, RemoteCheck, RemoteTarget, WireColor } from '../model.mjs'
import type { MachineAccessMode, MachineApproval, MachineLogEntry } from '../model-machine.mjs'
import type { SnapshotStore } from './device.mjs'
import type { TerminalNotesStore } from './terminal-launch.mjs'

/** 外壳提供的远程能力 */
export interface RemotePlatform {
  /** 给这份连接配置造一个“打开传输”的函数 */
  opener(target: RemoteTarget): TransportOpener
  /** 用户的 ssh 配置里有哪些主机 */
  discover(): Promise<DiscoveredHost[]>
  /** 连过去看一眼对面有什么，不启动任何东西 */
  check(target: RemoteTarget, signal: AbortSignalLike): Promise<RemoteCheck>
}

export interface SavedRemote {
  id: string
  name: string
  target: RemoteTarget
  wire: WireColor
}

/** 存下来的设备配置：客户端唯一的权威数据。里面没有密码，也没有密钥的内容 */
export interface SavedDevices {
  /** 本机设备改过的线色。没改过就是 null */
  localWire: WireColor | null
  remotes: SavedRemote[]
  /**
   * 各台设备（键是设备标识，本机是 local）改过的两个开关：内置浏览器、Computer Use（决 190）。
   * 没改过的不记，按默认来（浏览器开、Computer Use 关）；一个都没改过时没有这一项
   */
  tools?: Record<string, SavedToolSwitches>
  /**
   * 各台远程设备“操作这台电脑”的审批方式和访问范围（08 号设计 3.2、3.3；开关本身在 tools 的 machine 里）。
   * 没改过的不记，按默认来（每个会话确认一次、禁止常用敏感位置）
   */
  machine?: Record<string, SavedMachineSettings>
}

export interface SavedToolSwitches {
  browser?: boolean
  computer?: boolean
  /** 远程设备“操作这台电脑”，默认关。本机设备没有这一项 */
  machine?: boolean
}

export interface SavedMachineSettings {
  approval?: MachineApproval
  access?: MachineAccessMode
  /** 自定义的禁止位置。第一次切到 custom 时从内置名单抄一份 */
  custom?: string[]
}

/** 一台设备的操作记录存在哪（只在本机，08 号 3.4）。读回来的形状由核心认 */
export interface MachineLogStore {
  load(): unknown
  save(entries: readonly MachineLogEntry[]): void
}

/** 设备配置和各台设备的侧栏快照存在哪，由外壳定 */
export interface DeviceStore {
  load(): SavedDevices
  save(devices: SavedDevices): void
  /** 一台设备的侧栏快照 */
  snapshot(deviceId: string): SnapshotStore
  /** 一台设备上终端的两样记在这台电脑上的东西：改过的名字、留在设备上不看的。不实现就不记 */
  terminals?(deviceId: string): TerminalNotesStore
  /** 一台设备的 litch_machine 操作记录。不实现就只记在内存里 */
  machineLog?(deviceId: string): MachineLogStore
  /** 设备去掉了，或者换了一台机器：它的快照不要了 */
  forget(deviceId: string): void
}

export const WIRES: readonly WireColor[] = [
  'green',
  'orange',
  'blue',
  'violet',
  'yellow',
  'brown',
  'red',
  'slate',
]

const refuse = (message: string): never => {
  throw new ChannelError('rejected', message)
}

// 这些值会原样交给 ssh 当参数：不许以减号开头（会被当成选项），不许有空白和控制字符
const plain = (value: unknown, what: string, max = 255): string => {
  if (typeof value !== 'string') return refuse(`${what}要是一段字`)
  const text = value.trim()
  if (!text) return refuse(`${what}不能是空的`)
  if (text.length > max) return refuse(`${what}太长了`)
  if (text.startsWith('-') || /[\s\u0000-\u001f\u007f]/.test(text)) {
    return refuse(`${what}里不能有空白，也不能以减号开头`)
  }
  return text
}

/** 检查并整理一份连接配置。不合规矩的直接拒绝 */
export function checkTarget(value: unknown): RemoteTarget {
  if (typeof value !== 'object' || value === null) return refuse('连接配置不对')
  const raw = value as Record<string, unknown>
  if (raw.kind === 'alias') return { kind: 'alias', alias: plain(raw.alias, '别名') }
  if (raw.kind !== 'host') return refuse('连接配置不对')
  const host = plain(raw.host, '主机名')
  if (host.includes('@')) refuse('主机名里不要带用户名，用户名单独填')
  let port: number | null = null
  if (raw.port !== null && raw.port !== undefined && raw.port !== '') {
    port = Number(raw.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) refuse('端口要在 1 到 65535 之间')
  }
  const user = raw.user ? plain(raw.user, '用户名', 64) : null
  if (user && /[@:/]/.test(user)) refuse('用户名里不能有 @、冒号和斜杠')
  let keyFile: string | null = null
  if (raw.keyFile) {
    if (typeof raw.keyFile !== 'string') return refuse('密钥文件要给路径')
    keyFile = raw.keyFile.trim()
    // 路径里可以有空格，但不能有换行和控制字符，也不能让 ssh 当成选项
    if (!keyFile || keyFile.startsWith('-') || /[\u0000-\u001f\u007f]/.test(keyFile)) {
      refuse('密钥文件的路径不对')
    }
    if (keyFile.length > 1024) refuse('密钥文件的路径太长了')
  }
  return { kind: 'host', host, port, user, keyFile }
}

/** 给人看的主机标识 */
export function hostLabel(target: RemoteTarget): string {
  if (target.kind === 'alias') return target.alias
  const at = target.user ? `${target.user}@${target.host}` : target.host
  return target.port ? `${at}:${target.port}` : at
}

/** 没起名字时用什么名字 */
export const defaultName = (target: RemoteTarget): string =>
  target.kind === 'alias' ? target.alias : target.host

export function sameTarget(a: RemoteTarget, b: RemoteTarget): boolean {
  if (a.kind === 'alias') return b.kind === 'alias' && a.alias === b.alias
  return (
    b.kind === 'host' &&
    a.host === b.host &&
    a.port === b.port &&
    a.user === b.user &&
    a.keyFile === b.keyFile
  )
}

/** 检查存下来的那份设备配置。读回来的东西不合规矩的那一条丢掉，其余照用 */
export function checkSaved(value: unknown): SavedDevices {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const wireOf = (wire: unknown): WireColor | null =>
    WIRES.includes(wire as WireColor) ? (wire as WireColor) : null
  const remotes: SavedRemote[] = []
  for (const entry of Array.isArray(raw.remotes) ? raw.remotes : []) {
    try {
      const { id, name, target, wire } = entry as Record<string, unknown>
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || id === 'local') continue
      if (remotes.some((remote) => remote.id === id)) continue
      const checked = checkTarget(target)
      remotes.push({
        id,
        name: typeof name === 'string' && name.trim() ? name.trim() : defaultName(checked),
        target: checked,
        wire: wireOf(wire) ?? 'orange',
      })
    } catch {
      // 这一条读不懂，跳过
    }
  }
  const tools: Record<string, SavedToolSwitches> = {}
  const rawTools = raw.tools
  if (typeof rawTools === 'object' && rawTools !== null && !Array.isArray(rawTools)) {
    for (const [id, value] of Object.entries(rawTools as Record<string, unknown>)) {
      if (id !== 'local' && !remotes.some((remote) => remote.id === id)) continue
      if (typeof value !== 'object' || value === null) continue
      const { browser, computer, machine } = value as Record<string, unknown>
      const kept: SavedToolSwitches = {
        ...(typeof browser === 'boolean' ? { browser } : {}),
        ...(typeof computer === 'boolean' ? { computer } : {}),
        // 本机设备没有“操作这台电脑”
        ...(typeof machine === 'boolean' && id !== 'local' ? { machine } : {}),
      }
      if (Object.keys(kept).length > 0) tools[id] = kept
    }
  }
  const machine: Record<string, SavedMachineSettings> = {}
  const rawMachine = raw.machine
  if (typeof rawMachine === 'object' && rawMachine !== null && !Array.isArray(rawMachine)) {
    for (const [id, value] of Object.entries(rawMachine as Record<string, unknown>)) {
      if (!remotes.some((remote) => remote.id === id)) continue
      const kept = checkMachineSettings(value)
      if (Object.keys(kept).length > 0) machine[id] = kept
    }
  }
  return {
    localWire: wireOf(raw.localWire),
    remotes,
    ...(Object.keys(tools).length > 0 ? { tools } : {}),
    ...(Object.keys(machine).length > 0 ? { machine } : {}),
  }
}

const APPROVALS: readonly MachineApproval[] = ['session', 'each', 'never']
const ACCESS_MODES: readonly MachineAccessMode[] = ['sensitive', 'open', 'custom']
/** 自定义禁止位置最多几条、每条最长多少字 */
export const MACHINE_CUSTOM_LIMIT = 200
const MACHINE_PATH_MAX = 1024

/** 整理自定义的禁止位置：去掉空的、太长的、重复的，条数有上限 */
export function cleanDeniedPaths(list: readonly unknown[]): string[] {
  const kept: string[] = []
  for (const one of list) {
    if (typeof one !== 'string') continue
    const path = one.trim()
    if (!path || path.length > MACHINE_PATH_MAX || kept.includes(path)) continue
    kept.push(path)
    if (kept.length >= MACHINE_CUSTOM_LIMIT) break
  }
  return kept
}

function checkMachineSettings(value: unknown): SavedMachineSettings {
  if (typeof value !== 'object' || value === null) return {}
  const { approval, access, custom } = value as Record<string, unknown>
  return {
    ...(APPROVALS.includes(approval as MachineApproval)
      ? { approval: approval as MachineApproval }
      : {}),
    ...(ACCESS_MODES.includes(access as MachineAccessMode)
      ? { access: access as MachineAccessMode }
      : {}),
    ...(Array.isArray(custom) ? { custom: cleanDeniedPaths(custom) } : {}),
  }
}
