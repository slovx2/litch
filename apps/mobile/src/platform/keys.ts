// 登录远程机器用的钥匙。私钥（连同导入时给的口令）只放在系统的安全存储里（expo-secure-store，
// 安卓上是 Keystore 加密的那一份），只在这台手机解锁时可读、不随备份迁走（WHEN_UNLOCKED_THIS_DEVICE_ONLY）。
// 公钥和指纹不是秘密，记在 keys.json 里给页面列出来。设备配置里（RemoteTarget.keyFile）放的是钥匙的编号，不是路径。
import { getRandomBytes } from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'
import { ssh } from '../../modules/litch-ssh/src'
import { jsonFile } from '../shell/json-file'

export interface KeyInfo {
  /** 编号：k- 加 16 个十六进制字符。设备配置里记的就是它 */
  id: string
  /** authorized_keys 里的一行 */
  publicKey: string
  fingerprint: string
  /** 在手机上生成的，还是导入的 */
  origin: 'generated' | 'imported'
  createdAt: number
}

interface Secret {
  privateKey: string
  passphrase: string
}

const SECURE: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
}

const listFile = jsonFile<KeyInfo[]>('keys.json')
const secretName = (id: string) => `litch.key.${id}`
const ID = /^k-[0-9a-f]{16}$/

export const isKeyId = (value: string | null | undefined): value is string =>
  typeof value === 'string' && ID.test(value)

export function listKeys(): KeyInfo[] {
  const listed = listFile.read()
  return Array.isArray(listed) ? listed.filter((key) => isKeyId(key?.id)) : []
}

export const keyInfo = (id: string | null): KeyInfo | null =>
  id ? (listKeys().find((key) => key.id === id) ?? null) : null

async function remember(
  secret: Secret,
  described: { publicKey: string; fingerprint: string },
  origin: KeyInfo['origin'],
): Promise<KeyInfo> {
  // 同一把钥匙导入第二次就用原来那一份
  const same = listKeys().find((key) => key.fingerprint === described.fingerprint)
  if (same) return same
  const id = `k-${Array.from(getRandomBytes(8), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
  await SecureStore.setItemAsync(secretName(id), JSON.stringify(secret), SECURE)
  const info: KeyInfo = {
    id,
    publicKey: described.publicKey,
    fingerprint: described.fingerprint,
    origin,
    createdAt: Date.now(),
  }
  listFile.write([...listKeys(), info])
  return info
}

/** 在手机上生成一把 Ed25519 钥匙 */
export async function generateKey(): Promise<KeyInfo> {
  const made = await ssh.generateEd25519Key()
  return remember({ privateKey: made.privateKey, passphrase: '' }, made, 'generated')
}

/**
 * 导入一把私钥（OpenSSH 或 PEM 格式的 Ed25519、RSA、ECDSA）。带口令的连口令一起存：
 * 口令和私钥放在同一处安全存储里，比把私钥解开再存不差，也不用改动用户的钥匙。
 * 不对的抛错，错误文字带着种类（[keyLocked] 要口令，[key] 内容或口令不对），用 sshProblem 认
 */
export async function importKey(privateKey: string, passphrase: string): Promise<KeyInfo> {
  const described = await ssh.inspectPrivateKey(privateKey, passphrase)
  return remember({ privateKey: privateKey.trim(), passphrase }, described, 'imported')
}

/** 连接时取私钥。钥匙被删了、安全存储读不出来（换了锁屏方式之类）是 null */
export async function keySecret(id: string): Promise<Secret | null> {
  if (!isKeyId(id)) return null
  try {
    const stored = await SecureStore.getItemAsync(secretName(id), SECURE)
    return stored ? (JSON.parse(stored) as Secret) : null
  } catch {
    return null
  }
}

/** 删掉一把钥匙（私钥和列表里的那一行） */
export async function forgetKey(id: string): Promise<void> {
  if (!isKeyId(id)) return
  await SecureStore.deleteItemAsync(secretName(id), SECURE)
  listFile.write(listKeys().filter((key) => key.id !== id))
}
