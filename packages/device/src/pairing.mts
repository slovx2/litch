// 扫码绑定手机（devicePairing 扩展）在设备进程里的部分：配对的状态（只在内存）、一次性钥匙行和手机行的读写、
// litch/pair/* 方法和两个通知。约定在 packages/protocol/src/device-pairing.mts，规则在
// protocol/extensions/device-pairing.json。
//
// 一次配对：start 写一次性钥匙行 → 手机用它登录，强制命令 pair-enroll 调 enroll（挂着）→ 状态 requested，
// 通知出码的一方 → decide 允许就追加手机行；结束（done、expired、cancelled、rejected）时删掉一次性钥匙行。
// Tailscale 方式（start 的 mode 为 tailscale）不写一次性钥匙行，把登记命令交给出码的一方放进二维码，
// 手机登进去后自己执行它；之后的状态和登记都一样。
import { hostname as osHostname, userInfo } from 'node:os'
import { isApprovalKey } from '../../protocol/src/client-approvals.mjs'
import { EXTENSION } from '../../protocol/src/device.mjs'
import {
  DEVICE_PAIR_CANCEL,
  DEVICE_PAIR_CHANGED,
  DEVICE_PAIR_DECIDE,
  DEVICE_PAIR_ENROLL,
  DEVICE_PAIR_ERROR,
  DEVICE_PAIR_PHONES,
  DEVICE_PAIR_PHONES_CHANGED,
  DEVICE_PAIR_REVOKE,
  DEVICE_PAIR_START,
  DEVICE_PAIR_WAIT,
  type DevicePairErrorReason,
  type DevicePairPhonesResponse,
  type DevicePairStartResponse,
  PAIR_DECIDE_TIMEOUT_MS,
  PAIR_ENROLL_ERROR,
  PAIR_TTL_MS,
  type PairEnrollError,
  type PairEnrollOutput,
  type PairHostKey,
  type PairMode,
  type PairPhoneRequest,
  type PairState,
  type PairStatus,
  type PairTailnet,
} from '../../protocol/src/device-pairing.mjs'
import { expiryTime, preferredHostKey, type SshdVersion } from './pair-host.mjs'
import {
  AuthorizedKeys,
  cleanPhoneName,
  confirmCodeOf,
  enrollCommand,
  fingerprintOf,
  hasKey,
  isPairId,
  isPairLine,
  isPhoneId,
  KeysFileError,
  newOneTimeKey,
  newPairId,
  oneTimeLine,
  parseEd25519Line,
  parsePhoneLine,
  phoneIdOf,
  phoneLine,
} from './pair-keys.mjs'
import { isObject } from './wire.mjs'

/** 方法名的共同前缀：聚合面按它把请求交给这里 */
export const PAIR_PREFIX = 'litch/pair/'

/** 长轮询（litch/pair/wait）最多挂这么久 */
export const PAIR_WAIT_MS = 30_000
/** 配对结束后还记着它这么久：出码的一方、命令行还能问到最后的状态，之后当作不认识 */
export const PAIR_FORGET_MS = 10 * 60 * 1000
/** 开没开 Tailscale SSH 记多久：phones 一打开设备详情就问，不用每次都跑命令 */
export const TAILSCALE_CACHE_MS = 30_000

/** 定时器。测试换成可以拨的假时钟 */
export interface PairingClock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const REAL_CLOCK: PairingClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms).unref(),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

/** 设备进程起来时给的配置（main.mts 从环境里取） */
export interface PairingConfig {
  /** authorized_keys 的路径 */
  keysFile: string
  /** 读主机钥匙 */
  hostKeys(): PairHostKey[]
  /** 适配器命令行的路径，一次性钥匙行的强制命令用它。拿不到是空的，这时不支持配对 */
  adapterCli: string
  /** 适配器的状态目录（设备进程的 --state 的上一级），强制命令带着它找设备服务 */
  adapterHome: string
  /** 不支持配对的原因（Windows 的管理员账号）。支持是 null */
  unsupported: string | null
  sshdVersion(): Promise<SshdVersion | null>
  /** 这台机器开着 Tailscale SSH 没有（pair-host.mts 的 detectTailscaleSsh） */
  tailscaleSsh(): Promise<boolean>
  /** 这台机器在 tailnet 里的名字和地址（pair-host.mts 的 detectTailnet）。不给当作没有 */
  tailnet?(): Promise<PairTailnet | null>
  platform?: NodeJS.Platform
  clock?: PairingClock
  /** 设备上的主机名和用户名，默认取系统的 */
  hostname?: string
  user?: string
}

