// 扫码绑定手机在外壳这一头要做的几件事（核心的 PairingPlatform）：
//   解析地址：ssh -G <别名>，和发现主机时一样只解析、不连接；
//   主机钥匙：用 ssh -G 报的 known_hosts 文件和查找名，交给 ssh-keygen -F 去找（认得哈希过的记录），只读不写；
//   本机的 SSH 服务：连 127.0.0.1:22 读横幅；
//   自检：把一次性私钥写成临时文件（600），用系统的 ssh 带 -i 和 IdentitiesOnly 登一次，往标准输入写自检那一行，
//     看强制命令回不回 {"ok":true,"probe":true}。本机不读用户的 ssh 配置和 known_hosts（-F none，
//     设备报的主机钥匙写进临时的 UserKnownHostsFile）。临时文件放在状态目录下，用完就删。
// 这里绝不往用户的 ~/.ssh 里写任何东西。
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  base64UrlDecode,
  type PairingHostAddress,
  type PairingPlatform,
  type PairSelfTestInput,
  type PairSelfTestResult,
  type RemoteTarget,
} from '@litch/core'
import { opensshPrivateKey } from './pairing-key.mjs'
import { sshBase } from './ssh/args.mjs'
import { tailOf } from './ssh/run.mjs'

/** 自检最多等多久：连接、认证、强制命令回一行 */
const SELF_TEST_MS = 25_000
/** 读本机 SSH 横幅最多等多久 */
const BANNER_MS = 3000
/** 自检时写进标准输入的那一行，和期望回来的那一行 */
const PROBE = '{"v":1,"probe":true}\n'

/** 本机的 SSH 端口。只给开发和自检用（对着用户态的 sshd 夹具），平时就是 22 */
const localPort = (): number => {
  const given = Number(process.env.LITCH_LOCAL_SSH_PORT)
  return Number.isInteger(given) && given > 0 && given < 65536 ? given : 22
}

/** 跑 ssh -G：键都是小写，同一个键出现多次的按出现的先后收着 */
function sshConfigOf(target: RemoteTarget): Promise<Map<string, string[]>> {
  const { options, destination } = sshBase(target)
  return new Promise((done, fail) => {
    execFile(
      'ssh',
      [...options, '-G', '--', destination],
      { timeout: 5000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          fail(new Error(tailOf(String(stderr)) ?? `ssh -G 执行失败：${error.message}`))
          return
        }
        const found = new Map<string, string[]>()
        for (const line of stdout.split('\n')) {
          const at = line.indexOf(' ')
          if (at <= 0) continue
          const key = line.slice(0, at).toLowerCase()
          found.set(key, [...(found.get(key) ?? []), line.slice(at + 1).trim()])
        }
        done(found)
      },
    )
  })
}

const first = (config: Map<string, string[]>, key: string): string | null =>
  config.get(key)?.[0] ?? null

/** known_hosts 文件的路径：ssh -G 报的是没展开的写法，~ 自己展开；多个文件用空白隔开 */
const knownFiles = (config: Map<string, string[]>): string[] =>
  ['userknownhostsfile', 'globalknownhostsfile']
    .flatMap((key) => config.get(key) ?? [])
    .flatMap((value) => value.split(/\s+/))
    .filter((path) => path && path !== 'none' && path !== '/dev/null')
    .map((path) => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : path))

/** ssh-keygen -F：在一份 known_hosts 里找这个名字的记录，只读。返回每条的“类型 base64” */
function lookup(name: string, file: string): Promise<string[]> {
  return new Promise((done) => {
    execFile(
      'ssh-keygen',
      ['-F', name, '-f', file],
      { timeout: 5000, windowsHide: true },
      (_error, stdout) => {
        const keys: string[] = []
        for (const line of String(stdout).split('\n')) {
          const text = line.trim()
          if (!text || text.startsWith('#')) continue
          const fields = text.split(/\s+/)
          // 带标记的（@cert-authority、@revoked）不是这台主机自己的钥匙，不算
          if (fields[0]?.startsWith('@')) continue
          const [, type, body] = fields
          if (type && body) keys.push(`${type} ${body}`)
        }
        done(keys)
      },
    )
  })
}

export interface DesktopPairingOptions {
  /** 临时文件放哪：用户数据目录。没有（开发时）就用系统的临时目录 */
  dataDir: string | undefined
  /** 本机给手机看的名字 */
  localName(): string
}

/** 自检那一次 ssh 的参数（不含 -i 那一截）。远程设备照它自己的 ssh 配置，只是不用它配的钥匙文件 */
function testArgs(input: PairSelfTestInput, knownHosts: string): string[] {
  const { target } = input
  if (target) {
    // 手填的主机带着用户自己的钥匙文件：自检要的是一次性钥匙，那一把不能先递上去
    const { options, destination } = sshBase(
      target.kind === 'host' ? { ...target, keyFile: null } : target,
    )
    return [...options, '--', destination]
  }
  return [
    '-T',
    // 本机：不读用户的 ssh 配置，主机钥匙只认设备报的那几把
    '-F',
    'none',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${knownHosts}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    'CheckHostIP=no',
    '-p',
    String(localPort()),
    '-l',
    input.user,
    '--',
    '127.0.0.1',
  ]
}

