// 远程设备的连接配置：检查、显示用的主机标识，以及外壳要为远程设备提供的那几样能力。
// 核心不碰 ssh：怎么连、用户的 ssh 配置里有什么，都由外壳实现后注入（设计文档 01 第七节）。
import { type AbortSignalLike, ChannelError } from '../channel/protocol.mjs'
import type { TransportOpener } from '../connection/transport.mjs'
import type { DiscoveredHost, RemoteCheck, RemoteTarget, WireColor } from '../model.mjs'
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
}

/** 设备配置和各台设备的侧栏快照存在哪，由外壳定 */
export interface DeviceStore {
  load(): SavedDevices
  save(devices: SavedDevices): void
  /** 一台设备的侧栏快照 */
  snapshot(deviceId: string): SnapshotStore
  /** 一台设备上终端的两样记在这台电脑上的东西：改过的名字、留在设备上不看的。不实现就不记 */
  terminals?(deviceId: string): TerminalNotesStore
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
  return { localWire: wireOf(raw.localWire), remotes }
}
