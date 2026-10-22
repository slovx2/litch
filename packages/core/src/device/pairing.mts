// 一台设备上的扫码绑定手机（协议扩展 devicePairing）在客户端这一头的样子。
// 配对和钥匙行都在设备上，核心只是转运，再加上桌面端自己的两道把关：主机钥匙核对、一次性钥匙自检。
//
// 出码（start）一步做完：本机先看 127.0.0.1:22 有没有 SSH 服务 → 设备上建配对（litch/pair/start）→
// ssh 设备拿这台桌面端 known_hosts 里这台主机的记录和设备自报的主机钥匙比（本机直接信设备报的）→
// 经外壳用系统 ssh 拿一次性钥匙试登一次（不消耗配对）。哪一步没过都把配对作废、删掉一次性钥匙行，再报原因。
// 先读手机要连的地址的 SSH 横幅定方式（pairModeOf）：是 Tailscale SSH 就用 tailscale 方式（设备不写一次性钥匙行，
// 自检改成用一把临时钥匙登那个地址、执行登记命令）；读不到横幅时按设备自报的 tailscaleSsh 和地址再定一次。
// 一次性钥匙的自检没过时再看自检连的那个地址是不是 Tailscale SSH，是就直接这样说（失败的 key 是 tailscale）。
// 要碰 ssh、文件、端口的那几样由外壳给（PairingPlatform）；没有外壳（移动端、测试）时出不了码，
// 已绑定的手机（phones）和撤销（revoke）照样能用。
//
// 数据流：pairing 主题开着（设备详情、出码对话框）才去取已绑定的手机；之后跟着 litch/pair/phones/changed。
// 配对的状态只跟这台桌面端开出来的那几个（litch/pair/changed 发给所有声明了的连接，别处开的不管）。
import {
  DEVICE_PAIR_CANCEL,
  DEVICE_PAIR_CHANGED,
  DEVICE_PAIR_DECIDE,
  DEVICE_PAIR_ERROR,
  DEVICE_PAIR_PHONES,
  DEVICE_PAIR_PHONES_CHANGED,
  DEVICE_PAIR_REVOKE,
  DEVICE_PAIR_START,
  DEVICE_PAIR_WAIT,
  type DevicePairPhonesChangedNotification,
  type DevicePairStartResponse,
  isTailnetHost,
  type PairHostKey,
  type PairMode,
  type PairPayload,
  type PairPhone,
  type PairStatus,
  pairModeOf,
} from '../../../protocol/src/device-pairing.mjs'
import type { ClientRequestMethod, ClientRequests } from '../../../protocol/src/index.mjs'
import { ChannelError, type PairingOp } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import { RpcError, type RpcRequestOptions } from '../connection/rpc.mjs'
import type { RemoteTarget } from '../model.mjs'
import type {
  PairingAddress,
  PairingStartFailure,
  PairingTarget,
  PairingTopicView,
  PairingView,
} from '../model-pairing.mjs'

/** ssh 解析出来的、这台桌面端连那台设备时实际用的地址 */
export interface PairingHostAddress {
  host: string
  port: number
  user: string
}

export interface PairSelfTestInput {
  /** 远程设备的连接配置；本机是 null（连 127.0.0.1:22） */
  target: RemoteTarget | null
  /** 本机用哪个用户登；远程设备按它自己的 ssh 配置，不看这一项 */
  user: string
  /** 一次性私钥的种子（base64url） */
  seed: string
  /** 设备报的全部主机钥匙：本机写进临时的 known_hosts */
  hostKeys: PairHostKey[]
}

/** tailscale 方式的自检：用一把临时钥匙登手机要连的地址，执行登记命令 */
export interface PairEnrollTestInput extends PairingTarget {
  /** 登记命令（start 回的 enrollCommand） */
  command: string
  /** 设备报的全部主机钥匙：写进临时的 known_hosts */
  hostKeys: PairHostKey[]
}

/**
 * 自检的结果。没过时 said 是 ssh 的原话（或者登记命令回的那一行）；
 * verifyUrl 是 Tailscale 要求在浏览器里再验证一次时给的链接（ACL 的 check 模式）
 */
export type PairSelfTestResult = { ok: true } | { ok: false; said: string; verifyUrl?: string }

