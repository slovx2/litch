// 一次性钥匙：设备给的是 ed25519 私钥的 32 字节种子，系统的 ssh 要的是私钥文件。
// Node 能从种子造出 ed25519 钥匙（PKCS8 的 DER 就是固定的前缀加种子），却导不出 OpenSSH 自己的私钥格式；
// 而 ssh 读 PEM（PKCS8）的 ed25519 私钥要看它链接的 OpenSSL 和版本（macOS 自带的 ssh 链的是 LibreSSL），靠不住。
// 所以这里照 OpenSSH 的 PROTOCOL.key 自己拼“openssh-key-v1”格式：不加密、一把钥匙。
import { createPrivateKey, createPublicKey, randomInt } from 'node:crypto'

/** PKCS8 里 ed25519 私钥的固定前缀，后面接 32 字节种子（RFC 8410） */
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex')
/** SPKI 里 ed25519 公钥的固定前缀，后面接 32 字节公钥 */
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex')

const u32 = (value: number): Buffer => {
  const out = Buffer.alloc(4)
  out.writeUInt32BE(value >>> 0)
  return out
}

/** SSH 线上格式的 string：四字节长度加内容 */
const sshString = (value: Buffer | string): Buffer => {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  return Buffer.concat([u32(bytes.length), bytes])
}

/** 从种子算出 ed25519 公钥的 32 字节 */
export function publicFromSeed(seed: Buffer): Buffer {
  if (seed.length !== 32) throw new Error('一次性钥匙的种子不是 32 字节')
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, seed]),
    format: 'der',
    type: 'pkcs8',
  })
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' })
  if (spki.length !== SPKI_ED25519.length + 32 || !spki.subarray(0, 12).equals(SPKI_ED25519)) {
    throw new Error('生成的公钥格式错误')
  }
  return spki.subarray(SPKI_ED25519.length)
}

/** 公钥行 "ssh-ed25519 <base64>"，和 ssh-keygen -y 打出来的一样（不带注释） */
export function publicLine(seed: Buffer): string {
  const blob = Buffer.concat([sshString('ssh-ed25519'), sshString(publicFromSeed(seed))])
  return `ssh-ed25519 ${blob.toString('base64')}`
}

/**
 * OpenSSH 私钥文件的内容（-----BEGIN OPENSSH PRIVATE KEY-----）。不加密：文件只在自检的那几秒里存在，权限 600。
 * checkint 是随机的两份相同的数（格式要求，用来在解密后验对没对）
 */
export function opensshPrivateKey(seed: Buffer, comment = 'litch-pair-selftest'): string {
  const pub = publicFromSeed(seed)
  const publicBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)])
  const check = randomInt(0, 0xffffffff)
  let secret = Buffer.concat([
    u32(check),
    u32(check),
    sshString('ssh-ed25519'),
    sshString(pub),
    // OpenSSH 的 ed25519 私钥是种子接公钥，一共 64 字节
    sshString(Buffer.concat([seed, pub])),
    sshString(comment),
  ])
  // 补到 8 字节的整数倍，补的是 1、2、3……
  const pad = (8 - (secret.length % 8)) % 8
  secret = Buffer.concat([secret, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))])
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'binary'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    u32(1),
    sshString(publicBlob),
    sshString(secret),
  ]).toString('base64')
  const lines = body.match(/.{1,70}/g) ?? []
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`
}
