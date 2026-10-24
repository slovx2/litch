// 桌面端记着的手机批准钥匙：`<用户数据>/trusted-phones.json`。手机在别的设备上批准登录时，桌面端只认这里记下的钥匙；
// 不从设备上读（设备上 authorized_keys 那一行代理改得了）。文件里还有这台桌面端自己的标识（desktopId，卡片和签名里带）。
//
// 钥匙怎么来（22 号设计 8.2，决 415）：
// - pairing：扫码绑定时手机带上、确认码把它算进去，人核对过确认码、点“允许”时记下（扫码时核对过）。
//   之后有人拿同一个手机号带来别的钥匙，那把不认，这把照旧能用。
// - firstApproval：以前绑的手机第一次答卡片时带上，验过签名就记下、当次生效（先信任、后核对）。
//   之后同一个手机号带来一把不一样的钥匙，两把都不认（conflict），等用户在设置里删掉、手机重新扫码。
//
// 这里不引 electron，单元测试在临时目录里跑（src/test/approvals.test.mts）。
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  isApprovalKey,
  isApprovalToken,
} from '../../../../packages/protocol/src/client-approvals.mjs'

export type TrustSource = 'pairing' | 'firstApproval'

export interface TrustedPhone {
  /** 手机号（devicePairing 的那个，手机 ssh 公钥的 SHA-256 前 8 字节） */
  phoneId: string
  /** 手机名：扫码时登记的，或者第一次批准时答复里带的 */
  name: string
  /** 批准公钥，32 字节 ed25519 的标准 base64 */
  approvalKey: string
  source: TrustSource
  /** 经哪台设备记下的（桌面端给设备的标识），不知道是 null */
  deviceId: string | null
  /** 毫秒 */
  addedAt: number
  /** 最近一次批准，毫秒；还没批过是 null */
  lastApprovedAt: number | null
  /** 第一次批准记下的手机，后来同一个手机号带来过别的钥匙：两把都不认 */
  conflict: boolean
}

/** 给设置页的一条：多一个指纹 */
export interface TrustedPhoneView extends TrustedPhone {
  fingerprint: string
}

interface StoredFile {
  version: 1
  desktopId: string
  phones: TrustedPhone[]
}

/**
 * 指纹：32 字节原始公钥做 SHA-256，取前 8 字节的小写十六进制，每 4 个字一组、空格隔开
 * （算法和测试向量在 packages/protocol/src/client-approvals.mts）
 */
export function approvalKeyFingerprint(approvalKey: string): string {
  const hex = createHash('sha256')
    .update(Buffer.from(approvalKey, 'base64'))
    .digest('hex')
    .slice(0, 16)
  return hex.replace(/(.{4})(?=.)/g, '$1 ')
}

/** 随机标识：base64url，22 个字（16 字节） */
const randomToken = (): string => randomBytes(16).toString('base64url')

const isPhone = (value: unknown): value is TrustedPhone => {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.phoneId === 'string' &&
    /^[0-9a-f]{16}$/.test(v.phoneId) &&
    typeof v.name === 'string' &&
    isApprovalKey(v.approvalKey) &&
    (v.source === 'pairing' || v.source === 'firstApproval') &&
    (v.deviceId === null || typeof v.deviceId === 'string') &&
    typeof v.addedAt === 'number' &&
    (v.lastApprovedAt === null || typeof v.lastApprovedAt === 'number') &&
    typeof v.conflict === 'boolean'
  )
}

export class TrustedPhones {
  private readonly file: string
  private readonly log: (line: string) => void
  private data: StoredFile

  constructor(file: string, log: (line: string) => void = () => {}) {
    this.file = file
    this.log = log
    this.data = this.load()
  }

  /** 这台桌面端的标识：第一次用时生成、写进文件 */
  get desktopId(): string {
    return this.data.desktopId
  }

  get(phoneId: string): TrustedPhone | null {
    const found = this.data.phones.find((phone) => phone.phoneId === phoneId)
    return found ? { ...found } : null
  }

  list(): TrustedPhoneView[] {
    return this.data.phones.map((phone) => ({
      ...phone,
      fingerprint: approvalKeyFingerprint(phone.approvalKey),
    }))
  }

  /** 加一条或换掉同一个手机号的那条 */
  put(phone: TrustedPhone): void {
    this.data = {
      ...this.data,
      phones: [...this.data.phones.filter((one) => one.phoneId !== phone.phoneId), { ...phone }],
    }
    this.save()
  }

  /** 删掉一个手机号的钥匙，回删没删掉 */
  remove(phoneId: string): boolean {
    const phones = this.data.phones.filter((phone) => phone.phoneId !== phoneId)
    if (phones.length === this.data.phones.length) return false
    this.data = { ...this.data, phones }
    this.save()
    return true
  }

  private load(): StoredFile {
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoredFile>
        if (
          parsed.version === 1 &&
          isApprovalToken(parsed.desktopId) &&
          Array.isArray(parsed.phones)
        )
          return { version: 1, desktopId: parsed.desktopId, phones: parsed.phones.filter(isPhone) }
      } catch {}
      // 读不懂：挪到一边留着，重新开始（之前记下的手机下次批准时按第一次批准重新记）
      const aside = `${this.file}.broken-${Date.now()}`
      try {
        renameSync(this.file, aside)
        this.log(`trusted-phones.json 读不懂，挪到了 ${aside}`)
      } catch {}
    }
    const fresh: StoredFile = { version: 1, desktopId: randomToken(), phones: [] }
    this.data = fresh
    this.save()
    return fresh
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.tmp-${process.pid}`
    writeFileSync(temp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, this.file)
  }
}