/**
 * 出码要碰 ssh、文件、端口的那几样，由外壳给（apps/desktop/src/pairing.mts）。
 * 核心自己不碰 Node：没有外壳时（移动端、测试）出不了码
 */
export interface PairingPlatform {
  /** ssh 设备：用 ssh -G 解析出主机名、端口、用户 */
  resolve(target: RemoteTarget): Promise<PairingHostAddress>
  /** ssh 设备：这台桌面端 known_hosts 里这台主机的公钥，每把是“类型 base64”。没有记录是空的 */
  knownKeys(target: RemoteTarget): Promise<string[]>
  /** 本机：127.0.0.1:22 上有没有 SSH 服务（读得到 SSH- 开头的横幅） */
  localSsh(): Promise<boolean>
  /** host:port 上 SSH 服务的横幅（头一行），只连 TCP、不登录。连不上、不是 SSH 是 null */
  banner(host: string, port: number): Promise<string | null>
  /** 本机：给手机看的名字（电脑名称，没有就是主机名） */
  localName(): string
  /** 用一次性钥匙试登一次：标准输入写自检那一行，等 pair-enroll 回 {"ok":true,"probe":true} */
  selfTest(input: PairSelfTestInput): Promise<PairSelfTestResult>
  /** tailscale 方式：用临时钥匙登地址、执行登记命令，标准输入写自检那一行，等回 {"ok":true,"probe":true} */
  enrollTest(input: PairEnrollTestInput): Promise<PairSelfTestResult>
}

export interface PairingHost {
  deviceId: string
  kind: 'local' | 'ssh'
  /** 远程设备的连接配置；本机是 null */
  target(): RemoteTarget | null
  /** 远程设备的显示名：连接配置不是别名时，给手机当设备名 */
  displayName(): string
  online(): boolean
  /** 对面支不支持：它是设备服务，而且设备信息的 extensions 里列了 devicePairing */
  supported(): boolean
  /** 外壳给的那几样。没有就出不了码 */
  platform: PairingPlatform | null
  request<M extends ClientRequestMethod>(
    method: M,
    params: ClientRequests[M]['params'],
    options?: RpcRequestOptions,
  ): Promise<ClientRequests[M]['result']>
  /** 请求没做成：换成给人看的错误 */
  fail(error: unknown): ChannelError
  log(line: string): void
}

/** pairing.start 的结果，还差“预填哪个地址”（记在桌面端，由核心那一层填） */
export interface PairingStarted {
  pairId: string
  mode: PairMode
  seed: string | null
  command: string | null
  checked: boolean
  tailscaleSsh: boolean
  expiresAt: number
  hostKey: PairHostKey
  original: PairingAddress
}

export interface PairingStartOptions {
  /** 手机要连的地址：按它认方式、tailscale 方式的自检也连它。不给就用原配置 */
  address?: PairingTarget
  /** 不给就按地址认 */
  mode?: PairMode
}

export interface Pairing {
  /** 订阅。先给快照，之后给增量；返回退订函数 */
  open(sink: HostSink): () => void
  /** 连上并认出对面是谁了 */
  resync(): void
  /** 连接断了：在途的结果都不算数了 */
  offline(): void
  /** 是配对的通知就处理掉并返回 true */
  notification(method: string, params: unknown): boolean
  start(options?: PairingStartOptions): Promise<PairingStarted>
  /** 手机要连的这个地址该用哪种方式 */
  detect(host: string, port: number): Promise<PairMode>
  cancel(pairId: string): Promise<void>
  decide(pairId: string, allow: boolean): Promise<PairStatus>
  status(pairId: string): Promise<PairStatus>
  phones(): Promise<PairPhone[]>
  revoke(phoneId: string): Promise<void>
}

/** 作废了的状态：不会再变 */
const FINAL: ReadonlySet<PairStatus['state']> = new Set([
  'done',
  'expired',
  'cancelled',
  'rejected',
])

/** “类型 base64”，去掉注释和多余的空白；不像公钥的是 null */
const keyOf = (line: string): string | null => {
  const [type, body] = line.trim().split(/\s+/)
  return type && body ? `${type} ${body}` : null
}

