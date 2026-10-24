// 扫码绑定手机（扩展名 devicePairing）：设备服务临时放行一把一次性钥匙，手机拿着它登进来、登记自己的公钥。
// 定义的原文在仓库根目录 protocol/extensions/device-pairing.json。
//
// 这个文件不引用别的文件：设备进程（packages/device）、客户端核心（packages/core）和移动端都直接引用它。
// 移动端的核心跑在 Hermes 上，这里只能用纯 JS，不能用 node:crypto、Buffer、TextEncoder。
//
// 三方：
// - 出码的一方：桌面端（经聚合面），或者设备上的命令行 `pair`（直接连 device.sock）。
// - 设备进程：管配对、改 authorized_keys。
// - 手机：扫码，用一次性钥匙 SSH 登录；登录后 sshd 只让它跑强制命令 `pair-enroll <配对号>`，
//   这个子命令把手机写进标准输入的一行交给设备进程，等出码的一方允许或拒绝，把结果写回标准输出。
//
// Tailscale 方式（mode 为 tailscale）：设备开着 Tailscale SSH、手机走 tailnet 地址时，tailscaled 按 tailnet 身份和 ACL 放行，
// 不看 authorized_keys，强制命令不生效。这时不写一次性钥匙行，二维码里带登记命令（start 回的 enrollCommand），
// 手机用自己的钥匙登进去后自己执行它，标准输入输出和上面一样；配对号是唯一的秘密，有效期、确认、手机钥匙行都照旧。
// 用哪种方式由出码的一方定（pairModeOf）：读手机要连的地址的 SSH 横幅，读不到时看设备自报的 tailscaleSsh 和地址。
//
// 方法不要求握手时声明（和 litch/clientTool/invoke 一样，命令行连 device.sock 不握手）；
// 通知 litch/pair/changed、litch/pair/phones/changed 只发给握手时在 capabilities.litchExtensions 里列了
// devicePairing 的连接。设备信息（runtime/info 的 device.extensions）里列了 devicePairing 才能用。

// 扩展名登记在 device.mts 的 EXTENSION.devicePairing。

// ---------- 常量 ----------

/** 一次配对的有效期：从 start 起算，过了就作废、删掉一次性钥匙行 */
export const PAIR_TTL_MS = 10 * 60 * 1000
/** 手机登记后等出码的一方允许的最长时间，过了按拒绝处理：配对作废（rejected），手机收到 timeout */
export const PAIR_DECIDE_TIMEOUT_MS = 2 * 60 * 1000
/** 手机名最长多少个字（UTF-16 码元）；设备进程去掉控制字符、截断 */
export const PAIR_PHONE_NAME_MAX = 64
/** 二维码文本的前缀，后面是 base64url（无填充）编码的 UTF-8 JSON（PairPayload） */
export const PAIR_PAYLOAD_PREFIX = 'LITCHPAIR1:'
/** authorized_keys 行尾注释的标记：一次性钥匙行 `litch-pair:<配对号>`，手机行 `litch-mobile:<手机号> <名字> <日期>` */
export const PAIR_KEY_MARK = 'litch-pair:'
export const PHONE_KEY_MARK = 'litch-mobile:'
/** Tailscale SSH 的横幅开头：tailscaled 接管的地址上，SSH 服务报的是它 */
export const PAIR_TAILSCALE_BANNER = 'SSH-2.0-Tailscale'

/** 出码的方式：key 是一次性钥匙加强制命令；tailscale 是手机自己执行登记命令（不写一次性钥匙行） */
export type PairMode = 'key' | 'tailscale'

// ---------- 确认码与手机号（算法，设备进程用 Node、手机用 Go 各自实现） ----------
//
// 确认码：SHA-256( UTF-8( 配对号 + "\n" + 手机公钥行 ) )，取前 4 字节按大端读成无符号整数，模 1000000，
//   左边补零到 6 位。公钥行是 "ssh-ed25519 <base64>"，不带注释。
//   手机带了批准公钥（PairEnrollInput.approvalKey）时，哈希的是 配对号 + "\n" + 手机公钥行 + "\n" + approvalKey。
// 手机号：手机公钥的二进制（base64 解出来的那段）做 SHA-256，取前 8 字节的小写十六进制，16 个字符。
// 指纹：和 `ssh-keygen -l -E sha256` 一样，"SHA256:" 加无填充的标准 base64。
//
// 测试向量：配对号 "Ab3dEf6hIj9kLm2n"，
//   公钥行 "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
//   → 确认码 "965093"，手机号 "f83898df0bef57a4"，指纹 "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"；
//   再带上批准公钥 "ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=" → 确认码 "977558"

