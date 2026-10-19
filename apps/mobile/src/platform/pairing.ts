// 扫码绑定手机这一头的流程（三方怎么配合写在 packages/protocol/src/device-pairing.mts 开头）：
// 认配对文本 → 生成手机自己的钥匙 → 用二维码里的一次性钥匙登进去执行登记（钉住二维码里的主机指纹、只协商那一种算法），
// 期间显示确认码等电脑上允许 → 记下主机指纹（不再弹首次确认）→ 用自己的钥匙走原来的检查和添加。
// 这里不碰界面和原生模块，用到的都经 PairDeps 交进来，单元测试拿假的跑。
import type { RemoteCheck, RemoteTarget } from '@litch/core'
import {
  decodePairPayload,
  PAIR_ENROLL_ERROR,
  PAIR_PAYLOAD_PREFIX,
  PAIR_PHONE_NAME_MAX,
  type PairEnrollError,
  type PairPayload,
} from '../../../../packages/protocol/src/device-pairing.mts'
import type { HostKey, SshTarget } from '../../modules/litch-ssh/src'
import { sshProblem } from './ssh-errors'

export type { PairPayload }

/** 一段文字认成配对文本。不是配对文本、格式坏了都是 notPair；过期另说，让界面照样把地址给人看 */
export type ParsedPair =
  | { ok: true; payload: PairPayload; expired: boolean }
  | { ok: false; reason: 'notPair' }

export function parsePairText(text: string, now: number): ParsedPair {
  const payload = decodePairPayload(text)
  if (!payload) return { ok: false, reason: 'notPair' }
  return { ok: true, payload, expired: payload.e <= now }
}

/** 扫码时先用前缀筛一道：别的二维码（网址、Wi-Fi）不理，也不提示 */
export const looksLikePair = (text: string): boolean => text.trim().startsWith(PAIR_PAYLOAD_PREFIX)

/**
 * 没成的原因。前七种是 pair-enroll 回的（PAIR_ENROLL_ERROR），后面几种是手机这头看到的：
 * refused 一次性钥匙登不进去（用过、过期之后那一行被删了，或者对面的 sshd 不认）；hostKey 主机指纹对不上；
 * unreachable 连不上二维码里的地址；noAnswer 登进去了但对面没给出登记结果；unknown 别的
 */
export type PairProblem =
  | PairEnrollError
  | 'refused'
  | 'hostKey'
  | 'unreachable'
  | 'noAnswer'
  | 'unknown'

const ENROLL_ERRORS = new Set<string>(Object.values(PAIR_ENROLL_ERROR))

/** 读 pair-enroll 写回的那一行。读不懂是 null */
export function parseEnrollOutput(
  line: string,
): { ok: true } | { ok: false; problem: PairProblem; message: string } | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.ok === true) return { ok: true }
  if (v.ok !== false) return null
  const error = typeof v.error === 'string' && ENROLL_ERRORS.has(v.error) ? v.error : 'unknown'
  return {
    ok: false,
    problem: error as PairProblem,
    message: typeof v.message === 'string' ? v.message : '',
  }
}

/** SSH 模块抛的错认成原因 */
export function enrollFailure(error: unknown): { problem: PairProblem; detail: string } {
  const { kind, message } = sshProblem(error)
  switch (kind) {
    case 'auth':
      return { problem: 'refused', detail: message }
    case 'hostKeyChanged':
    case 'hostKeyUnknown':
      return { problem: 'hostKey', detail: message }
    case 'enroll':
      return { problem: 'noAnswer', detail: message }
    case 'unreachable':
    case null:
      return { problem: 'unreachable', detail: message }
    default:
      return { problem: 'unknown', detail: message }
  }
}

/** 用一次性钥匙登进去的连接配置 */
export function enrollTarget(payload: PairPayload): SshTarget {
  return {
    host: payload.h,
    port: payload.p,
    user: payload.u,
    privateKey: '',
    passphrase: '',
    seed: payload.s,
    hostKeyType: payload.k.t,
    hostFingerprint: payload.k.f,
  }
}

/** 公钥行只要前两段（类型和 base64），不带注释：确认码、登记都按这个算 */
export const keyLine = (publicKey: string): string =>
  publicKey.trim().split(/\s+/).slice(0, 2).join(' ')

/** 写进 pair-enroll 标准输入的那一行（PairEnrollInput） */
export function enrollLine(publicKey: string, phoneName: string): string {
  return JSON.stringify({ v: 1, publicKey: keyLine(publicKey), name: phoneName })
}

/**
 * 手机名：安卓给“厂商 型号”（型号里已经带着厂商就不重复），iOS 只拿得到系统名。
 * 去掉控制字符、截到对面收的长度
 */
