// 扫码绑定手机要知道的这台机器的事：主机钥匙、sshd 的版本、钥匙文件在哪、Windows 上是不是管理员账号。
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import type { PairHostKey } from '../../protocol/src/device-pairing.mjs'
import { fingerprintOf } from './pair-keys.mjs'

/** 测试用：钥匙文件换成这个路径（默认 ~/.ssh/authorized_keys） */
export const AUTHORIZED_KEYS_ENV = 'LITCH_AUTHORIZED_KEYS'
/** 测试用：主机钥匙从这个目录读（默认 /etc/ssh，Windows 是 %ProgramData%\ssh） */
export const HOST_KEYS_DIR_ENV = 'LITCH_SSH_HOST_KEYS_DIR'

export function defaultAuthorizedKeys(env: NodeJS.ProcessEnv = process.env): string {
  return env[AUTHORIZED_KEYS_ENV] || join(homedir(), '.ssh', 'authorized_keys')
}

export function defaultHostKeysDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env[HOST_KEYS_DIR_ENV]) return env[HOST_KEYS_DIR_ENV]
  if (platform === 'win32') return win32.join(env.ProgramData || 'C:\\ProgramData', 'ssh')
  return '/etc/ssh'
}

/** 主机钥匙的优先顺序：ed25519 > ecdsa > rsa，别的（dsa 之类）排最后、不拿来放进二维码 */
function rank(type: string): number {
  if (type === 'ssh-ed25519') return 0
  if (type.startsWith('ecdsa-sha2-')) return 1
  if (type === 'ssh-rsa') return 2
  return 3
}

/** 读 <目录>/ssh_host_*_key.pub，按优先顺序排好。读不到的文件跳过 */
export function readHostKeys(directory: string): PairHostKey[] {
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return []
  }
  const keys: PairHostKey[] = []
  for (const name of names.filter((item) => /^ssh_host_.+_key\.pub$/.test(item)).sort()) {
    let text: string
    try {
      text = readFileSync(join(directory, name), 'utf8')
    } catch {
      continue
    }
    const [type, base64] = text.trim().split(/\s+/)
    if (!type || !base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) continue
    const blob = Buffer.from(base64, 'base64')
    // 二进制开头的类型名要和行首的一致，不然是坏文件
    if (blob.length < 4 || blob.subarray(4, 4 + blob.readUInt32BE(0)).toString() !== type) continue
    if (keys.some((key) => key.publicKey === `${type} ${base64}`)) continue
    keys.push({ type, fingerprint: fingerprintOf(blob), publicKey: `${type} ${base64}` })
  }
  return keys.sort((a, b) => rank(a.type) - rank(b.type))
}

/** 能放进二维码的那一把：排第一的、而且是 ed25519、ecdsa、rsa 之一 */
export function preferredHostKey(keys: PairHostKey[]): PairHostKey | null {
  const first = keys[0]
  return first && rank(first.type) < 3 ? first : null
}

export type SshdVersion = [major: number, minor: number]

/** 从 sshd、ssh 的输出里认出 OpenSSH 的版本 */
export function parseOpenSshVersion(text: string): SshdVersion | null {
  const match = /OpenSSH_(?:for_Windows_)?(\d+)\.(\d+)/.exec(text)
  return match ? [Number(match[1]), Number(match[2])] : null
}

const atLeast = (version: SshdVersion, major: number, minor: number) =>
  version[0] > major || (version[0] === major && version[1] >= minor)

/**
 * 这台机器上 sshd 的版本。先问 sshd 自己（新版认 -V；老版不认，但打出来的用法说明里带版本），
 * 找不到 sshd 再看 ssh 客户端的（多半是同一个包装的）。都拿不到是 null
 */
export async function detectSshdVersion(platform: NodeJS.Platform = process.platform) {
  const candidates =
    platform === 'win32'
      ? [win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'sshd.exe')]
      : ['/usr/sbin/sshd', '/usr/local/sbin/sshd', '/opt/homebrew/sbin/sshd', '/usr/bin/sshd']
  for (const sshd of candidates.filter((path) => existsSync(path))) {
    const version = parseOpenSshVersion(await output(sshd, ['-V']))
    if (version) return version
  }
  return parseOpenSshVersion(await output('ssh', ['-V']))
}

/** 跑一下，标准输出和标准错误合在一起返回，失败（包括退出码不为 0）也返回已有的输出 */
function output(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5000, windowsHide: true }, (_error, stdout, stderr) =>
      resolve(`${stdout ?? ''}${stderr ?? ''}`),
    )
  })
}

/**
 * expiry-time 的值。OpenSSH 8.2 起才有这个选项，没有就不加（null）；9.1 起认带 Z 的 UTC 时间，写准的；
 * 8.2 到 9.0 只认 sshd 所在时区的本地时间，设备进程的时区可能和 sshd 的不一样，多放一天，
 * 免得钥匙提前失效（这一项只是兜底，pair-enroll 每次都会核对配对是否还有效）
 */
export function expiryTime(version: SshdVersion | null, expiresAt: number): string | null {
  if (!version || !atLeast(version, 8, 2)) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  if (atLeast(version, 9, 1)) {
    const at = new Date(expiresAt)
    return `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}Z`
  }
  const at = new Date(expiresAt + 24 * 60 * 60 * 1000)
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
}

/**
 * Windows 上当前账号在不在 Administrators 组里（SID S-1-5-32-544）。在的话 OpenSSH for Windows 默认
 * 只认 %ProgramData%\ssh\administrators_authorized_keys，改它要管理员权限，第一版不支持。
 * 判断不了的按是算（宁可不出码，也不写一个 sshd 不看的文件）
 */
export function windowsAdmin(): boolean {
  try {
    const text = execFileSync('whoami', ['/groups'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    })
    return text.includes('S-1-5-32-544')
  } catch {
    return true
  }
}