// ---------- 二维码里的内容 ----------

/**
 * 二维码（和“复制配对文本”）里的东西。键名都很短，为了让二维码小一点。
 * 地址四项（n、h、p、u）由出码的一方填：预填原配置、用户可以改，改了不影响出码一方自己的设备配置。
 * 一次性钥匙方式带种子 s；Tailscale 方式没有种子，带 m 和登记命令 c。
 */
export type PairPayload = PairKeyPayload | PairTailscalePayload

interface PairPayloadBase {
  /** 格式版本，现在是 1 */
  v: 1
  /** 别名：手机上的设备名 */
  n: string
  /** 主机名或 IP，手机连的就是它 */
  h: string
  /** 端口 */
  p: number
  /** 用户 */
  u: string
  /** 主机钥匙：类型（如 ssh-ed25519）和指纹（SHA256:…）。手机只协商这一种算法并钉住这个指纹 */
  k: { t: string; f: string }
  /** 配对号 */
  i: string
  /** 过期时间，毫秒时间戳 */
  e: number
  /**
   * 设备认批准公钥（列了 clientApprovals）：手机登记时带上 approvalKey，确认码把它算进去。
   * 没有这一项时手机不带（老设备算确认码时不认它，带了两边的确认码就对不上）
   */
  a?: 1
}

export interface PairKeyPayload extends PairPayloadBase {
  m?: undefined
  /** 一次性钥匙：ed25519 私钥的 32 字节种子，base64url 无填充 */
  s: string
}

export interface PairTailscalePayload extends PairPayloadBase {
  m: 'tailscale'
  /** 登记命令：手机登进去后原样执行（start 回的 enrollCommand，已经按 sh 的规矩引好、带着配对号） */
  c: string
}

/**
 * 键的顺序是固定的（命令行的 Go 那份照同样的顺序拼，两边一字不差）：
 * 一次性钥匙方式 v n h p u k s i e；Tailscale 方式 v n h p u k m c i e；有 a 的接在最后
 * （命令行出码时没有桌面端记批准公钥，不带 a）
 */
export function encodePairPayload(payload: PairPayload): string {
  const head = { v: 1, n: payload.n, h: payload.h, p: payload.p, u: payload.u, k: payload.k }
  const body =
    payload.m === 'tailscale'
      ? { ...head, m: payload.m, c: payload.c, i: payload.i, e: payload.e }
      : { ...head, s: payload.s, i: payload.i, e: payload.e }
  const full = payload.a === 1 ? { ...body, a: 1 } : body
  return PAIR_PAYLOAD_PREFIX + base64UrlEncode(utf8Encode(JSON.stringify(full)))
}

/** 不是配对文本、格式不对时返回 null。不检查是否过期（手机拿 e 和自己的时钟比，只用来提示） */
export function decodePairPayload(text: string): PairPayload | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith(PAIR_PAYLOAD_PREFIX)) return null
  let value: unknown
  try {
    const bytes = base64UrlDecode(trimmed.slice(PAIR_PAYLOAD_PREFIX.length))
    if (!bytes) return null
    value = JSON.parse(utf8Decode(bytes))
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const k = v.k as Record<string, unknown> | undefined
  if (
    v.v !== 1 ||
    typeof v.n !== 'string' ||
    typeof v.h !== 'string' ||
    v.h.trim() === '' ||
    typeof v.p !== 'number' ||
    !Number.isInteger(v.p) ||
    v.p < 1 ||
    v.p > 65535 ||
    typeof v.u !== 'string' ||
    v.u.trim() === '' ||
    !k ||
    typeof k.t !== 'string' ||
    typeof k.f !== 'string' ||
    !k.f.startsWith('SHA256:') ||
    typeof v.i !== 'string' ||
    v.i === '' ||
    typeof v.e !== 'number'
  ) {
    return null
  }
  const base = {
    v: 1 as const,
    n: v.n,
    h: v.h.trim(),
    p: v.p,
    u: v.u.trim(),
    k: { t: k.t, f: k.f },
    i: v.i,
    e: v.e,
    ...(v.a === 1 ? { a: 1 as const } : {}),
  }
  if (v.m === 'tailscale') {
    // 命令原样交给对面的 shell：只许一行
    if (typeof v.c !== 'string' || v.c.trim() === '' || /[\r\n]/.test(v.c)) return null
    return { ...base, m: 'tailscale', c: v.c }
  }
  if (v.m !== undefined || typeof v.s !== 'string') return null
  const seed = base64UrlDecode(v.s)
  if (seed?.length !== 32) return null
  return { ...base, s: v.s }
}