export function phoneNameOf(constants: Record<string, unknown>, os: string): string {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  let name = ''
  if (os === 'android') {
    const maker = text(constants.Manufacturer) || text(constants.Brand)
    const model = text(constants.Model)
    name = model.toLowerCase().startsWith(maker.toLowerCase()) ? model : `${maker} ${model}`.trim()
  } else if (os === 'ios') {
    name = text(constants.systemName) || 'iPhone'
  }
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return (name || 'Litch').slice(0, PAIR_PHONE_NAME_MAX)
}

/** 流程走到了哪：生成钥匙、等电脑上允许（带确认码）、用自己的钥匙检查、添加 */
export type PairStep =
  | { step: 'key' }
  | { step: 'enroll'; code: string }
  | { step: 'check' }
  | { step: 'add' }

export type PairResult =
  /** checked 为 false：登记成了、设备也加了，但用自己的钥匙没连上（原因在 failure 里，设备详情里能重试） */
  | { ok: true; deviceId: string; checked: boolean }
  | { ok: false; problem: PairProblem; detail: string | null }

export interface PairDeps {
  /** 生成并存下手机自己的钥匙 */
  makeKey(): Promise<{ id: string; publicKey: string }>
  /** 登记没成时删掉刚生成的钥匙 */
  dropKey(id: string): Promise<void>
  confirmCode(pairId: string, publicKey: string): Promise<string>
  enroll(target: SshTarget, line: string): Promise<string>
  trust(host: string, port: number, key: HostKey): void
  check(target: RemoteTarget): Promise<RemoteCheck>
  add(name: string, target: RemoteTarget): Promise<string>
  phoneName: string
}

export async function runPairing(
  payload: PairPayload,
  deps: PairDeps,
  onStep: (step: PairStep) => void,
): Promise<PairResult> {
  onStep({ step: 'key' })
  const key = await deps.makeKey()
  let enrolled = false
  try {
    const code = await deps.confirmCode(payload.i, keyLine(key.publicKey))
    onStep({ step: 'enroll', code })
    let line: string
    try {
      line = await deps.enroll(enrollTarget(payload), enrollLine(key.publicKey, deps.phoneName))
    } catch (error) {
      const { problem, detail } = enrollFailure(error)
      return { ok: false, problem, detail }
    }
    const output = parseEnrollOutput(line)
    if (!output) return { ok: false, problem: 'noAnswer', detail: line.slice(0, 2000) }
    if (!output.ok) return { ok: false, problem: output.problem, detail: output.message || null }
    enrolled = true
  } finally {
    if (!enrolled) await deps.dropKey(key.id).catch(() => {})
  }

  // 主机指纹由已经认证过的电脑放进二维码，登记时又钉过一次：直接记下，不再问
  deps.trust(payload.h, payload.p, { fingerprint: payload.k.f, keyType: payload.k.t })
  const target: RemoteTarget = {
    kind: 'host',
    host: payload.h,
    port: payload.p === 22 ? null : payload.p,
    user: payload.u,
    keyFile: key.id,
  }
  onStep({ step: 'check' })
  let checked = false
  try {
    checked = (await deps.check(target)).ok
  } catch {
    checked = false
  }
  onStep({ step: 'add' })
  try {
    const deviceId = await deps.add(payload.n.trim() || payload.h, target)
    return { ok: true, deviceId, checked }
  } catch (error) {
    return {
      ok: false,
      problem: 'unknown',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 删设备时在那台机器上撤这部手机的钥匙，结果怎样 */
export type RevokeOutcome =
  /** 撤掉了 */
  | { kind: 'revoked' }
  /** 那台机器上没有登记这把钥匙（手动加的设备、或者已经撤过了），不用撤 */
  | { kind: 'none' }
  /** 设备没连上，没试 */
  | { kind: 'offline' }
  | { kind: 'failed'; reason: string }

export interface RevokeDeps {
  online: boolean
  /** 这台设备用的钥匙的指纹；手机上已经没有这把钥匙时是 null */
  fingerprint: string | null
  phones(): Promise<{ phoneId: string; fingerprint: string }[]>
  revoke(phoneId: string): Promise<void>
}

/** 按自己钥匙的指纹在已绑定的手机里找到自己，撤掉那一行 */
export async function revokeOwnKey(deps: RevokeDeps): Promise<RevokeOutcome> {
  if (!deps.fingerprint) return { kind: 'none' }
  if (!deps.online) return { kind: 'offline' }
  try {
    const mine = (await deps.phones()).filter((phone) => phone.fingerprint === deps.fingerprint)
    if (mine.length === 0) return { kind: 'none' }
    for (const phone of mine) await deps.revoke(phone.phoneId)
    return { kind: 'revoked' }
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}