export interface PairingHost {
  /** 发给所有声明了 extension 的连接 */
  announce(method: string, params: unknown, extension: string): void
  log(line: string): void
}

/** litch/pair/* 回的错误：data.reason 是原因，unknownPair 是 -32602，其余 -32000；参数不对是 -32602、不带原因 */
export class PairingError extends Error {
  readonly code: number
  readonly data?: { reason: DevicePairErrorReason }

  constructor(reason: DevicePairErrorReason | null, message: string) {
    super(message)
    this.code = reason === null || reason === DEVICE_PAIR_ERROR.unknownPair ? -32602 : -32000
    if (reason) this.data = { reason }
  }
}

interface Pair {
  id: string
  mode: PairMode
  expiresAt: number
  state: PairState
  phone: PairPhoneRequest | null
  /** requested 时手机的公钥行 */
  phoneKey: string | null
  /** 挂着的 enroll：出结果时调它 */
  enroll: ((output: PairEnrollOutput) => void) | null
  /** 挂着的 wait：状态一变全叫醒 */
  waiters: Set<() => void>
  timers: { expiry: unknown; decide: unknown; forget: unknown }
}

const ACTIVE: ReadonlySet<PairState> = new Set(['waiting', 'requested'])

export class DevicePairing {
  private readonly config: PairingConfig
  private readonly host: PairingHost
  private readonly keys: AuthorizedKeys
  private readonly clock: PairingClock
  private readonly windows: boolean
  private readonly pairs = new Map<string, Pair>()
  private version: Promise<SshdVersion | null> | null = null
  private tailscale: { at: number; value: Promise<boolean> } | null = null
  private tailnetSelf: { at: number; value: Promise<PairTailnet | null> } | null = null
  /** 已绑定手机的通知排的队 */
  private notices: Promise<void> = Promise.resolve()
  private closed = false

  constructor(config: PairingConfig, host: PairingHost) {
    this.config = config
    this.host = host
    this.clock = config.clock ?? REAL_CLOCK
    this.windows = (config.platform ?? process.platform) === 'win32'
    this.keys = new AuthorizedKeys(config.keysFile, config.platform)
    // 配对只在内存里：上一次留下的一次性钥匙行都作废，删掉
    try {
      const removed = this.keys.remove((line) => isPairLine(line))
      if (removed > 0) host.log(`删掉了上次留下的 ${removed} 行一次性配对钥匙`)
    } catch (error) {
      host.log(`清理上次留下的一次性配对钥匙失败：${String(error)}`)
    }
  }

  /** 这台设备能不能出码：runtime/info 里列不列 devicePairing */
  get available(): boolean {
    return this.unsupported() === null
  }

  private unsupported(): string | null {
    if (this.config.unsupported) return this.config.unsupported
    if (!this.config.adapterCli) return '找不到适配器的命令行，一次性钥匙行没有强制命令可写'
    // 换行之类会把一行钥匙拆成几行
    if (/\p{Cc}/u.test(this.config.adapterCli)) return '适配器命令行的路径里有控制字符'
    if (/\p{Cc}/u.test(this.config.adapterHome)) return '适配器状态目录的路径里有控制字符'
    return null
  }

  /** 聚合面交来的 litch/pair/* 请求 */
  call(method: string, params: unknown): Promise<unknown> | unknown {
    if (this.closed) throw new PairingError(DEVICE_PAIR_ERROR.unsupported, '设备服务正在关闭')
    const why = this.unsupported()
    if (why) throw new PairingError(DEVICE_PAIR_ERROR.unsupported, why)
    const given = isObject(params) ? params : {}
    switch (method) {
      case DEVICE_PAIR_START:
        return this.start(modeOf(given.mode))
      case DEVICE_PAIR_CANCEL:
        this.cancel(pairIdOf(given))
        return {}
      case DEVICE_PAIR_DECIDE:
        if (typeof given.allow !== 'boolean')
          throw new PairingError(null, 'allow 要是 true 或 false')
        return this.decide(pairIdOf(given), given.allow)
      case DEVICE_PAIR_WAIT:
        return this.wait(pairIdOf(given), given.since ?? null)
      case DEVICE_PAIR_ENROLL:
        return this.enroll(given.pairId, given.input)
      case DEVICE_PAIR_PHONES:
        return this.phones()
      case DEVICE_PAIR_REVOKE:
        this.revoke(given.phoneId)
        return {}
      default:
        throw new PairingError(DEVICE_PAIR_ERROR.unsupported, `不认识 ${method}`)
    }
  }

