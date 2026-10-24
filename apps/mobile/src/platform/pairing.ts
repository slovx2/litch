// 扫码绑定手机这一头的流程（三方怎么配合写在 packages/protocol/src/device-pairing.mts 开头）：
// 认配对文本 → 生成手机自己的钥匙 → 用二维码里的一次性钥匙登进去执行登记（钉住二维码里的主机指纹、只协商那一种算法），
// 期间显示确认码等电脑上允许 → 记下主机指纹（不再弹首次确认）→ 用自己的钥匙走原来的检查和添加。
// Tailscale 方式的码（m 为 tailscale）没有一次性钥匙：用手机自己的钥匙登进去（tailscaled 按 ACL 放行，不看钥匙），
// 自己执行二维码里的登记命令，输入输出一样。
// 这里不碰界面和原生模块，用到的都经 PairDeps 交进来，单元测试拿假的跑。
import type { RemoteCheck, RemoteTarget } from '@litch/core'
import {
  decodePairPayload,
  isTailnetHost,
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
 * unreachable 连不上二维码里的地址；noAnswer 登进去了但对面没给出登记结果；unknown 别的。
 * Tailscale 方式另有三种：tailscaleOff 连不上 tailnet 地址（手机上的 Tailscale 多半没开或没登录）；
 * denied Tailscale 不让这部手机登（ACL）；verify Tailscale 要在浏览器里再验证一次（detail 是链接）
 */
export type PairProblem =
  | PairEnrollError
  | 'refused'
  | 'hostKey'
  | 'unreachable'
  | 'noAnswer'
  | 'unknown'
  | 'tailscaleOff'
  | 'denied'
  | 'verify'

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

/** SSH 模块抛的错认成原因。payload 是 Tailscale 方式的码时，连不上、被拒说成 Tailscale 那边的事 */
export function enrollFailure(
  error: unknown,
  payload?: PairPayload,
): { problem: PairProblem; detail: string } {
  const { kind, message } = sshProblem(error)
  const tailscale = payload?.m === 'tailscale'
  switch (kind) {
    case 'verify':
      // 种类后面就是链接
      return { problem: 'verify', detail: message.replace(/^\[verify\] /, '').trim() }
    case 'auth':
      return { problem: tailscale ? 'denied' : 'refused', detail: message }
    case 'hostKeyChanged':
    case 'hostKeyUnknown':
      return { problem: 'hostKey', detail: message }
    case 'enroll':
      return { problem: 'noAnswer', detail: message }
    case 'unreachable':
    case null:
      return {
        problem: tailscale && payload && isTailnetHost(payload.h) ? 'tailscaleOff' : 'unreachable',
        detail: message,
      }
    default:
      return { problem: 'unknown', detail: message }
  }
}

/**
 * 登记时的连接配置：一次性钥匙方式用二维码里的种子；Tailscale 方式用手机自己的私钥，执行二维码里的登记命令。
 * 都钉住二维码里的主机指纹、只协商那一种算法
 */
export function enrollTarget(payload: PairPayload, privateKey: string): SshTarget {
  const base = {
    host: payload.h,
    port: payload.p,
    user: payload.u,
    passphrase: '',
    hostKeyType: payload.k.t,
    hostFingerprint: payload.k.f,
  }
  return payload.m === 'tailscale'
    ? { ...base, privateKey, enrollCommand: payload.c }
    : { ...base, privateKey: '', seed: payload.s }
}

/** 公钥行只要前两段（类型和 base64），不带注释：确认码、登记都按这个算 */
export const keyLine = (publicKey: string): string =>
  publicKey.trim().split(/\s+/).slice(0, 2).join(' ')

/**
 * 写进 pair-enroll 标准输入的那一行（PairEnrollInput）。approvalKey 是这部手机的批准公钥，
 * 只有二维码里有 a（设备认它）时才带，不然老设备算的确认码对不上
 */
export function enrollLine(publicKey: string, phoneName: string, approvalKey?: string): string {
  return JSON.stringify({
    v: 1,
    publicKey: keyLine(publicKey),
    name: phoneName,
    ...(approvalKey ? { approvalKey } : {}),
  })
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
  /** 刚生成的那把的私钥（Tailscale 方式登记时用它登录）。读不出来是 null */
  privateKey(id: string): Promise<string | null>
  /** 这部手机的批准公钥（没有就生成一把）。二维码里有 a 时才要 */
  approvalKey(): Promise<string>
  /** approvalKey 给空串是不带批准公钥 */
  confirmCode(pairId: string, publicKey: string, approvalKey: string): Promise<string>
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
    // 设备认批准公钥（二维码里有 a）才带上：扫码时带的算人核对过（确认码把它盖住了）
    const approvalKey = payload.a === 1 ? await deps.approvalKey() : ''
    const code = await deps.confirmCode(payload.i, keyLine(key.publicKey), approvalKey)
    onStep({ step: 'enroll', code })
    let line: string
    try {
      const privateKey = payload.m === 'tailscale' ? await deps.privateKey(key.id) : ''
      if (privateKey === null)
        return { ok: false, problem: 'unknown', detail: '读不出刚生成的私钥' }
      line = await deps.enroll(
        enrollTarget(payload, privateKey),
        enrollLine(key.publicKey, deps.phoneName, approvalKey),
      )
    } catch (error) {
      const { problem, detail } = enrollFailure(error, payload)
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
