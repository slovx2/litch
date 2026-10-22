// 远程设备的连接配置：检查、显示用的主机标识，以及外壳要为远程设备提供的那几样能力。
// 核心不碰 ssh：怎么连、用户的 ssh 配置里有什么，都由外壳实现后注入。
import { type AbortSignalLike, ChannelError } from '../channel/protocol.mjs'
import type { TransportOpener } from '../connection/transport.mjs'
import type { DiscoveredHost, RemoteCheck, RemoteTarget, WireColor } from '../model.mjs'
import type { MachineAccessMode, MachineApproval, MachineLogEntry } from '../model-machine.mjs'
import type { PairingAddress } from '../model-pairing.mjs'
import type {
  RemoteAdapterFacts,
  RemoteInstallMethod,
  RemoteInstallResult,
  RemoteStopResult,
} from '../model-service.mjs'
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
  /** 远程设备服务的一键升级要在那台机器上做的三件事。不给（手机端）就只显示“比应用旧” */
  upgrade?: RemoteUpgradePlatform
}

/**
 * 一键升级在远程机器上做的事，经 ssh、以那台机器上登录用户的身份。ssh 自己没连上时抛 ConnectError。
 * 用户在界面上确认过才会调 install 和 stop；inspect 只是看一眼，不改任何东西
 */
export interface RemoteUpgradePlatform {
  /** 那台机器上装着的适配器在哪、报的是哪一版 */
  inspect(target: RemoteTarget, signal: AbortSignalLike): Promise<RemoteAdapterFacts>
  /** 装这一版：安装脚本（--version）或 brew upgrade；装完报装上的版本 */
  install(
    target: RemoteTarget,
    plan: { method: RemoteInstallMethod; version: string },
    signal: AbortSignalLike,
  ): Promise<RemoteInstallResult>
  /** 请服务停下（device-stop）。ifIdle 为 false 时不等它闲，进行中的事会被打断 */
  stop(target: RemoteTarget, ifIdle: boolean, signal: AbortSignalLike): Promise<RemoteStopResult>
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
   * 各台设备（键是设备标识，本机是 local）改过的两个开关：内置浏览器、Computer Use，设备一级和按 harness 的。
   * 没改过的不记，按默认来（浏览器开、Computer Use 关）；一个都没改过时没有这一项
   */
  tools?: Record<string, SavedToolSwitches>
  /**
   * 各台远程设备“操作这台电脑”的审批方式和访问范围（开关本身在 tools 的 machine 里）。
   * 没改过的不记，按默认来（每个会话确认一次、禁止常用敏感位置）
   */
  machine?: Record<string, SavedMachineSettings>
  /**
   * 各台设备（本机是 local）出码时给手机用的地址，用户在出码对话框里改过才有。
   * 只用来预填给手机的那一份，不动这台设备自己的连接配置
   */
  pairing?: Record<string, PairingAddress>
}

export interface SavedToolSwitches {
  /** 设备一级：没单独设过的 harness（包括以后新装的）跟它 */
  browser?: boolean
  computer?: boolean
  /** 远程设备“操作这台电脑”，默认关。本机设备没有这一项，也不分 harness */
  machine?: boolean
  /** 按 harness 单独设过的（键是 harness 标识）。和设备一级一样的不记 */
  harnesses?: Record<string, SavedHarnessSwitches>
}

export interface SavedHarnessSwitches {
  browser?: boolean
  computer?: boolean
}

/** 设备设置页上两个开关的默认值 */
export const DEFAULT_TOOL_SWITCHES = { browser: true, computer: false } as const

type ToolColumn = 'browser' | 'computer'
const TOOL_COLUMNS: readonly ToolColumn[] = ['browser', 'computer']

/**
 * 一台设备上两个开关现在是什么：给了 harness 的，它单独设过的按它的，没设过的跟设备一级；
 * 设备一级没改过的按默认
 */
export function toolSwitchesOf(
  kept: SavedToolSwitches | undefined,
  harness: string | null,
): { browser: boolean; computer: boolean } {
  const own = harness === null ? undefined : kept?.harnesses?.[harness]
  return {
    browser: own?.browser ?? kept?.browser ?? DEFAULT_TOOL_SWITCHES.browser,
    computer: own?.computer ?? kept?.computer ?? DEFAULT_TOOL_SWITCHES.computer,
  }
}

export interface ToolSwitchChange {
  harness?: string
  browser?: boolean
  computer?: boolean
  machine?: boolean
}

/**
 * 改开关之后存下来的样子。不带 harness：改设备一级，这一列各 harness 单独设过的一并清掉（整列跟着设备走，
 * 设置页上点设备那一格就是这样）；带 harness：只改这个 harness 的，和设备一级一样的不记
 */
export function changeToolSwitches(
  kept: SavedToolSwitches | undefined,
  change: ToolSwitchChange,
): SavedToolSwitches {
  const { harnesses: before, ...device } = kept ?? {}
  const each: Record<string, SavedHarnessSwitches> = {}
  for (const [id, entry] of Object.entries(before ?? {})) each[id] = { ...entry }
  const given = TOOL_COLUMNS.filter((column) => typeof change[column] === 'boolean')
  if (change.harness === undefined) {
    for (const column of given) {
      device[column] = change[column] as boolean
      for (const entry of Object.values(each)) delete entry[column]
    }
    if (typeof change.machine === 'boolean') device.machine = change.machine
  } else {
    const entry = { ...(each[change.harness] ?? {}) }
    const base = toolSwitchesOf(device, null)
    for (const column of given) {
      if (change[column] === base[column]) delete entry[column]
      else entry[column] = change[column] as boolean
    }
    each[change.harness] = entry
  }
  for (const [id, entry] of Object.entries(each)) {
    if (Object.keys(entry).length === 0) delete each[id]
  }
  return { ...device, ...(Object.keys(each).length > 0 ? { harnesses: each } : {}) }
}

