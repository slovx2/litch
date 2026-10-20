import { createDecipheriv, createHash, createHmac, pbkdf2, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { child, type Der, integer, OID, oid, parseDer } from './der.mjs'
import { checkCancelled, ReadFault } from './result.mjs'

const derive = promisify(pbkdf2)
const HASHES: Record<string, string> = {
  [OID.sha1]: 'sha1',
  [OID.sha256]: 'sha256',
  [OID.sha384]: 'sha384',
  [OID.sha512]: 'sha512',
}

export function passwordKey(globalSalt: Buffer): Buffer {
  // 只支持没有主密码的资料；不猜测、不穷举，也不持有用户主密码。
  return createHash(globalSalt.length === 48 ? 'sha384' : 'sha1')
    .update(globalSalt)
    .digest()
}

async function kdf(
  algorithm: Der,
  passKey: Buffer,
  defaultSize: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (oid(child(algorithm, 0, 6)) !== OID.pbkdf2) throw new ReadFault('unsupported')
  const parameters = child(algorithm, 1, 0x30)
  const salt = child(parameters, 0, 4).value
  const iterations = integer(child(parameters, 1, 2))
  let index = 2
  let size = defaultSize
  if (parameters.children[index]?.tag === 2) size = integer(child(parameters, index++, 2))
  if (size !== defaultSize || iterations < 1 || iterations > 1_000_000)
    throw new ReadFault('unsupported')
  const hash = parameters.children[index]
    ? HASHES[oid(child(child(parameters, index, 0x30), 0, 6))]
    : 'sha1'
  if (!hash) throw new ReadFault('unsupported')
  checkCancelled(signal)
  const key = await derive(passKey, salt, iterations, size, hash)
  if (signal.aborted) {
    key.fill(0)
    throw new ReadFault('cancelled')
  }
  return key
}

function cbc(algorithm: string, key: Buffer, iv: Buffer, encrypted: Buffer): Buffer {
  const decipher = createDecipheriv(algorithm, key, iv)
  const first = decipher.update(encrypted)
  try {
    return Buffer.concat([first, decipher.final()])
  } finally {
    first.fill(0)
  }
}

export async function decryptPbe(
  encoded: Buffer,
  passKey: Buffer,
  signal: AbortSignal,
): Promise<{ plain: Buffer; authenticated: boolean }> {
  const node = parseDer(encoded)
  const algorithm = child(node, 0, 0x30)
  const kind = oid(child(algorithm, 0, 6))
  const ciphertext = child(node, 1, 4).value
  const parameters = child(algorithm, 1, 0x30)
  if (kind === OID.pbes2) {
    const encryption = child(parameters, 1, 0x30)
    if (oid(child(encryption, 0, 6)) !== OID.aes256) throw new ReadFault('unsupported')
    const ivNode = child(encryption, 1, 4)
    // NSS 老资料把 OCTET STRING 的头也作为 IV（14 字节随机数加 04 0e）。
    const iv = ivNode.value.length === 14 ? ivNode.encoded : ivNode.value
    if (iv.length !== 16) throw new ReadFault('failed')
    const key = await kdf(child(parameters, 0, 0x30), passKey, 32, signal)
    try {
      return { plain: cbc('aes-256-cbc', key, iv, ciphertext), authenticated: true }
    } finally {
      key.fill(0)
    }
  }
  if (kind !== OID.pbeSha1Des3) throw new ReadFault('unsupported')
  const salt = child(parameters, 0, 4).value
  const iterations = integer(child(parameters, 1, 2))
  if (salt.length > 20 || iterations !== 1) throw new ReadFault('unsupported')
  const digest = createHash('sha1').update(passKey).update(salt).digest()
  const padded = Buffer.alloc(20)
  salt.copy(padded)
  const one = createHmac('sha1', digest).update(padded).update(salt).digest()
  const middle = createHmac('sha1', digest).update(padded).digest()
  const two = createHmac('sha1', digest).update(middle).update(salt).digest()
  const material = Buffer.concat([one, two])
  try {
    return {
      plain: cbc('des-ede3-cbc', material.subarray(0, 24), material.subarray(-8), ciphertext),
      authenticated: false,
    }
  } finally {
    for (const buffer of [digest, padded, one, middle, two, material]) buffer.fill(0)
  }
}

export async function verifyKeySignature(
  encoded: Buffer,
  key: Buffer,
  passKey: Buffer,
  signal: AbortSignal,
): Promise<void> {
  const node = parseDer(encoded)
  const algorithm = child(node, 0, 0x30)
  if (oid(child(algorithm, 0, 6)) !== '2a864886f70d01050e') throw new ReadFault('unsupported')
  const parameters = child(algorithm, 1, 0x30)
  const hash = HASHES[oid(child(child(parameters, 1, 0x30), 0, 6))]
  if (!hash) throw new ReadFault('unsupported')
  const size = hash === 'sha1' ? 20 : hash === 'sha256' ? 32 : hash === 'sha384' ? 48 : 64
  const signingKey = await kdf(child(parameters, 0, 0x30), passKey, size, signal)
  try {
    // NSS 的私钥属性签名固定 objectID=0、CKA_VALUE=0x11，均为大端 32 位。
    const prefix = Buffer.alloc(8)
    prefix.writeUInt32BE(0x11, 4)
    const expected = createHmac(hash, signingKey).update(prefix).update(key).digest()
    const signature = child(node, 1, 4).value
    if (signature.length !== expected.length || !timingSafeEqual(expected, signature))
      throw new ReadFault('failed')
  } finally {
    signingKey.fill(0)
  }
}

export function loginKeyId(encoded: string): string {
  return child(parseDer(Buffer.from(encoded, 'base64')), 0, 4).value.toString('hex')
}

export function decryptLogin(encoded: string, key: Buffer): string {
  const node = parseDer(Buffer.from(encoded, 'base64'))
  const algorithm = child(node, 1, 0x30)
  const kind = oid(child(algorithm, 0, 6))
  const cipher =
    kind === OID.des3 ? 'des-ede3-cbc' : kind === OID.aes256 ? 'aes-256-cbc' : undefined
  if (!cipher) throw new ReadFault('unsupported')
  if (key.length !== (kind === OID.des3 ? 24 : 32)) throw new ReadFault('failed')
  const plain = cbc(cipher, key, child(algorithm, 1, 4).value, child(node, 2, 4).value)
  try {
    return plain.toString('utf8')
  } finally {
    plain.fill(0)
  }
}
