// 本机收件箱的地址认回是哪个会话（peerMessages 扩展）。
//
// 模型回复别的会话发来的消息时，SendMessage 的 to 多半是照抄信封里的 from：`uds:<套接字路径>`，
// 照原样画出来用户只看到一串套接字。认法，按先后：
// - 这台设备上的进程登记（<配置目录>/sessions/<进程号>.json，native-owner.mts 的 readRegistry）：
//   messagingSocketPath 对得上、进程还活着的那条，给出登记名、宿主会话号、原生会话号；
//   原生会话号是 Litch 自己的会话（或导进来的）时，名字换成 Litch 里的标题，并带上会话号好点过去。
// - 这个会话里收到过的消息：origin.from 是同一个地址的，用发送方当时报的名字和会话号（对方进程退了也认得出）。
// 两样都认不出时给 null，调用方照旧写地址，客户端写成可读的说法。纯函数，登记和库由调用方给。
import type { LitchPeer } from '../../protocol/src/peer-messages.mjs'
import type { RegistryEntry } from './native-owner.mjs'

/** `uds:<套接字路径>` 里的路径。别的地址（名字、bridge:…）是 null */
export function udsSocket(address: string): string | null {
  const match = /^uds:(\S+)$/.exec(address.trim())
  return match?.[1] ?? null
}

export interface PeerLookup {
  /** 这个会话里收到过的消息：发送方的收件箱地址 → 发送方 */
  seen?: ReadonlyMap<string, LitchPeer>
  /** 本机登记里还活着的进程 */
  registry?: () => readonly RegistryEntry[]
  /** 原生会话号 → Litch 里的会话（会话号、标题）。不是 Litch 认得的会话是 null */
  thread?: (sessionId: string) => { id: string; name: string | null } | null
}

/**
 * 地址 address 是哪个会话。base 是消息自己带的（收到的消息上 CLI 给的发送方），认出来的补在它上面；
 * 发出去的没有 base。地址不是收件箱地址、什么都没认出来时：有 base 给 base，没有给 null
 */
export function resolvePeer(
  address: string,
  lookup: PeerLookup,
  base?: LitchPeer,
): LitchPeer | null {
  const socket = udsSocket(address)
  if (!socket) return base ?? null
  const seen = lookup.seen?.get(address.trim())
  let entry: RegistryEntry | undefined
  try {
    entry = lookup.registry?.().find((candidate) => candidate.socket === socket)
  } catch {
    // 登记读不了：只靠收到过的消息
  }
  const litch = entry ? (lookup.thread?.(entry.sessionId) ?? null) : null
  const peer: LitchPeer = { ...base }
  const name = litch?.name ?? entry?.name ?? base?.name ?? seen?.name
  if (name) peer.name = name
  const session = base?.session ?? seen?.session ?? entry?.hostSessionId
  if (session) peer.session = session
  const thread = litch?.id ?? seen?.thread
  if (thread) peer.thread = thread
  if (!peer.name && !peer.session && !peer.thread) return base ?? null
  return peer
}
