// 别的会话发来的消息（peerMessages 扩展）：CLI 在 origin 上标的来源（SDK 的 SDKMessageOrigin，kind 为 peer）。
// 实时回合里看回显（native-session.mts 的 peerMessageOf），读原生记录时看记录里的 origin（native-history.mts），
// 两处认的规矩一样。纯函数。
import type { LitchPeer } from '../../protocol/src/peer-messages.mjs'

/**
 * origin 说这是别的会话发来的（kind 为 peer，不是进程内后台子代理发的 senderTaskId）时，给出原文和发送方；
 * 不是时为 null。原文取 CLI 给的 body（去掉信封，和模型看到的一致），没有 body 的（直接写收件箱的外部进程）用 fallback
 */
export function peerFromOrigin(
  origin: unknown,
  fallback: string,
): { text: string; peer: LitchPeer } | null {
  if (!origin || typeof origin !== 'object') return null
  const source = origin as Record<string, unknown>
  if (source.kind !== 'peer' || source.senderTaskId !== undefined) return null
  const text = typeof source.body === 'string' ? source.body : fallback
  if (!text.trim()) return null
  const peer: LitchPeer = {}
  if (typeof source.name === 'string' && source.name.trim()) peer.name = source.name.trim()
  if (typeof source.fromSession === 'string' && source.fromSession)
    peer.session = source.fromSession
  if (source.fromMode === 'bypass' || source.fromMode === 'prompting') peer.mode = source.fromMode
  return { text, peer }
}
