// 扫码绑定手机在界面这一头的样子（设备的 devicePairing 扩展投影过来的）。
// 桌面端出码：pairing.start 一步做完设备上的配对、主机钥匙核对、自检，回来的东西加上用户改过的地址，
// 由界面用协议包的 encodePairPayload 拼成二维码文本。移动端只用 pairing.phones、pairing.revoke（删设备时撤自己的钥匙）。
import type {
  PairHostKey,
  PairMode,
  PairPhone,
  PairState,
  PairStatus,
} from '../../protocol/src/device-pairing.mjs'

export type { PairHostKey, PairMode, PairPhone, PairState, PairStatus }

/** 二维码里给手机的地址四项。预填原配置，用户可改，改了不动设备配置 */
export interface PairingAddress {
  /** 别名：手机上的设备名 */
  name: string
  host: string
  port: number
  user: string
}

/** 手机要连的地址里决定连到哪的三项（不含别名） */
export type PairingTarget = Omit<PairingAddress, 'name'>

export interface PairingView {
  deviceId: string
  pairId: string
  /** key：一次性钥匙加强制命令；tailscale：手机自己执行登记命令（设备开着 Tailscale SSH，手机走 tailnet） */
  mode: PairMode
  /** key 方式的一次性私钥种子（PairPayload.s）；tailscale 方式是 null */
  seed: string | null
  /** tailscale 方式的登记命令（PairPayload.c）；key 方式是 null */
  command: string | null
  /** 出码前的自检做了没有：tailscale 方式下这台电脑连不到手机要连的地址时跳过 */
  checked: boolean
  /** 设备开着 Tailscale SSH（设备自报） */
  tailscaleSsh: boolean
  /** 毫秒时间戳 */
  expiresAt: number
  hostKey: PairHostKey
  /** 预填的地址：这台设备上次改过的（记在桌面端），没有就是原配置 */
  address: PairingAddress
  /**
   * 原配置：ssh 设备是 ssh -G 解析出的（那是设备自己的 MagicDNS 名、设备开着 Tailscale SSH 时换成它的 tailnet IP）；
   * 本机是设备报的主机名、用户、22
   */
  original: PairingAddress
  /** 主机的候选：设备在 tailnet 里的 IP、MagicDNS 全名、短名（设备报了 tailnet 才有），界面做成下拉 */
  hosts: string[]
  /** 设备认手机的批准公钥（列了 clientApprovals）：二维码里放 a，手机登记时带上它 */
  approvals: boolean
}

/**
 * pairing.start 失败时 ChannelError 的 key：
 * keysFile（authorized_keys 改不了）、noHostKey、hostKeyMismatch（设备自报的主机钥匙和桌面端 known_hosts 里的对不上）、
 * selfTest（一次性钥匙登不进去：sshd 不认 authorized_keys、只放行部分用户、要双因素……text 里带 ssh 的原话）、
 * sshOff（本机没开 SSH 服务）、unsupported（设备服务太旧、Windows 管理员账号）、offline、
 * tailscale（一次性钥匙自检没过，自检连的地址由 Tailscale SSH 接管：它不认强制命令，要改用 tailscale 方式出码）、
 * verify（tailscale 方式自检时 Tailscale 要求在浏览器里再验证一次：message 是 tailscaled 给的链接）
 */
export type PairingStartFailure =
  | 'keysFile'
  | 'noHostKey'
  | 'hostKeyMismatch'
  | 'selfTest'
  | 'sshOff'
  | 'unsupported'
  | 'offline'
  | 'tailscale'
  | 'verify'
  | 'enrollTest'

/** pairing 主题的快照：一台设备上已绑定的手机，和这台桌面端开出来、还没作废的配对 */
export interface PairingTopicView {
  deviceId: string
  /** 设备支不支持扫码绑定（设备服务列了 devicePairing）。还没连上过是 null */
  available: boolean | null
  /** 已绑定的手机。还没取到（没连上、不支持、正在取）是 null */
  phones: PairPhone[] | null
  /** 设备开着 Tailscale SSH：撤销钥匙行拦不住 tailnet 里被 ACL 允许的设备。还没取到是 null */
  tailscale: boolean | null
  /** 这台桌面端开出来的配对，各自现在的状态（作废了的也留着，直到界面不再订阅） */
  pairs: PairStatus[]
}
