// 扫码绑定手机在外壳这一头的自检小工具（scripts/check-pair.mjs 起它），对着假的远程机器（client-ssh-fixture.mjs 的用户态 sshd）：
//   一、种子拼出来的 OpenSSH 私钥文件 ssh-keygen 认得、算出的公钥一样；
//   二、外壳的几样（pairing.mts）：ssh -G 解析地址、从夹具的 known_hosts 里找主机钥匙、本机的 SSH 横幅、
//       一次性钥匙自检（夹具的钥匙文件里临时加一行带强制命令的一次性钥匙，强制命令是个只会答自检的小脚本），
//       以及自检失败的几种（钥匙不认、主机钥匙不对），读横幅，tailscale 方式的自检对着普通 sshd 被拒，临时文件用完删掉；
//   三、整条链：核心经 ssh 连夹具上装了适配器的那台，设备服务列了 devicePairing 时真的出一次码再作废，
//       看夹具的钥匙文件里一次性钥匙行出现又消失。设备服务还没有这项扩展时这一段跳过并写明。
// 每一项结果打一行 LITCH_PAIR_CHECK {...}，全部过了退出码是 0。
//
// 用法：node dist/pair-check.mjs '<夹具就绪行的 JSON>'；环境里要有 LITCH_SSH_CONFIG 等（同 ssh-check）。
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import {
  type Clock,
  createCore,
  type DeviceView,
  type PairHostKey,
  type PairingPlatform,
  type PairingView,
} from '@litch/core'
import { desktopPairing } from './pairing.mjs'
import { opensshPrivateKey, publicLine } from './pairing-key.mjs'
import { sshOpener } from './transport-ssh.mjs'

interface Fixture {
  root: string
  aliases: Record<string, string>
}

const fixture = JSON.parse(process.argv[2] ?? '{}') as Fixture
const { root, aliases } = fixture
let failed = 0
const say = (name: string, ok: boolean, detail: Record<string, unknown> = {}) => {
  if (!ok) failed++
  console.log(`LITCH_PAIR_CHECK ${JSON.stringify({ name, ok, ...detail })}`)
}

const clock: Clock = {
  now: () => Date.now(),
  setTimer(callback, delayMs) {
    const handle = setTimeout(callback, delayMs)
    return () => clearTimeout(handle)
  },
}

const seedText = (seed: Buffer) => seed.toString('base64url')
const keysFile = join(root, 'authorized_keys')
const hostPub = readFileSync(join(root, 'host_key.pub'), 'utf8').trim().split(/\s+/)
const hostKey: PairHostKey = {
  type: hostPub[0] ?? '',
  fingerprint: '',
  publicKey: `${hostPub[0]} ${hostPub[1]}`,
}

// ---------- 一、私钥文件 ----------
{
  const dir = join(root, 'pk')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  let all = true
  for (let i = 0; i < 8; i++) {
    const seed = randomBytes(32)
    const file = join(dir, `id${i}`)
    writeFileSync(file, opensshPrivateKey(seed), { mode: 0o600 })
    const derived = execFileSync('ssh-keygen', ['-y', '-f', file], { encoding: 'utf8' })
    if (derived.trim().split(/\s+/).slice(0, 2).join(' ') !== publicLine(seed)) all = false
  }
  say('privateKeyFile', all)
}

// ---------- 二、外壳的几样 ----------
const dataDir = join(root, 'dd')
const platform: PairingPlatform = desktopPairing({ dataDir, localName: () => '自检用的电脑' })
const ok = { kind: 'alias' as const, alias: aliases.ok ?? '' }

const resolved = await platform.resolve(ok)
say('resolve', resolved.host === '127.0.0.1' && resolved.port > 0 && resolved.user.length > 0, {
  resolved,
})

const known = await platform.knownKeys(ok)
say('knownKeys', known.includes(hostKey.publicKey), { known })
const none = await platform.knownKeys({ kind: 'alias', alias: aliases.untrusted ?? '' })
say('knownKeysEmpty', none.length === 0, { known: none })

// 夹具的钥匙文件里加一行一次性钥匙：强制命令是只会答自检的小脚本（真的是 pair-enroll）
const probeScript = join(root, 'pair-probe.mjs')
writeFileSync(
  probeScript,
  [
    "let text = ''",
    "process.stdin.on('data', (chunk) => { text += chunk })",
    "process.stdin.on('end', () => {",
    '  let input = null',
    "  try { input = JSON.parse(text.split('\\n')[0]) } catch {}",
    '  const ok = input && input.v === 1 && input.probe === true',
    "  process.stdout.write(JSON.stringify(ok ? { ok: true, probe: true } : { ok: false, error: 'invalid', message: '不是自检' }) + '\\n')",
    '})',
    '',
  ].join('\n'),
)
const pairSeed = randomBytes(32)
const before = readFileSync(keysFile, 'utf8')
const line = `restrict,command="${process.execPath} ${probeScript}" ${publicLine(pairSeed)} litch-pair:selfcheck\n`
writeFileSync(keysFile, before + line, { mode: 0o600 })

const remote = await platform.selfTest({
  target: ok,
  user: resolved.user,
  seed: seedText(pairSeed),
  hostKeys: [hostKey],
})
say('selfTestRemote', remote.ok, { remote })