/** 强制命令回的那一行：自检过了是 null，没过是原因 */
function verdict(stdout: string): { ok: true } | { ok: false; said: string } | null {
  for (const line of stdout.split('\n')) {
    const text = line.trim()
    if (!text.startsWith('{')) continue
    try {
      const reply = JSON.parse(text) as { ok?: unknown; probe?: unknown; message?: unknown }
      if (reply.ok === true && reply.probe === true) return { ok: true }
      if (reply.ok === false) {
        return { ok: false, said: typeof reply.message === 'string' ? reply.message : text }
      }
    } catch {
      // 不是那一行
    }
  }
  return null
}

/** 起一次 ssh 跑自检。key 是私钥文件的路径 */
function runSelfTest(args: string[], key: string): Promise<PairSelfTestResult> {
  return new Promise((done) => {
    const child = spawn(
      'ssh',
      [
        // 一次性钥匙排在最前面：用户配置里的钥匙文件 ssh 也会递，但轮不到它们就已经进去了
        '-i',
        key,
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'IdentityAgent=none',
        '-o',
        'PreferredAuthentications=publickey',
        ...args,
        // 强制命令不看这一句；万一登进去的不是强制命令（sshd 认了别的钥匙），也只是什么都不做
        'true',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    )
    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (result: PairSelfTestResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle({
        ok: false,
        said: tailOf(stderr) ?? `一次性钥匙登录在 ${SELF_TEST_MS / 1000} 秒内无结果`,
      })
    }, SELF_TEST_MS)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-8000)
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000)
    })
    child.on('error', (error) => settle({ ok: false, said: `无法启动 ssh：${error.message}` }))
    child.on('close', () => {
      const found = verdict(stdout)
      if (found) return settle(found)
      settle({
        ok: false,
        said:
          tailOf(stderr) ??
          (stdout.trim()
            ? stdout.trim().slice(-2000)
            : '一次性钥匙登录后无响应：sshd 可能未识别该钥匙的强制命令'),
      })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(PROBE)
  })
}

/** 127.0.0.1 上有没有 SSH 服务：连得上、头一行是 SSH- 开头的横幅 */
function sshBanner(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect(port, '127.0.0.1')
    let head = ''
    const finish = (ok: boolean) => {
      clearTimeout(timer)
      socket.destroy()
      done(ok)
    }
    const timer = setTimeout(() => finish(false), BANNER_MS)
    socket.setEncoding('latin1')
    socket.on('data', (chunk: string) => {
      head += chunk
      if (head.includes('\n') || head.length >= 255) finish(head.startsWith('SSH-'))
    })
    socket.on('error', () => finish(false))
    socket.on('close', () => finish(head.startsWith('SSH-')))
  })
}

export function desktopPairing(options: DesktopPairingOptions): PairingPlatform {
  /** 临时文件的上级目录：用户数据目录下的 pairing，只有自己能进 */
  const scratch = (): string => {
    const base = options.dataDir
      ? join(options.dataDir, 'pairing')
      : join(tmpdir(), 'litch-pairing')
    mkdirSync(base, { recursive: true, mode: 0o700 })
    return mkdtempSync(join(base, 'p-'))
  }

  return {
    async resolve(target): Promise<PairingHostAddress> {
      const config = await sshConfigOf(target)
      const host = first(config, 'hostname')
      const user = first(config, 'user')
      const port = Number(first(config, 'port'))
      if (!host || !user) throw new Error('ssh -G 未解析出主机名或用户名')
      return { host, port: Number.isInteger(port) && port > 0 ? port : 22, user }
    },

    async knownKeys(target) {
      const config = await sshConfigOf(target)
      const host = first(config, 'hostname') ?? ''
      const port = Number(first(config, 'port')) || 22
      // 和 ssh 自己找的是同一个名字：配了 HostKeyAlias 就用它，否则主机名，非 22 端口写成 [主机名]:端口
      const alias = first(config, 'hostkeyalias')
      const name = alias && alias !== 'none' ? alias : port === 22 ? host : `[${host}]:${port}`
      const files = knownFiles(config).filter((file) => existsSync(file))
      const found = await Promise.all(files.map((file) => lookup(name, file)))
      return found.flat()
    },

    localSsh: () => sshBanner(localPort()),

    localName: () => options.localName(),

    async selfTest(input) {
      const seed = base64UrlDecode(input.seed)
      if (seed?.length !== 32) return { ok: false, said: '一次性钥匙的种子不是 32 字节' }
      const dir = scratch()
      try {
        const key = join(dir, 'id')
        writeFileSync(key, opensshPrivateKey(Buffer.from(seed)), { mode: 0o600 })
        const knownHosts = join(dir, 'known_hosts')
        const port = localPort()
        const name = port === 22 ? '127.0.0.1' : `[127.0.0.1]:${port}`
        writeFileSync(
          knownHosts,
          input.hostKeys.map((entry) => `${name} ${entry.publicKey}\n`).join(''),
          { mode: 0o600 },
        )
        return await runSelfTest(testArgs(input, knownHosts), key)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  }
}