/** harness 标识的样子：设备服务声明的都是这种短名字 */
export const HARNESS_ID = /^[A-Za-z0-9._-]{1,64}$/

/** 读回来的按 harness 那一层：认不出的丢掉，空的不留 */
function checkHarnessSwitches(value: unknown): Record<string, SavedHarnessSwitches> {
  const kept: Record<string, SavedHarnessSwitches> = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return kept
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!HARNESS_ID.test(id) || typeof entry !== 'object' || entry === null) continue
    const { browser, computer } = entry as Record<string, unknown>
    const one: SavedHarnessSwitches = {
      ...(typeof browser === 'boolean' ? { browser } : {}),
      ...(typeof computer === 'boolean' ? { computer } : {}),
    }
    if (Object.keys(one).length > 0) kept[id] = one
  }
  return kept
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
  if (typeof value !== 'string') return refuse(`${what}必须是文本`)
  const text = value.trim()
  if (!text) return refuse(`${what}不能为空`)
  if (text.length > max) return refuse(`${what}过长`)
  if (text.startsWith('-') || /[\s\u0000-\u001f\u007f]/.test(text)) {
    return refuse(`${what}不能包含空白，也不能以减号开头`)
  }
  return text
}

/** 检查并整理一份连接配置。不合规矩的直接拒绝 */
export function checkTarget(value: unknown): RemoteTarget {
  if (typeof value !== 'object' || value === null) return refuse('连接配置无效')
  const raw = value as Record<string, unknown>
  if (raw.kind === 'alias') return { kind: 'alias', alias: plain(raw.alias, '别名') }
  if (raw.kind !== 'host') return refuse('连接配置无效')
  const host = plain(raw.host, '主机名')
  if (host.includes('@')) refuse('主机名中不要包含用户名，请单独填写用户名')
  let port: number | null = null
  if (raw.port !== null && raw.port !== undefined && raw.port !== '') {
    port = Number(raw.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) refuse('端口须在 1 到 65535 之间')
  }
  const user = raw.user ? plain(raw.user, '用户名', 64) : null
  if (user && /[@:/]/.test(user)) refuse('用户名不能包含 @、冒号或斜杠')
  let keyFile: string | null = null
  if (raw.keyFile) {
    if (typeof raw.keyFile !== 'string') return refuse('请填写密钥文件路径')
    keyFile = raw.keyFile.trim()
    // 路径里可以有空格，但不能有换行和控制字符，也不能让 ssh 当成选项
    if (!keyFile || keyFile.startsWith('-') || /[\u0000-\u001f\u007f]/.test(keyFile)) {
      refuse('密钥文件路径无效')
    }
    if (keyFile.length > 1024) refuse('密钥文件路径过长')
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
      const { browser, computer, machine, harnesses } = value as Record<string, unknown>
      const each = checkHarnessSwitches(harnesses)
      const kept: SavedToolSwitches = {
        ...(typeof browser === 'boolean' ? { browser } : {}),
        ...(typeof computer === 'boolean' ? { computer } : {}),
        // 本机设备没有“操作这台电脑”
        ...(typeof machine === 'boolean' && id !== 'local' ? { machine } : {}),
        ...(Object.keys(each).length > 0 ? { harnesses: each } : {}),
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
  const pairing: Record<string, PairingAddress> = {}
  const rawPairing = raw.pairing
  if (typeof rawPairing === 'object' && rawPairing !== null && !Array.isArray(rawPairing)) {
    for (const [id, value] of Object.entries(rawPairing as Record<string, unknown>)) {
      if (id !== 'local' && !remotes.some((remote) => remote.id === id)) continue
      const address = checkPairingAddress(value)
      if (address) pairing[id] = address
    }
  }
  return {
    localWire: wireOf(raw.localWire),
    remotes,
    ...(Object.keys(tools).length > 0 ? { tools } : {}),
    ...(Object.keys(machine).length > 0 ? { machine } : {}),
    ...(Object.keys(pairing).length > 0 ? { pairing } : {}),
  }
}

/** 给手机的别名最长多少字 */
export const PAIRING_NAME_MAX = 64

/**
 * 检查一份给手机用的地址，整理好返回；不合规矩的是 null。
 * 主机名和用户名会被手机原样拿去连 ssh：不许有空白和控制字符，不许以减号开头
 */
export function checkPairingAddress(value: unknown): PairingAddress | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const word = (input: unknown, max: number): string | null => {
    if (typeof input !== 'string') return null
    const text = input.trim()
    if (!text || text.length > max || text.startsWith('-')) return null
    return /[\s\u0000-\u001f\u007f]/.test(text) ? null : text
  }
  const name =
    typeof raw.name === 'string' ? raw.name.trim().replace(/[\u0000-\u001f\u007f]/g, '') : ''
  const host = word(raw.host, 255)
  const user = word(raw.user, 64)
  const port = typeof raw.port === 'number' ? raw.port : Number.NaN
  if (!name || name.length > PAIRING_NAME_MAX || !host || host.includes('@') || !user) return null
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { name, host, port, user }
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