  private async start(mode: PairMode): Promise<DevicePairStartResponse> {
    // Tailscale SSH 只在 Linux、macOS 上有；Windows 上要这种方式多半是出码的一方认错了
    if (mode === 'tailscale' && this.windows)
      throw new PairingError(DEVICE_PAIR_ERROR.unsupported, 'Windows 上没有 Tailscale SSH')
    try {
      this.keys.check()
    } catch (error) {
      throw keysFileError(error)
    }
    const hostKeys = this.config.hostKeys()
    const hostKey = preferredHostKey(hostKeys)
    if (!hostKey) throw new PairingError(DEVICE_PAIR_ERROR.noHostKey, '读不到这台机器的主机钥匙')
    this.version ??= this.config.sshdVersion().catch(() => null)
    const [version, tailscaleSsh, tailnet] = await Promise.all([
      this.version,
      this.tailscaleSsh(),
      this.tailnet(),
    ])
    if (this.closed) throw new PairingError(DEVICE_PAIR_ERROR.unsupported, '设备服务正在关闭')
    const id = newPairId()
    const expiresAt = this.clock.now() + PAIR_TTL_MS
    const command = enrollCommand(this.config.adapterCli, id, this.windows, this.config.adapterHome)
    const key = mode === 'key' ? newOneTimeKey() : null
    if (key) {
      try {
        this.keys.append(
          oneTimeLine(id, key.publicKeyLine, command, expiryTime(version, expiresAt)),
        )
      } catch (error) {
        throw keysFileError(error)
      }
    }
    const pair: Pair = {
      id,
      mode,
      expiresAt,
      state: 'waiting',
      phone: null,
      phoneKey: null,
      enroll: null,
      waiters: new Set(),
      timers: { expiry: null, decide: null, forget: null },
    }
    this.pairs.set(id, pair)
    // 到期只作废还在等扫码的；已经有手机在登记的，等出码的一方表态（或 2 分钟超时）
    pair.timers.expiry = this.clock.setTimeout(() => {
      if (pair.state === 'waiting') this.finish(pair, 'expired')
    }, PAIR_TTL_MS)
    this.host.log(`配对 ${id} 开始（${mode}），有效到 ${new Date(expiresAt).toISOString()}`)
    this.changed(pair)
    const base = {
      pairId: id,
      expiresAt,
      hostKey,
      hostKeys,
      hostname: this.config.hostname ?? osHostname(),
      user: this.config.user ?? currentUser(),
      tailscaleSsh,
      ...(tailnet ? { tailnet } : {}),
    }
    return key
      ? { ...base, mode: 'key', seed: key.seed }
      : { ...base, mode: 'tailscale', enrollCommand: command }
  }

  /** 开没开 Tailscale SSH，记 TAILSCALE_CACHE_MS */
  private tailscaleSsh(): Promise<boolean> {
    const now = this.clock.now()
    if (!this.tailscale || now - this.tailscale.at >= TAILSCALE_CACHE_MS) {
      this.tailscale = { at: now, value: this.config.tailscaleSsh().catch(() => false) }
    }
    return this.tailscale.value
  }

  /** 这台机器在 tailnet 里的名字和地址，也记 TAILSCALE_CACHE_MS */
  private tailnet(): Promise<PairTailnet | null> {
    const now = this.clock.now()
    if (!this.tailnetSelf || now - this.tailnetSelf.at >= TAILSCALE_CACHE_MS) {
      const value = this.config.tailnet?.().catch(() => null) ?? Promise.resolve(null)
      this.tailnetSelf = { at: now, value }
    }
    return this.tailnetSelf.value
  }

  private cancel(pairId: string): void {
    const pair = this.known(pairId)
    if (ACTIVE.has(pair.state)) this.finish(pair, 'cancelled', PAIR_ENROLL_ERROR.expired)
  }

