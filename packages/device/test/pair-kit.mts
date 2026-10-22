// 扫码绑定手机的测试共用的东西：可以拨的假时钟、临时的钥匙文件和主机钥匙目录、手机的钥匙。
// 一律在临时目录里，不碰这台机器真的 ~/.ssh。
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readHostKeys } from '../src/pair-host.mjs'
import type { PairingClock, PairingConfig } from '../src/pairing.mjs'
import { tempDir } from './helpers.mjs'

/** 假时钟：时间只在 advance 时走，到点的定时器按时间先后跑 */
export class FakeClock implements PairingClock {
  private time = 1_800_000_000_000
  private seq = 0
  private readonly timers = new Map<number, { at: number; callback: () => void }>()

  now(): number {
    return this.time
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = ++this.seq
    this.timers.set(id, { at: this.time + ms, callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  /** 往前拨 ms 毫秒，途中到点的定时器依次跑 */
  advance(ms: number): void {
    const end = this.time + ms
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!next) break
      this.timers.delete(next[0])
      this.time = next[1].at
      next[1].callback()
    }
    this.time = end
  }

  get pending(): number {
    return this.timers.size
  }
}

const sshString = (bytes: Buffer) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length)
  return Buffer.concat([length, bytes])
}

/** 一把新的 ed25519 钥匙的公钥行 "ssh-ed25519 <base64>"（当作手机的钥匙） */
export function phoneKey(): string {
  const x = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x ?? ''
  const blob = Buffer.concat([
    sshString(Buffer.from('ssh-ed25519')),
    sshString(Buffer.from(x, 'base64url')),
  ])
  return `ssh-ed25519 ${blob.toString('base64')}`
}

/** 假的主机钥匙公钥行：二进制开头是类型名，后面随便填 */
export function fakeHostKey(type: string): string {
  const blob = Buffer.concat([sshString(Buffer.from(type)), sshString(randomBytes(32))])
  return `${type} ${blob.toString('base64')} root@host`
}

export interface PairPlace {
  root: string
  /** 钥匙文件（在 root/ssh/ 下，一开始不存在） */
  keysFile: string
  hostKeysDir: string
}

/** 临时目录里摆好钥匙文件的位置和一个只有 ed25519 主机钥匙的目录 */
export function pairPlace(): PairPlace {
  const root = tempDir()
  const hostKeysDir = join(root, 'etc-ssh')
  mkdirSync(hostKeysDir)
  writeFileSync(join(hostKeysDir, 'ssh_host_ed25519_key.pub'), `${fakeHostKey('ssh-ed25519')}\n`)
  return { root, keysFile: join(root, 'ssh', 'authorized_keys'), hostKeysDir }
}

export function pairConfig(place: PairPlace, more: Partial<PairingConfig> = {}): PairingConfig {
  return {
    keysFile: place.keysFile,
    hostKeys: () => readHostKeys(place.hostKeysDir),
    adapterCli: '/opt/litch/bin/codex-harness-adapter',
    adapterHome: '/home/tester/.codex-harness-adapter',
    unsupported: null,
    sshdVersion: async () => [9, 9],
    tailscaleSsh: async () => false,
    hostname: 'test-host',
    user: 'tester',
    ...more,
  }
}

/**
 * 把 32 字节种子写成 OpenSSH 格式的私钥文件内容（openssh-key-v1，不加密），给 ssh -i 用。
 * 出码的一方自检、手机端都要做同样的事；这里是测试自己的一份
 */
export function openSshPrivateKey(seed: string): string {
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(seed, 'base64url'),
  ])
  const x = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({
    format: 'jwk',
  }).x
  const pub = Buffer.from(x ?? '', 'base64url')
  const type = Buffer.from('ssh-ed25519')
  const pubBlob = Buffer.concat([sshString(type), sshString(pub)])
  const check = randomBytes(4)
  let priv = Buffer.concat([
    check,
    check,
    sshString(type),
    sshString(pub),
    sshString(Buffer.concat([Buffer.from(seed, 'base64url'), pub])),
    sshString(Buffer.from('litch-pair')),
  ])
  const padding: number[] = []
  for (let i = 1; (priv.length + padding.length) % 8 !== 0; i++) padding.push(i)
  priv = Buffer.concat([priv, Buffer.from(padding)])
  const none = sshString(Buffer.from('none'))
  const count = Buffer.alloc(4)
  count.writeUInt32BE(1)
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    none,
    none,
    sshString(Buffer.alloc(0)),
    count,
    sshString(pubBlob),
    sshString(priv),
  ]).toString('base64')
  const lines = body.match(/.{1,70}/g) ?? []
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`
}