// ---------- 用哪种方式（出码的一方定） ----------

/** tailnet 的地址：MagicDNS 名字（*.ts.net）或者 CGNAT 段 100.64.0.0/10 的 IPv4 */
export function isTailnetHost(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/\.$/, '')
  if (name.endsWith('.ts.net')) return true
  const parts = name.split('.')
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return false
  const [a, b] = parts.map(Number) as [number, number]
  return a === 100 && b >= 64 && b <= 127
}

/**
 * 手机要连的地址该用哪种方式。banner 是那个地址上 SSH 服务的头一行（读不到是 null），
 * tailscaleSsh 是设备自报的（本机 tailscale debug prefs 里的 RunSSH）。
 * 横幅是 Tailscale 的 → tailscale；读到了别的 → key；读不到时设备开着 Tailscale SSH 而且地址是 tailnet 的 → tailscale，否则 key
 */
export function pairModeOf(banner: string | null, tailscaleSsh: boolean, host: string): PairMode {
  if (banner !== null) return banner.startsWith(PAIR_TAILSCALE_BANNER) ? 'tailscale' : 'key'
  return tailscaleSsh && isTailnetHost(host) ? 'tailscale' : 'key'
}

/**
 * Tailscale 要在浏览器里再验证一次时（ACL 的 check 模式）tailscaled 给的链接。它在登录阶段打一句
 * “To authenticate, visit: <链接>”，然后等人去点。text 里没有这样的链接是 null
 */
export function tailscaleVerifyUrl(text: string): string | null {
  const said = /To authenticate, visit:\s*(https?:\/\/\S+)/i.exec(text)
  if (said?.[1]) return said[1]
  return /https:\/\/login\.tailscale\.com\/a\/\S+/.exec(text)?.[0] ?? null
}

// ---------- 手机和 pair-enroll 之间（SSH 会话的标准输入输出，各一行 JSON，以 \n 结尾） ----------

/**
 * 手机（或出码一方的自检）写进标准输入的一行。
 * probe 为 true 是自检：只回 `{ok: true, probe: true}`，不消耗配对、不通知、不要 publicKey。
 */
export type PairEnrollInput =
  | { v: 1; probe: true }
  | {
      v: 1
      probe?: false
      /** "ssh-ed25519 <base64>"，只收 ed25519，不带注释 */
      publicKey: string
      /** 手机名，给出码的一方看、写进钥匙行的注释 */
      name: string
      /**
       * 手机批准登录用的批准公钥（clientApprovals，client-approvals.mts）：32 字节 ed25519 的标准 base64。
       * 可选：老手机不带。带了的，确认码把它也算进去，出码的一方在人核对过确认码、允许的那一刻记下它（扫码时核对过）
       */
      approvalKey?: string
    }

/**
 * pair-enroll 写回标准输出的一行，写完就退出。
 * 读的一方（手机、自检）要跳过它前面的行：sshd 经登录 shell 跑强制命令，shell 的启动文件（比如 Linux 上的 .bashrc）
 * 打出来的字会排在前面。回话是第一行带布尔 ok 的 JSON 对象
 */
export type PairEnrollOutput =
  | { ok: true; probe?: boolean; phoneId?: string }
  | { ok: false; error: PairEnrollError; message: string }

export const PAIR_ENROLL_ERROR = {
  /** 过期了、取消了、或者配对号不认识 */
  expired: 'expired',
  /** 已经有一部手机用这个码登记过了 */
  used: 'used',
  /** 出码的一方点了拒绝 */
  rejected: 'rejected',
  /** 出码的一方 2 分钟没表态 */
  timeout: 'timeout',
  /** 输入不对（不是 ed25519、格式错） */
  invalid: 'invalid',
  /** 写 authorized_keys 失败（只读、被别的工具管着、权限不对） */
  keysFile: 'keysFile',
  /** 连不上设备进程 */
  unavailable: 'unavailable',
} as const
export type PairEnrollError = (typeof PAIR_ENROLL_ERROR)[keyof typeof PAIR_ENROLL_ERROR]

