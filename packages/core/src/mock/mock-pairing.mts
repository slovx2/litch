// 模拟核心的扫码绑定手机：出码、等扫码、手机来登记（带确认码）、允许或拒绝、已绑定的手机、撤销、记住地址。
// 行为照真的核心和设备服务：一个配对只接受一部手机、作废了的不会再变、到期自己作废；
// 出码之后隔一会儿就“有一部手机来登记”，不用真的扫。没连上的设备出码以 offline 结束，
// 不支持的（只有原生 codex 的）以 unsupported 结束。主机钥匙核对和自检这里不演，总是过。
import { PAIR_DECIDE_TIMEOUT_MS, PAIR_TTL_MS } from '../../../protocol/src/device-pairing.mjs'
import { ChannelError, type Clock, type Commands, type PairingOp } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import { checkPairingAddress } from '../device/remote.mjs'
import type { DeviceView } from '../model.mjs'
import type {
  PairingAddress,
  PairingTopicView,
  PairingView,
  PairPhone,
  PairStatus,
} from '../model-pairing.mjs'
import type { SampleLang } from './sample-text.mjs'

export interface MockPairingHost {
  clock: Clock
  /** 演的时候每一步隔多久的基数；0 表示不拖时间 */
  stepMs: number
  /** 一个码多久作废。默认和真的一样十分钟 */
  ttlMs?: number
  lang: SampleLang
  device(deviceId: string): DeviceView | undefined
}

export interface MockPairing {
  subscribe(deviceId: string, sink: HostSink): () => void
  /** 是扫码绑定的命令就处理；不是就返回 undefined，交给别处 */
  command(name: string, params: unknown): Promise<unknown> | undefined
}

const NAMES: readonly string[] = [
  'pairing.start',
  'pairing.cancel',
  'pairing.decide',
  'pairing.status',
  'pairing.rememberAddress',
  'pairing.phones',
  'pairing.revoke',
]

const DAY = 24 * 60 * 60 * 1000
const FINAL: ReadonlySet<PairStatus['state']> = new Set([
  'done',
  'expired',
  'cancelled',
  'rejected',
])

