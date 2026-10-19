// 扫码绑定手机在界面这一头的样子（设备的 devicePairing 扩展投影过来的）。
// 桌面端出码：pairing.start 一步做完设备上的配对、主机钥匙核对、自检，回来的东西加上用户改过的地址，
// 由界面用协议包的 encodePairPayload 拼成二维码文本。移动端只用 pairing.phones、pairing.revoke（删设备时撤自己的钥匙）。
import type {
  PairHostKey,
  PairPhone,
  PairState,
  PairStatus,
} from '../../protocol/src/device-pairing.mjs'

export type { PairHostKey, PairPhone, PairState, PairStatus }

/** 二维码里给手机的地址四项。预填原配置，用户可改，改了不动设备配置 */
export interface PairingAddress {
  /** 别名：手机上的设备名 */
  name: string
  host: string
  port: number
  user: string
}

export interface PairingView {
  deviceId: string
  pairId: string
  /** 一次性私钥的种子（PairPayload.s） */
  seed: string
  /** 毫秒时间戳 */
  expiresAt: number
  hostKey: PairHostKey
  /** 预填的地址：这台设备上次改过的（记在桌面端），没有就是原配置 */
  address: PairingAddress
  /** 原配置：ssh 设备是 ssh -G 解析出的；本机是设备报的主机名、用户、22 */
  original: PairingAddress
}

/**
 * pairing.start 失败时 ChannelError 的 key：
 * keysFile（authorized_keys 改不了）、noHostKey、hostKeyMismatch（设备自报的主机钥匙和桌面端 known_hosts 里的对不上）、
 * selfTest（一次性钥匙登不进去：sshd 不认 authorized_keys、只放行部分用户、要双因素……text 里带 ssh 的原话）、
 * sshOff（本机没开 SSH 服务）、unsupported（设备服务太旧、Windows 管理员账号）、offline
 */
export type PairingStartFailure =
  | 'keysFile'
  | 'noHostKey'
  | 'hostKeyMismatch'
  | 'selfTest'
  | 'sshOff'
  | 'unsupported'
  | 'offline'