/** 二维码里的东西：这张码加上给手机的地址。两种方式各带各的（种子，或者登记命令） */
export function pairingPayload(pairing: PairingView, address: PairingAddress): PairPayload {
  const base = {
    v: 1 as const,
    n: address.name,
    h: address.host,
    p: address.port,
    u: address.user,
    k: { t: pairing.hostKey.type, f: pairing.hostKey.fingerprint },
    i: pairing.pairId,
    e: pairing.expiresAt,
  }
  return pairing.mode === 'tailscale'
    ? { ...base, m: 'tailscale', c: pairing.command ?? '' }
    : { ...base, s: pairing.seed ?? '' }
}

/** 设备自报的主机钥匙里有没有一把和桌面端 known_hosts 里记的一样 */
export function hostKeyTrusted(
  reported: readonly PairHostKey[],
  known: readonly string[],
): boolean {
  const trusted = new Set(known.map(keyOf).filter((key): key is string => key !== null))
  return reported.some((entry) => {
    const key = keyOf(entry.publicKey)
    return key !== null && trusted.has(key)
  })
}

/** 设备回的这个扩展自己的错误：原因在 error.data.reason 里 */
const pairFault = (error: unknown): string | null => {
  if (!(error instanceof RpcError)) return null
  const reason = (error.data as { reason?: unknown } | null | undefined)?.reason
  return typeof reason === 'string' && Object.values(DEVICE_PAIR_ERROR).includes(reason as never)
    ? reason
    : null
}

/** 出码失败：错误码按种类，key 是 PairingStartFailure，message 是原话（自检失败时是 ssh 说的） */
const startFailure = (key: PairingStartFailure, message: string): ChannelError =>
  new ChannelError(
    key === 'offline' ? 'offline' : key === 'unsupported' ? 'unsupported' : 'rejected',
    message,
    undefined,
    { key },
  )