/** 示例里的主机钥匙：只是长得像，二维码扫出来也连不上什么 */
const HOST_KEY = {
  type: 'ssh-ed25519',
  fingerprint: 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU',
  publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** 照着一个数造一串像样的字：同一个数造出来的一样，好让截图稳定 */
const made = (seq: number, length: number, alphabet: string): string => {
  let out = ''
  let n = seq * 2654435761
  for (let i = 0; i < length; i++) {
    n = (n * 1103515245 + 12345) % 2147483648
    out += alphabet[n % alphabet.length]
  }
  return out
}

/** 示例设备“原配置”的地址：本机用电脑名，远程设备用别名和 ssh -G 会解析出的那几项 */
const originalOf = (device: DeviceView, lang: SampleLang): PairingAddress => {
  if (device.kind === 'local') {
    return {
      name: lang === 'en' ? 'Dev MacBook' : '开发用的 MacBook',
      host: 'macbook.local',
      port: 22,
      user: 'dev',
    }
  }
  const target = device.target
  if (target?.kind === 'host') {
    return {
      name: typeof device.name === 'string' ? device.name : target.host,
      host: target.host,
      port: target.port ?? 22,
      user: target.user ?? 'dev',
    }
  }
  const alias = target?.alias ?? device.host
  return { name: alias, host: device.id === 'build' ? '10.0.3.11' : alias, port: 22, user: 'dev' }
}

interface DevicePairing {
  phones: PairPhone[]
  pairs: Map<string, PairStatus>
  sinks: Set<HostSink>
  remembered: PairingAddress | null
}

export function createMockPairing(host: MockPairingHost): MockPairing {
  const { clock } = host
  const ttl = host.ttlMs ?? PAIR_TTL_MS
  const states = new Map<string, DevicePairing>()
  let seq = 0
  /** 每个配对的定时器（手机来登记、到期），作废了就撤 */
  const timers = new Map<string, (() => void)[]>()

  const stateOf = (deviceId: string): DevicePairing => {
    let state = states.get(deviceId)
    if (!state) {
      const now = clock.now()
      state = {
        // build-01 上早就绑过一部手机
        phones:
          deviceId === 'build'
            ? [
                {
                  phoneId: 'a1b2c3d4e5f60718',
                  name: 'Pixel 8',
                  fingerprint: 'SHA256:k3YH0oTq7z1mXbN2f9Wc8a5Lr4Ue6Js0Pv1Gd2Hi3Kl',
                  addedAt: now - 12 * DAY,
                },
              ]
            : [],
        pairs: new Map(),
        sinks: new Set(),
        remembered: null,
      }
      states.set(deviceId, state)
    }
    return state
  }

  const deviceOf = (deviceId: string): DeviceView => {
    const device = host.device(deviceId)
    if (!device) throw new ChannelError('notFound', `没有这台设备：${deviceId}`)
    return device
  }

  const usable = (deviceId: string): DeviceView => {
    const device = deviceOf(deviceId)
    if (device.connection !== 'online') {
      throw new ChannelError('offline', '设备没有连上', undefined, { key: 'offline' })
    }
    if (!device.pairing) {
      throw new ChannelError('unsupported', '这台设备的服务版本不支持扫码绑定手机', undefined, {
        key: 'unsupported',
      })
    }
    return device
  }

  const publish = (deviceId: string, ops: PairingOp[]) => {
    for (const sink of stateOf(deviceId).sinks) sink.delta(ops)
  }

  const stopTimers = (pairId: string) => {
    for (const stop of timers.get(pairId) ?? []) stop()
    timers.delete(pairId)
  }

  const setStatus = (deviceId: string, status: PairStatus) => {
    stateOf(deviceId).pairs.set(status.pairId, status)
    if (FINAL.has(status.state)) stopTimers(status.pairId)
    publish(deviceId, [{ op: 'pair.status', status }])
  }

  const pairOf = (deviceId: string, pairId: string): PairStatus => {
    const status = stateOf(deviceId).pairs.get(pairId)
    if (!status) throw new ChannelError('notFound', '没有这个配对')
    return status
  }

  /**
   * 出码之后隔一会儿就有一部“手机”来登记。和设备一样：到期只作废还在等扫码的；
   * 手机已经来请求的不因到期打断，两分钟没人表态才判拒绝。
   */
  const schedule = (deviceId: string, pairId: string) => {
    const arrive = clock.setTimer(
      () => {
        const status = stateOf(deviceId).pairs.get(pairId)
        if (status?.state !== 'waiting') return
        const n = ++seq
        setStatus(deviceId, {
          ...status,
          state: 'requested',
          phone: {
            phoneId: made(n, 16, '0123456789abcdef'),
            name: host.lang === 'en' ? 'Pixel 9' : '小米 15',
            fingerprint: `SHA256:${made(n, 43, B64URL.replace('-', '+').replace('_', '/'))}`,
            code: made(n, 6, '0123456789'),
          },
        })
        const timeout = clock.setTimer(() => {
          const asked = stateOf(deviceId).pairs.get(pairId)
          if (asked?.state === 'requested') setStatus(deviceId, { ...asked, state: 'rejected' })
        }, PAIR_DECIDE_TIMEOUT_MS)
        timers.get(pairId)?.push(timeout)
      },
      Math.max(host.stepMs * 80, 1),
    )
    const expire = clock.setTimer(() => {
      const status = stateOf(deviceId).pairs.get(pairId)
      if (status?.state === 'waiting')
        setStatus(deviceId, { ...status, state: 'expired', phone: null })
    }, ttl)
    timers.set(pairId, [arrive, expire])
  }

  const view = (deviceId: string): PairingTopicView => {
    const device = host.device(deviceId)
    const state = stateOf(deviceId)
    const online = device?.connection === 'online'
    return {
      deviceId,
      available: device ? device.pairing : null,
      phones: online && device?.pairing ? [...state.phones] : null,
      pairs: [...state.pairs.values()],
    }
  }

  const handle = async (name: string, params: unknown): Promise<unknown> => {
    switch (name) {
      case 'pairing.start': {
        const { deviceId } = params as Commands['pairing.start']['params']
        const device = usable(deviceId)
        const state = stateOf(deviceId)
        const n = ++seq
        const status: PairStatus = {
          pairId: made(n, 16, ALNUM),
          state: 'waiting',
          expiresAt: clock.now() + ttl,
          phone: null,
        }
        setStatus(deviceId, status)
        schedule(deviceId, status.pairId)
        const original = originalOf(device, host.lang)
        const pairing: PairingView = {
          deviceId,
          pairId: status.pairId,
          seed: made(n, 43, B64URL),
          expiresAt: status.expiresAt,
          hostKey: { ...HOST_KEY },
          address: state.remembered ? { ...state.remembered } : { ...original },
          original,
        }
        return { pairing }
      }
      case 'pairing.cancel': {
        const { deviceId, pairId } = params as Commands['pairing.cancel']['params']
        usable(deviceId)
        const status = stateOf(deviceId).pairs.get(pairId)
        if (status && !FINAL.has(status.state)) {
          setStatus(deviceId, { ...status, state: 'cancelled' })
        }
        return {}
      }
      case 'pairing.decide': {
        const { deviceId, pairId, allow } = params as Commands['pairing.decide']['params']
        usable(deviceId)
        const status = pairOf(deviceId, pairId)
        if (status.state !== 'requested' || !status.phone) {
          throw new ChannelError('rejected', '现在没有等着允许的手机')
        }
        if (!allow) {
          const next: PairStatus = { ...status, state: 'rejected' }
          setStatus(deviceId, next)
          return { status: next }
        }
        const next: PairStatus = { ...status, state: 'done' }
        setStatus(deviceId, next)
        const state = stateOf(deviceId)
        const { phoneId, name: phoneName, fingerprint } = status.phone
        state.phones = [
          ...state.phones.filter((phone) => phone.phoneId !== phoneId),
          { phoneId, name: phoneName, fingerprint, addedAt: clock.now() },
        ]
        publish(deviceId, [{ op: 'phones.set', phones: [...state.phones] }])
        return { status: next }
      }
      case 'pairing.status': {
        const { deviceId, pairId } = params as Commands['pairing.status']['params']
        return { status: pairOf(deviceId, pairId) }
      }
      case 'pairing.rememberAddress': {
        const { deviceId, address } = params as Commands['pairing.rememberAddress']['params']
        deviceOf(deviceId)
        if (address === null) {
          stateOf(deviceId).remembered = null
          return {}
        }
        const checked = checkPairingAddress(address)
        if (!checked) {
          throw new ChannelError('invalid', '给手机的地址不对', undefined, { key: 'address' })
        }
        stateOf(deviceId).remembered = checked
        return {}
      }
      case 'pairing.phones': {
        const { deviceId } = params as Commands['pairing.phones']['params']
        usable(deviceId)
        return { phones: [...stateOf(deviceId).phones] }
      }
      case 'pairing.revoke': {
        const { deviceId, phoneId } = params as Commands['pairing.revoke']['params']
        usable(deviceId)
        const state = stateOf(deviceId)
        if (!state.phones.some((phone) => phone.phoneId === phoneId)) {
          throw new ChannelError('notFound', '没有这部手机')
        }
        state.phones = state.phones.filter((phone) => phone.phoneId !== phoneId)
        publish(deviceId, [{ op: 'phones.set', phones: [...state.phones] }])
        return {}
      }
    }
    return undefined
  }

  return {
    subscribe(deviceId, sink) {
      deviceOf(deviceId)
      const state = stateOf(deviceId)
      state.sinks.add(sink)
      sink.snapshot(view(deviceId))
      return () => {
        state.sinks.delete(sink)
        if (state.sinks.size > 0) return
        for (const [pairId, status] of state.pairs) {
          if (FINAL.has(status.state)) state.pairs.delete(pairId)
        }
      }
    },

    command(name, params) {
      if (!NAMES.includes(name)) return undefined
      return handle(name, params)
    },
  }
}