  private decide(pairId: string, allow: boolean): PairStatus {
    const pair = this.known(pairId)
    if (pair.state !== 'requested' || !pair.phone || !pair.phoneKey)
      throw new PairingError(
        DEVICE_PAIR_ERROR.notRequested,
        `配对 ${pairId} 现在是 ${pair.state}，没有在等允许`,
      )
    if (!allow) {
      this.finish(pair, 'rejected', PAIR_ENROLL_ERROR.rejected)
      return statusOf(pair)
    }
    const phoneKey = pair.phoneKey
    const keyBase64 = phoneKey.split(' ')[1] ?? ''
    try {
      // 同一把公钥已经在文件里（这部手机绑过、或者用户手动加过）就不重复写
      if (!this.keys.lines().some((line) => hasKey(line, keyBase64)))
        this.keys.append(phoneLine(phoneKey, pair.phone.phoneId, pair.phone.name, this.clock.now()))
    } catch (error) {
      this.finish(pair, 'cancelled', PAIR_ENROLL_ERROR.keysFile)
      throw keysFileError(error)
    }
    this.finish(pair, 'done', null)
    this.announcePhones()
    return statusOf(pair)
  }

  private wait(pairId: string, since: unknown): Promise<PairStatus> | PairStatus {
    const pair = this.known(pairId)
    if (pair.state !== since) return statusOf(pair)
    return new Promise((resolve) => {
      const wake = () => {
        this.clock.clearTimeout(timer)
        pair.waiters.delete(wake)
        resolve(statusOf(pair))
      }
      const timer = this.clock.setTimeout(wake, PAIR_WAIT_MS)
      pair.waiters.add(wake)
    })
  }

  /**
   * pair-enroll 子命令交来的一行。自检（probe）只看配对还在不在，不消耗；真的登记挂着，直到允许、拒绝、超时或作废。
   * 这里不抛错，结果都写成 PairEnrollOutput（pair-enroll 原样写回手机）
   */
  private enroll(pairId: unknown, input: unknown): Promise<PairEnrollOutput> | PairEnrollOutput {
    const pair = isPairId(pairId) ? this.pairs.get(pairId) : undefined
    const expired = fail(PAIR_ENROLL_ERROR.expired)
    if (!isObject(input) || input.v !== 1) return fail(PAIR_ENROLL_ERROR.invalid)
    if (input.probe === true)
      return pair && ACTIVE.has(pair.state) ? { ok: true, probe: true } : expired
    const parsed = typeof input.publicKey === 'string' ? parseEd25519Line(input.publicKey) : null
    if (!parsed || typeof input.name !== 'string') return fail(PAIR_ENROLL_ERROR.invalid)
    // 批准公钥（clientApprovals）可选；带了就要是 32 字节的 ed25519
    if (input.approvalKey !== undefined && !isApprovalKey(input.approvalKey))
      return fail(PAIR_ENROLL_ERROR.invalid)
    const approvalKey = input.approvalKey ?? null
    if (!pair || pair.state === 'expired' || pair.state === 'cancelled') return expired
    if (pair.state !== 'waiting') return fail(PAIR_ENROLL_ERROR.used)
    pair.state = 'requested'
    pair.phoneKey = parsed.line
    pair.phone = {
      phoneId: phoneIdOf(parsed.blob),
      name: cleanPhoneName(input.name),
      fingerprint: fingerprintOf(parsed.blob),
      code: confirmCodeOf(pair.id, parsed.line, approvalKey),
      ...(approvalKey === null ? {} : { approvalKey, publicKey: parsed.line }),
    }
    pair.timers.decide = this.clock.setTimeout(() => {
      if (pair.state === 'requested') this.finish(pair, 'rejected', PAIR_ENROLL_ERROR.timeout)
    }, PAIR_DECIDE_TIMEOUT_MS)
    this.host.log(`配对 ${pair.id}：手机“${pair.phone.name}”来登记了`)
    const result = new Promise<PairEnrollOutput>((resolve) => {
      pair.enroll = resolve
    })
    this.changed(pair)
    return result
  }

  /** 已绑定的手机：钥匙文件里带 litch-mobile: 标记的行 */
  private async phones(): Promise<DevicePairPhonesResponse> {
    const seen = new Set<string>()
    const data = []
    for (const line of this.keys.lines()) {
      const phone = parsePhoneLine(line)
      if (!phone || seen.has(phone.phoneId)) continue
      seen.add(phone.phoneId)
      data.push(phone)
    }
    return { data, tailscaleSsh: await this.tailscaleSsh() }
  }

  /** 已绑定的手机变了：带全部列表通知。列表当场读，排着队发，后读的不会先到 */
  private announcePhones(): void {
    const ready = this.phones()
    this.notices = this.notices
      .then(() => ready)
      .then(
        (phones) => this.host.announce(DEVICE_PAIR_PHONES_CHANGED, phones, EXTENSION.devicePairing),
        (error: unknown) => this.host.log(`列已绑定的手机失败：${String(error)}`),
      )
  }