export function createPairing(host: PairingHost): Pairing {
  const { deviceId } = host
  const sinks = new Set<HostSink>()
  /** null：还没连上过，不知道 */
  let available: boolean | null = null
  /** 已绑定的手机。null：还没取到 */
  let phones: PairPhone[] | null = null
  /** 设备自报开着 Tailscale SSH（phones、start 的结果里带）。null：还没取到 */
  let tailscale: boolean | null = null
  /** 正在取已绑定的手机：同时要的搭一趟车 */
  let loading: Promise<PairPhone[]> | null = null
  /** 这台桌面端开出来的配对，按开的先后 */
  const pairs = new Map<string, PairStatus>()
  /** 每次断开、重新认对面时换一个代号，在途的结果回来时对不上就作废 */
  let epoch = 0

  const view = (): PairingTopicView => ({
    deviceId,
    available,
    phones: phones ? [...phones] : null,
    tailscale,
    pairs: [...pairs.values()],
  })

  const publish = (ops: PairingOp[]) => {
    for (const sink of sinks) sink.delta(ops)
  }

  const snapshotAll = () => {
    const data = view()
    for (const sink of sinks) sink.snapshot(data)
  }

  const reachable = () => {
    if (!host.online())
      throw new ChannelError('offline', '设备未连接', undefined, { key: 'offline' })
    if (!host.supported()) {
      throw new ChannelError('unsupported', '此设备的服务版本不支持扫码绑定手机', undefined, {
        key: 'unsupported',
      })
    }
  }

  /** 设备回的错误换成界面能用的形状 */
  const failure = (error: unknown): ChannelError => {
    const message = error instanceof Error ? error.message : String(error)
    switch (pairFault(error)) {
      case DEVICE_PAIR_ERROR.unknownPair:
      case DEVICE_PAIR_ERROR.unknownPhone:
        return new ChannelError('notFound', message)
      case DEVICE_PAIR_ERROR.notRequested:
        return new ChannelError('rejected', message)
      case DEVICE_PAIR_ERROR.keysFile:
        return startFailure('keysFile', message)
      case DEVICE_PAIR_ERROR.noHostKey:
        return startFailure('noHostKey', message)
      case DEVICE_PAIR_ERROR.unsupported:
        return startFailure('unsupported', message)
      default:
        return host.fail(error)
    }
  }

  const guarded = async <T,>(run: () => Promise<T>): Promise<T> => {
    reachable()
    try {
      return await run()
    } catch (error) {
      throw failure(error)
    }
  }

  /** 记下一个配对的新状态。不是这台桌面端开的不要；作废了的不会再活过来。返回换上了没有 */
  const keepStatus = (status: PairStatus): boolean => {
    const was = pairs.get(status.pairId)
    if (!was) return false
    if (FINAL.has(was.state) && !FINAL.has(status.state)) return false
    pairs.set(status.pairId, status)
    return true
  }

  const settleStatus = (status: PairStatus): PairStatus => {
    if (keepStatus(status)) publish([{ op: 'pair.status', status }])
    return pairs.get(status.pairId) ?? status
  }

  const setPhones = (next: PairPhone[], nextTailscale = tailscale === true) => {
    phones = [...next]
    tailscale = nextTailscale
    publish([{ op: 'phones.set', phones: [...next], tailscale: nextTailscale }])
  }

  const loadPhones = (): Promise<PairPhone[]> => {
    if (loading) return loading
    const mine = epoch
    const run = guarded(() => host.request(DEVICE_PAIR_PHONES, {})).then((result) => {
      // 老的设备服务不带 tailscaleSsh：当作没开
      if (mine === epoch) setPhones(result.data, result.tailscaleSsh === true)
      return result.data
    })
    loading = run
    const clear = () => {
      if (loading === run) loading = null
    }
    run.then(clear, clear)
    return run
  }

  /** 重连之后：还没作废的配对现在是什么样了（设备进程可能重启过，那就都没了） */
  const refreshPairs = () => {
    const mine = epoch
    for (const status of pairs.values()) {
      if (FINAL.has(status.state)) continue
      host.request(DEVICE_PAIR_WAIT, { pairId: status.pairId, since: null }).then(
        (next) => {
          if (mine === epoch) settleStatus(next)
        },
        (error: unknown) => {
          if (mine !== epoch) return
          if (pairFault(error) === DEVICE_PAIR_ERROR.unknownPair) {
            settleStatus({ ...status, state: 'expired', phone: null })
          } else host.log(`取配对状态失败：${String(error)}`)
        },
      )
    }
  }

  /** 设备上的配对作废掉（出码途中哪一步没过）。作废不成只记一笔：钥匙行到期自己没用了，设备也会清 */
  const discard = (pairId: string) => {
    host
      .request(DEVICE_PAIR_CANCEL, { pairId })
      .catch((error: unknown) => host.log(`作废配对失败：${String(error)}`))
  }

  /**
   * 手机要连的地址上的横幅。本机不读：电脑连自己的 tailnet 地址走的是回环，到的是系统的 sshd、不经 tailscaled，
   * 读到的不算数（song-debian 上实测），只看设备自报
   */
  const bannerOf = (
    platform: PairingPlatform,
    at: { host: string; port: number },
  ): Promise<string | null> =>
    host.kind === 'local' ? Promise.resolve(null) : platform.banner(at.host, at.port)

  /** tailscale 方式的自检：横幅读不到（这台电脑连不到手机要连的地址，或者是本机）就跳过，返回 false */
  const vetEnroll = async (
    platform: PairingPlatform,
    started: DevicePairStartResponse,
    phoneAt: PairingTarget,
    banner: string | null,
  ): Promise<boolean> => {
    if (started.mode !== 'tailscale') return true
    if (banner === null) return false
    const tested = await platform.enrollTest({
      ...phoneAt,
      command: started.enrollCommand,
      hostKeys: started.hostKeys,
    })
    if (tested.ok) return true
    if (tested.verifyUrl) throw startFailure('verify', tested.verifyUrl)
    throw startFailure('selfTest', tested.said)
  }

  /** 出码时 ssh 设备那一段：核对主机钥匙、自检。返回原配置和自检做了没有 */
  const vetRemote = async (
    platform: PairingPlatform,
    target: RemoteTarget,
    resolved: PairingHostAddress,
    started: DevicePairStartResponse,
    phoneAt: PairingTarget,
    banner: string | null,
  ): Promise<{ original: PairingAddress; checked: boolean }> => {
    const known = await platform.knownKeys(target)
    if (!hostKeyTrusted(started.hostKeys, known)) {
      throw startFailure(
        'hostKeyMismatch',
        known.length === 0
          ? '本机的 known_hosts 中没有该主机的记录'
          : '本机连接到的主机密钥与该设备自报的不一致',
      )
    }
    const original = {
      name: target.kind === 'alias' ? target.alias : host.displayName(),
      host: resolved.host,
      port: resolved.port,
      user: resolved.user,
    }
    if (started.mode === 'tailscale') {
      return { original, checked: await vetEnroll(platform, started, phoneAt, banner) }
    }
    const tested = await platform.selfTest({
      target,
      user: resolved.user,
      seed: started.seed,
      hostKeys: started.hostKeys,
    })
    if (tested.ok) return { original, checked: true }
    // 自检连的是这台桌面端自己的配置：那个地址由 Tailscale SSH 接管时强制命令不生效，直接这样说
    const same = resolved.host === phoneAt.host && resolved.port === phoneAt.port
    const at = same ? banner : await platform.banner(resolved.host, resolved.port)
    if (pairModeOf(at, started.tailscaleSsh === true, resolved.host) === 'tailscale') {
      throw startFailure('tailscale', tested.said)
    }
    throw startFailure('selfTest', tested.said)
  }

  /** 出码时本机那一段：主机钥匙直接信设备报的，一次性钥匙的自检连 127.0.0.1:22 */
  const vetLocal = async (
    platform: PairingPlatform,
    started: DevicePairStartResponse,
    phoneAt: PairingTarget | null,
    banner: string | null,
  ): Promise<{ original: PairingAddress; checked: boolean }> => {
    const original = {
      name: platform.localName(),
      host: started.hostname,
      port: 22,
      user: started.user,
    }
    if (started.mode === 'tailscale') {
      const at = phoneAt ?? { host: original.host, port: original.port, user: original.user }
      return { original, checked: await vetEnroll(platform, started, at, banner) }
    }
    const tested = await platform.selfTest({
      target: null,
      user: started.user,
      seed: started.seed,
      hostKeys: started.hostKeys,
    })
    if (!tested.ok) throw startFailure('selfTest', tested.said)
    return { original, checked: true }
  }

  /** 设备上建一个配对。要 tailscale 方式而设备回的不是，说明设备服务太旧 */
  const create = async (mode: PairMode | null): Promise<DevicePairStartResponse> => {
    const started = await guarded(() =>
      host.request(DEVICE_PAIR_START, mode === 'tailscale' ? { mode } : {}),
    )
    tailscale = started.tailscaleSsh === true
    if (mode === 'tailscale' && started.mode !== 'tailscale') {
      discard(started.pairId)
      throw startFailure('unsupported', '此设备的服务版本不支持 Tailscale 方式出码，请先升级')
    }
    return started
  }

  return {
    open(sink) {
      sinks.add(sink)
      sink.snapshot(view())
      if (phones === null && host.online() && host.supported()) {
        loadPhones().catch((error: unknown) => host.log(`取已绑定的手机失败：${String(error)}`))
      }
      return () => {
        sinks.delete(sink)
        // 没人看了：作废了的配对不用再留着
        if (sinks.size > 0) return
        for (const [pairId, status] of pairs) if (FINAL.has(status.state)) pairs.delete(pairId)
      }
    },

    resync() {
      epoch++
      loading = null
      available = host.supported()
      phones = null
      tailscale = null
      snapshotAll()
      if (!available) return
      refreshPairs()
      if (sinks.size > 0) {
        loadPhones().catch((error: unknown) => host.log(`取已绑定的手机失败：${String(error)}`))
      }
    },

    offline() {
      epoch++
      loading = null
    },

    notification(method, params) {
      if (method === DEVICE_PAIR_CHANGED) {
        settleStatus(params as PairStatus)
        return true
      }
      if (method === DEVICE_PAIR_PHONES_CHANGED) {
        const changed = params as DevicePairPhonesChangedNotification
        setPhones(changed.data, changed.tailscaleSsh === true)
        return true
      }
      return false
    },

    async start(options = {}) {
      reachable()
      const { platform } = host
      if (!platform) {
        throw startFailure('unsupported', '此客户端无法生成二维码：没有可调用 ssh 的外壳')
      }
      const target = host.target()
      if (host.kind === 'ssh' && !target) throw startFailure('unsupported', '该设备没有连接配置')
      let resolved: PairingHostAddress | null = null
      if (target) {
        try {
          resolved = await platform.resolve(target)
        } catch (error) {
          throw startFailure('selfTest', error instanceof Error ? error.message : String(error))
        }
      }
      // 手机要连的地址：给了就用，否则原配置。本机的原配置要等设备报主机名，这时先不认方式
      const phoneAt = options.address ?? resolved
      const banner = phoneAt ? await bannerOf(platform, phoneAt) : null
      // 横幅读不到、地址又是 tailnet 的：要看设备自报，先按一次性钥匙建，回来再定
      const mode: PairMode | null =
        options.mode ??
        (banner !== null
          ? pairModeOf(banner, false, phoneAt?.host ?? '')
          : phoneAt && isTailnetHost(phoneAt.host)
            ? null
            : 'key')
      if (host.kind === 'local' && mode === 'key' && !(await platform.localSsh())) {
        throw startFailure('sshOff', '127.0.0.1:22 上没有 SSH 服务')
      }
      let started = await create(mode)
      if (mode === null) {
        // 设备开着 Tailscale SSH：换成 tailscale 方式重新建
        if (tailscale === true) {
          discard(started.pairId)
          started = await create('tailscale')
        } else if (host.kind === 'local' && !(await platform.localSsh())) {
          discard(started.pairId)
          throw startFailure('sshOff', '127.0.0.1:22 上没有 SSH 服务')
        }
      }
      pairs.set(started.pairId, {
        pairId: started.pairId,
        state: 'waiting',
        expiresAt: started.expiresAt,
        phone: null,
      })
      try {
        const vetted =
          target && resolved
            ? await vetRemote(platform, target, resolved, started, phoneAt ?? resolved, banner)
            : await vetLocal(platform, started, phoneAt, banner)
        publish([{ op: 'pair.status', status: pairs.get(started.pairId) as PairStatus }])
        return {
          pairId: started.pairId,
          mode: started.mode === 'tailscale' ? 'tailscale' : 'key',
          seed: started.mode === 'tailscale' ? null : started.seed,
          command: started.mode === 'tailscale' ? started.enrollCommand : null,
          checked: vetted.checked,
          tailscaleSsh: started.tailscaleSsh === true,
          expiresAt: started.expiresAt,
          hostKey: started.hostKey,
          original: vetted.original,
        }
      } catch (error) {
        pairs.delete(started.pairId)
        discard(started.pairId)
        if (error instanceof ChannelError) throw error
        throw startFailure('selfTest', error instanceof Error ? error.message : String(error))
      }
    },

    async detect(at, port) {
      const { platform } = host
      if (!platform) return 'key'
      return pairModeOf(await bannerOf(platform, { host: at, port }), tailscale === true, at)
    },

    async cancel(pairId) {
      const known = pairs.get(pairId)
      if (known && FINAL.has(known.state)) return
      try {
        await guarded(() => host.request(DEVICE_PAIR_CANCEL, { pairId }))
      } catch (error) {
        // 设备上早就没有了（过期清掉了、设备进程重启过）：当作已经作废
        if (!(error instanceof ChannelError) || error.code !== 'notFound') throw error
      }
      if (known) settleStatus({ ...known, state: 'cancelled' })
    },

    async decide(pairId, allow) {
      const status = await guarded(() => host.request(DEVICE_PAIR_DECIDE, { pairId, allow }))
      return settleStatus(status)
    },

    async status(pairId) {
      const known = pairs.get(pairId)
      if (known && (FINAL.has(known.state) || host.online())) return known
      const status = await guarded(() => host.request(DEVICE_PAIR_WAIT, { pairId, since: null }))
      return settleStatus(status)
    },

    phones: () => loadPhones(),

    async revoke(phoneId) {
      await guarded(() => host.request(DEVICE_PAIR_REVOKE, { phoneId }))
      // 对面随后也会发通知；这边先改，不等
      if (phones?.some((phone) => phone.phoneId === phoneId)) {
        setPhones(phones.filter((phone) => phone.phoneId !== phoneId))
      }
    },
  }
}
