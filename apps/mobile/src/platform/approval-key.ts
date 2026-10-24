// 批准钥匙：手机批准电脑上的代理登录时签名用的 ed25519 钥匙（算法见 packages/protocol/src/client-approvals.mts 开头）。
// 和登录设备用的 ssh 钥匙（keys.ts）无关：一台手机一把，绑了几台设备都用它。种子只放在系统的安全存储里
// （WHEN_UNLOCKED_THIS_DEVICE_ONLY），公钥和指纹不是秘密，记在 approval-key.json 里给设置页显示。
// 签名前要过系统的指纹、面容或锁屏密码（expo-local-authentication）。没有用 SecureStore 的 requireAuthentication：
// 换了指纹 Keystore 会作废那把钥匙，手机就得重新扫码绑定，太麻烦（22 号设计“先不做太安全”）。
// 第一次要用（扫码时设备认批准公钥、第一次批准）时才生成。
import { authenticateAsync, getEnrolledLevelAsync, SecurityLevel } from 'expo-local-authentication'
import * as SecureStore from 'expo-secure-store'
import { ssh } from '../../modules/litch-ssh/src'
import { jsonFile } from '../shell/json-file'
import { savedRemotes } from './device-store'
import { keyInfo } from './keys'

export interface ApprovalKeyInfo {
  /** 32 字节原始公钥的标准 base64 */
  approvalKey: string
  /** 4 组、每组 4 个十六进制字，电脑上设置里显示的是同一串 */
  fingerprint: string
  createdAt: number
}

const SECURE: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
}
const SEED = 'litch.approval.seed'
const infoFile = jsonFile<ApprovalKeyInfo>('approval-key.json')

const isInfo = (value: unknown): value is ApprovalKeyInfo =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as ApprovalKeyInfo).approvalKey === 'string' &&
  typeof (value as ApprovalKeyInfo).fingerprint === 'string'

/** 现在的批准钥匙。还没生成过是 null */
export function approvalKeyInfo(): ApprovalKeyInfo | null {
  const info = infoFile.read()
  return isInfo(info) ? info : null
}

async function readSeed(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(SEED, SECURE)
  } catch {
    return null
  }
}

let making: Promise<ApprovalKeyInfo> | null = null

/**
 * 有就用原来的，没有就生成一把。种子读不出来了（安全存储被清、换了锁屏方式）也重新生成：
 * 电脑上记着的是旧的那把，会提示对不上、要重新扫码绑定
 */
export function ensureApprovalKey(): Promise<ApprovalKeyInfo> {
  making ??= (async () => {
    const known = approvalKeyInfo()
    if (known && (await readSeed())) return known
    const made = await ssh.newApprovalKey()
    await SecureStore.setItemAsync(SEED, made.seed, SECURE)
    const info: ApprovalKeyInfo = {
      approvalKey: made.approvalKey,
      fingerprint: made.fingerprint,
      createdAt: Date.now(),
    }
    infoFile.write(info)
    return info
  })().finally(() => {
    making = null
  })
  return making
}

/** 过系统验证的结果。noLock：手机没设锁屏、也没录指纹面容，不让批准 */
export type Unlock = { ok: true } | { ok: false; reason: 'noLock' | 'cancel' | 'failed' }

/** 弹系统的指纹、面容（不行可以用锁屏密码） */
export async function unlockForApproval(
  promptMessage: string,
  cancelLabel: string,
): Promise<Unlock> {
  if ((await getEnrolledLevelAsync()) === SecurityLevel.NONE) return { ok: false, reason: 'noLock' }
  const result = await authenticateAsync({
    promptMessage,
    cancelLabel,
    disableDeviceFallback: false,
  })
  if (result.success) return { ok: true }
  return {
    ok: false,
    reason:
      result.error === 'user_cancel' ||
      result.error === 'system_cancel' ||
      result.error === 'app_cancel'
        ? 'cancel'
        : 'failed',
  }
}

/** 用批准钥匙签一段文字（调用方先过 unlockForApproval）。钥匙没了抛错 */
export async function signWithApprovalKey(text: string): Promise<string> {
  const seed = await readSeed()
  if (!seed) throw new Error('批准钥匙读不出来')
  return ssh.approvalSign(seed, text)
}

/**
 * 这部手机在一台设备上的手机号（devicePairing 的那个：登录这台设备用的 ssh 公钥算出来的）。
 * 答复里带它，桌面端按它记这台手机。设备没用手机自己的钥匙连（钥匙被删了）是 null
 */
export async function phoneIdFor(deviceId: string): Promise<string | null> {
  const target = savedRemotes().find((remote) => remote.id === deviceId)?.target
  const key = target?.kind === 'host' ? keyInfo(target.keyFile) : null
  return key ? ssh.pairPhoneId(key.publicKey) : null
}