  private revoke(phoneId: unknown): void {
    if (!isPhoneId(phoneId)) throw new PairingError(null, 'phoneId 要是 16 位小写十六进制')
    let removed: number
    try {
      removed = this.keys.remove((line) => parsePhoneLine(line)?.phoneId === phoneId)
    } catch (error) {
      throw keysFileError(error)
    }
    if (removed === 0) throw new PairingError(DEVICE_PAIR_ERROR.unknownPhone, `没有手机 ${phoneId}`)
    this.host.log(`撤掉了手机 ${phoneId} 的钥匙`)
    this.announcePhones()
  }

  /** 配对结束：删一次性钥匙行，挂着的 enroll 拿到结果（error 是 null 表示登记成功），过一阵忘掉它 */
  private finish(
    pair: Pair,
    state: PairState,
    error: PairEnrollError | null = PAIR_ENROLL_ERROR.expired,
  ): void {
    if (!ACTIVE.has(pair.state)) return
    pair.state = state
    this.clock.clearTimeout(pair.timers.expiry)
    this.clock.clearTimeout(pair.timers.decide)
    try {
      // Tailscale 方式没写过行
      if (pair.mode === 'key') this.keys.remove((line) => isPairLine(line, pair.id))
    } catch (failure) {
      // 删不掉也无害：pair-enroll 每次都核对配对，设备进程下次启动时还会清
      this.host.log(`配对 ${pair.id} 的一次性钥匙行删不掉：${String(failure)}`)
    }
    const enroll = pair.enroll
    pair.enroll = null
    if (enroll)
      enroll(error === null ? { ok: true, phoneId: pair.phone?.phoneId ?? '' } : fail(error))
    this.host.log(`配对 ${pair.id} 结束：${state}`)
    pair.timers.forget = this.clock.setTimeout(() => this.pairs.delete(pair.id), PAIR_FORGET_MS)
    this.changed(pair)
  }

  private changed(pair: Pair): void {
    for (const wake of [...pair.waiters]) wake()
    this.host.announce(DEVICE_PAIR_CHANGED, statusOf(pair), EXTENSION.devicePairing)
  }

  private known(pairId: string): Pair {
    const pair = this.pairs.get(pairId)
    if (!pair) throw new PairingError(DEVICE_PAIR_ERROR.unknownPair, `没有配对 ${pairId}`)
    return pair
  }

  /** 设备进程关闭：还没结束的配对都取消（删行），挂着的请求都回掉 */
  close(): void {
    if (this.closed) return
    for (const pair of this.pairs.values()) {
      this.finish(pair, 'cancelled', PAIR_ENROLL_ERROR.expired)
      this.clock.clearTimeout(pair.timers.forget)
      for (const wake of [...pair.waiters]) wake()
    }
    this.pairs.clear()
    this.closed = true
  }
}

const ENROLL_MESSAGES: Record<PairEnrollError, string> = {
  expired: '二维码已过期，请在电脑上重新生成',
  used: '这个二维码已经用过了，请在电脑上重新生成',
  rejected: '电脑上拒绝了',
  timeout: '电脑上没有确认',
  invalid: '看不懂登记的内容：公钥要是 ssh-ed25519，名字要是字符串，批准公钥要是 32 字节的 base64',
  keysFile: '这台机器的钥匙文件改不了，请手动添加',
  unavailable: '连不上设备服务',
}

const fail = (error: PairEnrollError): PairEnrollOutput => ({
  ok: false,
  error,
  message: ENROLL_MESSAGES[error],
})

function statusOf(pair: Pair): PairStatus {
  return {
    pairId: pair.id,
    state: pair.state,
    expiresAt: pair.expiresAt,
    phone: pair.phone ? { ...pair.phone } : null,
  }
}

function modeOf(value: unknown): PairMode {
  if (value === undefined || value === 'key') return 'key'
  if (value === 'tailscale') return 'tailscale'
  throw new PairingError(null, 'mode 要是 key 或 tailscale')
}

function pairIdOf(params: Record<string, unknown>): string {
  if (!isPairId(params.pairId))
    throw new PairingError(DEVICE_PAIR_ERROR.unknownPair, '没有这个配对')
  return params.pairId
}

function keysFileError(error: unknown): PairingError {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof KeysFileError) return new PairingError(DEVICE_PAIR_ERROR.keysFile, message)
  return new PairingError(DEVICE_PAIR_ERROR.keysFile, `改不了钥匙文件：${message}`)
}

function currentUser(): string {
  try {
    return userInfo().username
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? ''
  }
}