// ---------- 方法 ----------

export const DEVICE_PAIR_START = 'litch/pair/start'

/** 有效期固定 PAIR_TTL_MS。mode 不给是 key（一次性钥匙）；tailscale 不写一次性钥匙行 */
export interface DevicePairStartParams {
  mode?: PairMode
}

export type DevicePairStartResponse = DevicePairKeyStart | DevicePairTailscaleStart

interface DevicePairStartBase {
  pairId: string
  /** 毫秒时间戳 */
  expiresAt: number
  /** 二维码里放的那一把：有 ed25519 用 ed25519，否则 ecdsa，再否则 rsa */
  hostKey: PairHostKey
  /** 这台机器的全部主机钥匙（出码的一方拿去和自己 known_hosts 里的比） */
  hostKeys: PairHostKey[]
  /** 设备上的主机名（os.hostname()）和用户名：本机、命令行出码时预填用 */
  hostname: string
  user: string
  /** 这台机器开着 Tailscale SSH（tailscale debug prefs 里 RunSSH 为 true；命令不在、跑不通算 false） */
  tailscaleSsh: boolean
  /** 这台机器在 tailnet 里的名字和地址。开着 Tailscale、tailnet 开了 MagicDNS 才有；老的设备服务不带 */
  tailnet?: PairTailnet
}

/** 一台机器在 tailnet 里的样子（tailscale status --json 的 Self） */
export interface PairTailnet {
  /** MagicDNS 全名，不带末尾的点，如 song-debian.tail2e2f6a.ts.net */
  name: string
  /** 它的 tailnet 地址：100.64.0.0/10 的 IPv4、fd7a:115c:a1e0::/48 的 IPv6 */
  addresses: string[]
}

export interface DevicePairKeyStart extends DevicePairStartBase {
  mode: 'key'
  /** 一次性私钥的 32 字节种子，base64url 无填充（就是 PairPayload.s） */
  seed: string
}

export interface DevicePairTailscaleStart extends DevicePairStartBase {
  mode: 'tailscale'
  /** 手机登进去后自己执行的登记命令（就是 PairPayload.c）：和一次性钥匙行的强制命令是同一条 */
  enrollCommand: string
}

export interface PairHostKey {
  /** ssh-ed25519、ecdsa-sha2-nistp256、ssh-rsa…… */
  type: string
  /** SHA256:… */
  fingerprint: string
  /** 公钥行 "<type> <base64>"，出码的一方写临时 known_hosts 时用 */
  publicKey: string
}

export const DEVICE_PAIR_CANCEL = 'litch/pair/cancel'
export const DEVICE_PAIR_DECIDE = 'litch/pair/decide'
export const DEVICE_PAIR_WAIT = 'litch/pair/wait'
export const DEVICE_PAIR_ENROLL = 'litch/pair/enroll'
export const DEVICE_PAIR_PHONES = 'litch/pair/phones'
export const DEVICE_PAIR_REVOKE = 'litch/pair/revoke'

export interface DevicePairIdParams {
  pairId: string
}

export interface DevicePairDecideParams {
  pairId: string
  allow: boolean
}

/**
 * 给不握手的命令行用的长轮询：state 和 since 不同就立刻回，否则等到变了（或等满 30 秒回当前的）。
 * 握了手、声明了 devicePairing 的连接用通知，不用它。
 */
export interface DevicePairWaitParams {
  pairId: string
  since: PairState | null
}

/** pair-enroll 子命令调的：一直挂着，直到允许、拒绝或超时才回 */
export interface DevicePairEnrollParams {
  pairId: string
  input: PairEnrollInput
}

export type DevicePairEnrollResponse = PairEnrollOutput

/**
 * waiting：等扫码；requested：有手机来登记了，等允许；done：登记成功，一次性钥匙已删；
 * expired、cancelled：作废了；rejected：拒绝了（或 2 分钟没表态），配对作废。
 * 一个配对号只接受一部手机：requested 期间别的登记直接回 used。
 */
export type PairState = 'waiting' | 'requested' | 'done' | 'expired' | 'cancelled' | 'rejected'

