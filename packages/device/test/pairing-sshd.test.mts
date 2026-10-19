// 用户态的真 sshd 端到端（做法同 scripts/client-ssh-fixture.mjs）：临时主机钥匙，AuthorizedKeysFile 指到临时的钥匙文件。
// 一次性钥匙登录后只能跑强制命令（这里是 pair-enroll-stand-in.mjs，代替 Go 的子命令）；登记后手机钥匙能登录、
// 一次性钥匙不能了；过期的残留行登录被拒；没过期的残留行能登进去但登记回 expired。
// 一律在临时目录里，不碰这台机器真的 ~/.ssh（ssh 用 -F /dev/null、IdentityAgent none、临时 known_hosts）。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { detectSshdVersion, readHostKeys } from '../src/pair-host.mjs'
import { newOneTimeKey, oneTimeLine } from '../src/pair-keys.mjs'
import { listenUnix } from '../src/sockets.mjs'
import { rig, TestClient, tempDir } from './helpers.mjs'
import { openSshPrivateKey } from './pair-kit.mjs'

const sshd = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((path) => existsSync(path))
const skip = process.platform === 'win32' || !sshd ? '这台机器上没有 sshd' : false

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

const q = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

test('真 sshd：一次性钥匙只能登记，登记后手机钥匙能登录，残留行无害', {
  skip,
  timeout: 120_000,
}, async () => {
  const root = tempDir()
  const stop: (() => unknown)[] = []
  try {
    const hostKeysDir = join(root, 'etc-ssh')
    const home = join(root, 'home')
    mkdirSync(hostKeysDir)
    mkdirSync(home)
    execFileSync('ssh-keygen', [
      '-q',
      '-t',
      'ed25519',
      '-N',
      '',
      '-C',
      'host',
      '-f',
      join(hostKeysDir, 'ssh_host_ed25519_key'),
    ])
    execFileSync('ssh-keygen', [
      '-q',
      '-t',
      'ed25519',
      '-N',
      '',
      '-C',
      'phone',
      '-f',
      join(root, 'phone_key'),
    ])
    const keysFile = join(root, 'ssh', 'authorized_keys')
    const socket = join(root, 'device.sock')
    // 强制命令里的“适配器”：一个转给替身的小脚本。sshd 起的会话没有我们的环境，路径都写死在里面
    const standIn = fileURLToPath(new URL('./pair-enroll-stand-in.mjs', import.meta.url))
    const cli = join(root, 'litch adapter')
    writeFileSync(cli, `#!/bin/sh\nexec ${q(process.execPath)} ${q(standIn)} ${q(socket)} "$@"\n`)
    chmodSync(cli, 0o755)

    const device = rig(
      {},
      {},
      {
        pairing: {
          keysFile,
          hostKeys: () => readHostKeys(hostKeysDir),
          adapterCli: cli,
          adapterHome: root,
          unsupported: null,
          sshdVersion: () => detectSshdVersion(),
        },
      },
    )
    stop.push(() => device.close())
    const listener = await listenUnix(socket, (wire) => device.device.attach(wire))
    stop.push(() => listener.close())

    const port = await freePort()
    writeFileSync(
      join(root, 'sshd_config'),
      [
        `Port ${port}`,
        'ListenAddress 127.0.0.1',
        `HostKey ${join(hostKeysDir, 'ssh_host_ed25519_key')}`,
        `PidFile ${join(root, 'sshd.pid')}`,
        `AuthorizedKeysFile ${keysFile}`,
        'PubkeyAuthentication yes',
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'UsePAM no',
        'StrictModes no',
        `SetEnv HOME=${home}`,
        '',
      ].join('\n'),
    )
    let sshdLog = ''
    const daemon = spawn(sshd as string, ['-D', '-e', '-f', join(root, 'sshd_config')], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    daemon.stderr.on('data', (chunk) => {
      sshdLog = (sshdLog + chunk).slice(-8000)
    })
    stop.push(() => daemon.kill('SIGTERM'))
    await waitListening(port, () => sshdLog)

    const client = new TestClient(device.device)
    const started = await client.call('litch/pair/start', {})
    // 主机钥匙钉住：known_hosts 里只放设备自报的那一把
    writeFileSync(join(root, 'known_hosts'), `[127.0.0.1]:${port} ${started.hostKey.publicKey}\n`)
    const oneTime = join(root, 'one_time_key')
    writeFileSync(oneTime, openSshPrivateKey(started.seed), { mode: 0o600 })

    const ssh = (key: string, input: string, command: string[] = []) =>
      run(
        'ssh',
        [
          '-F',
          '/dev/null',
          '-i',
          key,
          '-o',
          'IdentitiesOnly=yes',
          '-o',
          'IdentityAgent=none',
          '-o',
          'BatchMode=yes',
          '-o',
          `UserKnownHostsFile=${join(root, 'known_hosts')}`,
          '-o',
          'GlobalKnownHostsFile=/dev/null',
          '-o',
          'StrictHostKeyChecking=yes',
          '-o',
          `HostKeyAlgorithms=${started.hostKey.type}`,
          '-p',
          String(port),
          `${userInfo().username}@127.0.0.1`,
          ...command,
        ],
        input,
      )

    // 要求跑别的命令也没用：只跑强制命令（这里是自检，不消耗）
    const probe = await ssh(oneTime, '{"v":1,"probe":true}\n', ['echo', 'hacked'])
    assert.equal(probe.stdout.trim(), '{"ok":true,"probe":true}', `${probe.stderr}\n${sshdLog}`)
    assert.doesNotMatch(probe.stdout, /hacked/)

    // 手机登记，出码的一方允许
    const phonePub = readFileSync(join(root, 'phone_key.pub'), 'utf8')
      .trim()
      .split(' ')
      .slice(0, 2)
      .join(' ')
    const enrolling = ssh(
      oneTime,
      `${JSON.stringify({ v: 1, publicKey: phonePub, name: 'Test Phone' })}\n`,
    )
    const requested = await client.call('litch/pair/wait', {
      pairId: started.pairId,
      since: 'waiting',
    })
    assert.equal(requested.state, 'requested')
    await client.call('litch/pair/decide', { pairId: started.pairId, allow: true })
    const enrolled = await enrolling
    const result = JSON.parse(enrolled.stdout.trim())
    assert.equal(result.ok, true, enrolled.stderr)
    assert.equal(result.phoneId, requested.phone.phoneId)

    // 手机的钥匙能登录、跑什么都行；一次性钥匙已经删了，登不进去
    const phone = await ssh(join(root, 'phone_key'), '', ['echo', 'phone-ok'])
    assert.equal(phone.stdout.trim(), 'phone-ok', `${phone.stderr}\n${sshdLog}`)
    const reused = await ssh(oneTime, '{"v":1,"probe":true}\n')
    assert.equal(reused.code, 255)
    assert.match(reused.stderr, /Permission denied/)

    // 残留的行：过期的被 sshd 拒；没过期的能登进去，但设备服务不认这个配对号，登记回 expired
    const stale = newOneTimeKey()
    const fresh = newOneTimeKey()
    const command = (id: string) => `${q(cli)} pair-enroll --home ${q(root)} ${id}`
    writeFileSync(
      keysFile,
      `${oneTimeLine('STALESTALESTALE1', stale.publicKeyLine, command('STALESTALESTALE1'), '20200101000000Z')}\n` +
        `${oneTimeLine('LEFTOVERLEFTOVER', fresh.publicKeyLine, command('LEFTOVERLEFTOVER'), null)}\n`,
      { flag: 'a' },
    )
    const staleKey = join(root, 'stale_key')
    writeFileSync(staleKey, openSshPrivateKey(stale.seed), { mode: 0o600 })
    const expired = await ssh(staleKey, '{"v":1,"probe":true}\n')
    assert.equal(expired.code, 255)
    assert.match(expired.stderr, /Permission denied/)
    const freshKey = join(root, 'fresh_key')
    writeFileSync(freshKey, openSshPrivateKey(fresh.seed), { mode: 0o600 })
    const leftover = await ssh(
      freshKey,
      `${JSON.stringify({ v: 1, publicKey: phonePub, name: 'x' })}\n`,
    )
    assert.equal(
      JSON.parse(leftover.stdout.trim()).error,
      'expired',
      `${leftover.stderr}\n${sshdLog}`,
    )
  } finally {
    for (const step of stop.reverse()) await step()
    rmSync(root, { recursive: true, force: true })
  }
})

async function waitListening(port: number, log: () => string): Promise<void> {
  for (let n = 0; ; n++) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = connect(port, '127.0.0.1')
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
    })
    if (ok) return
    if (n > 100) throw new Error(`sshd 没有在监听：\n${log()}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function run(command: string, args: string[], input: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}