// 钥匙文件里没有的一次性钥匙：夹具配置里那把普通钥匙随后也递了上去、登进了普通的 shell，没有回应
const stranger = await platform.selfTest({
  target: ok,
  user: resolved.user,
  seed: seedText(randomBytes(32)),
  hostKeys: [hostKey],
})
say('selfTestUnknownKey', !stranger.ok, { stranger })
const denied = await platform.selfTest({
  target: { kind: 'alias', alias: aliases.denied ?? '' },
  user: resolved.user,
  seed: seedText(randomBytes(32)),
  hostKeys: [hostKey],
})
say('selfTestDenied', !denied.ok && /Permission denied/i.test(denied.ok ? '' : denied.said), {
  denied,
})

// 本机：127.0.0.1 上的夹具 sshd 冒充本机的 SSH 服务
process.env.LITCH_LOCAL_SSH_PORT = String(resolved.port)
say('localSshOn', await platform.localSsh())
const local = await platform.selfTest({
  target: null,
  user: resolved.user,
  seed: seedText(pairSeed),
  hostKeys: [hostKey],
})
say('selfTestLocal', local.ok, { local })
const wrongHost = await platform.selfTest({
  target: null,
  user: resolved.user,
  seed: seedText(pairSeed),
  hostKeys: [{ ...hostKey, publicKey: publicLine(randomBytes(32)) }],
})
say('selfTestLocalHostKey', !wrongHost.ok && /host key/i.test(wrongHost.ok ? '' : wrongHost.said), {
  wrongHost,
})
const deadPort = await new Promise<number>((done) => {
  const server = createServer()
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 1
    server.close(() => done(port))
  })
})
process.env.LITCH_LOCAL_SSH_PORT = String(deadPort)
say('localSshOff', !(await platform.localSsh()))
delete process.env.LITCH_LOCAL_SSH_PORT

// 横幅：夹具的 sshd 报 OpenSSH 的；没人听的端口是 null
const banner = await platform.banner('127.0.0.1', resolved.port)
say('banner', banner?.startsWith('SSH-2.0-OpenSSH') === true, { banner })
say('bannerDead', (await platform.banner('127.0.0.1', deadPort)) === null)
// tailscale 方式的自检对着普通的 sshd：临时钥匙谁都没登记过，被拒（说明递上去的只有它，没用用户自己的配置）
const enrolled = await platform.enrollTest({
  host: '127.0.0.1',
  port: resolved.port,
  user: resolved.user,
  command: 'true',
  hostKeys: [hostKey],
})
say(
  'enrollTestRefused',
  !enrolled.ok && /Permission denied/i.test(enrolled.ok ? '' : enrolled.said),
  {
    enrolled,
  },
)

// 自检用的临时文件都删了；钥匙文件还原
const left = existsSync(join(dataDir, 'pairing')) ? readdirSync(join(dataDir, 'pairing')) : []
say('scratchCleaned', left.length === 0, { left })
writeFileSync(keysFile, before, { mode: 0o600 })

// ---------- 三、整条链 ----------
const svc = { kind: 'alias' as const, alias: aliases.svc ?? '' }
const core = createCore({
  clock,
  version: '0.0.0',
  pairing: platform,
  log: () => {},
  devices: [
    {
      id: 'svc',
      name: 'svc',
      host: svc.alias,
      kind: 'ssh',
      target: svc,
      wire: 'orange',
      open: sshOpener(svc),
    },
  ],
})
const device = await new Promise<DeviceView | null>((done) => {
  const timer = setTimeout(() => done(null), 120_000)
  core.subscribe(
    { kind: 'app' },
    {
      snapshot() {},
      delta(ops) {
        for (const op of ops as { op: string; device?: DeviceView }[]) {
          // 认出对面之后 harness 才有；pairing 是一起定的
          if (op.device?.connection === 'online' && op.device.harnesses.length > 0) {
            clearTimeout(timer)
            done(op.device)
          }
        }
      },
      error() {},
    },
  )
  core.start()
})
const never = { aborted: false, addEventListener() {} }
if (!device) {
  say('chainConnect', false)
} else if (!device.pairing) {
  // 设备服务还没有 devicePairing（设备进程那一线没合进来）：这一段先跳过
  say('chainSkipped', true, { reason: '设备服务没有列 devicePairing' })
} else {
  const lines = () => readFileSync(keysFile, 'utf8').split('\n').filter(Boolean)
  const has = (mark: string) => lines().some((entry) => entry.includes(mark))
  try {
    const { pairing } = (await core.command('pairing.start', { deviceId: 'svc' }, never)) as {
      pairing: PairingView
    }
    say(
      'chainStart',
      pairing.original.host === '127.0.0.1' && pairing.original.name === svc.alias,
      {
        original: pairing.original,
      },
    )
    say('chainKeyLine', has(`litch-pair:${pairing.pairId}`))
    await core.command('pairing.cancel', { deviceId: 'svc', pairId: pairing.pairId }, never)
    // 作废之后设备把一次性钥匙行删掉（异步，等一会儿）
    let gone = false
    for (let i = 0; i < 50 && !gone; i++) {
      gone = !has(`litch-pair:${pairing.pairId}`)
      if (!gone) await new Promise((done) => setTimeout(done, 100))
    }
    say('chainCancelled', gone)
    const { phones } = (await core.command('pairing.phones', { deviceId: 'svc' }, never)) as {
      phones: unknown[]
    }
    say('chainPhones', Array.isArray(phones), { phones })
  } catch (error) {
    const shape = error as { code?: string; key?: string; message?: string }
    say('chainStart', false, { code: shape.code, key: shape.key, message: shape.message })
  }
}
core.stop()
setTimeout(() => process.exit(failed === 0 ? 0 : 1), 300)