export interface PairStatus {
  pairId: string
  state: PairState
  expiresAt: number
  /** requested、done 时有 */
  phone: PairPhoneRequest | null
}

export interface PairPhoneRequest {
  phoneId: string
  name: string
  fingerprint: string
  /** 6 位确认码 */
  code: string
  /** 手机登记时带的批准公钥（PairEnrollInput.approvalKey），已经算进了确认码。没带是没有这一项 */
  approvalKey?: string
  /**
   * 手机的公钥行（"ssh-ed25519 <base64>"）。带了批准公钥才有：出码的一方拿它、配对号和批准公钥自己重算一遍确认码，
   * 对得上才记下批准公钥（设备不可信，它报的确认码和批准公钥不能直接信）
   */
  publicKey?: string
}

export interface PairPhone {
  phoneId: string
  name: string
  fingerprint: string
  /** 钥匙行注释里的日期，毫秒时间戳；读不出来是 null */
  addedAt: number | null
}

export interface DevicePairPhonesResponse {
  data: PairPhone[]
  /** 这台机器开着 Tailscale SSH：tailnet 里被 ACL 允许的设备不要钥匙就能登，撤销钥匙行拦不住它们 */
  tailscaleSsh: boolean
}

export interface DevicePairRevokeParams {
  phoneId: string
}

// ---------- 通知 ----------

/** 只发给声明了 devicePairing 的连接：某个配对的状态变了 */
export const DEVICE_PAIR_CHANGED = 'litch/pair/changed'
export type DevicePairChangedNotification = PairStatus

/** 只发给声明了 devicePairing 的连接：已绑定的手机多了、少了 */
export const DEVICE_PAIR_PHONES_CHANGED = 'litch/pair/phones/changed'
export type DevicePairPhonesChangedNotification = DevicePairPhonesResponse

// ---------- 错误 ----------

/** JSON-RPC 错误的 data.reason 取这些；code 都是 -32000，unknownPair 是 -32602 */
export const DEVICE_PAIR_ERROR = {
  /** 没有这个配对（过期清掉了、或从没有过） */
  unknownPair: 'unknownPair',
  /** 没有这部手机 */
  unknownPhone: 'unknownPhone',
  /** authorized_keys 不能改：是符号链接、只读、属主或权限不对 */
  keysFile: 'keysFile',
  /** 读不到主机钥匙（/etc/ssh/ssh_host_*_key.pub 都没有） */
  noHostKey: 'noHostKey',
  /** 这台设备不支持（例如 Windows 的管理员账号，钥匙在 administrators_authorized_keys） */
  unsupported: 'unsupported',
  /** 不是 requested 状态时 decide */
  notRequested: 'notRequested',
} as const
export type DevicePairErrorReason = (typeof DEVICE_PAIR_ERROR)[keyof typeof DEVICE_PAIR_ERROR]

// ---------- 纯 JS 的 UTF-8 与 base64url（Hermes 上没有 TextEncoder、Buffer 可依赖） ----------

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function utf8Encode(text: string): number[] {
  const out: number[] = []
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) out.push(code)
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63))
    else if (code < 0x10000)
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      )
  }
  return out
}

function utf8Decode(bytes: number[]): string {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i] ?? 0
    const need = b < 0x80 ? 0 : b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : b >= 0xc0 ? 1 : -1
    if (need < 0 || i + need >= bytes.length + (need === 0 ? 1 : 0)) throw new Error('bad utf-8')
    let code = need === 0 ? b : b & (0x3f >> need)
    for (let j = 1; j <= need; j++) {
      const c = bytes[i + j] ?? 0
      if ((c & 0xc0) !== 0x80) throw new Error('bad utf-8')
      code = (code << 6) | (c & 63)
    }
    out += String.fromCodePoint(code)
    i += need + 1
  }
  return out
}

function base64UrlEncode(bytes: number[]): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64URL[(n >> 18) & 63]
    out += B64URL[(n >> 12) & 63]
    if (b !== undefined) out += B64URL[(n >> 6) & 63]
    if (c !== undefined) out += B64URL[n & 63]
  }
  return out
}

/** 解不开（有非法字符、长度不对）返回 null */
export function base64UrlDecode(text: string): number[] | null {
  if (text.length % 4 === 1) return null
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of text) {
    const value = B64URL.indexOf(char)
    if (value < 0) return null
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
  }
  return out
}
