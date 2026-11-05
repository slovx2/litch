import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ChannelError, hostKeyTrusted } from '@litch/core'
import { createPairing, type PairingHost } from '../../../../packages/core/src/device/pairing.mjs'
import {
  detectSshdVersion,
  listenerHostKeys,
  readHostKeys,
} from '../../../../packages/device/src/pair-host.mjs'
import { DevicePairing } from '../../../../packages/device/src/pairing.mjs'
import { desktopPairing } from '../pairing.mjs'

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number }
      server.close(() => resolve(address.port))
    })
  })

for (const hostType of ['ed25519', 'rsa'])
  test(`非标准 HostKey（${hostType}）与 TCP 转发：旧读取路径误判，known_hosts 查名正常`, {
    timeout: 30000,
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'litch-hostkey-'))
    const stops: (() => unknown)[] = []
    try {
      const system = join(root, 'etc-ssh')
      mkdirSync(system)
      mkdirSync(join(root, 'home'))
      for (const file of [
        join(system, 'ssh_host_ed25519_key'),
        join(root, 'custom-key'),
        join(root, 'client'),
      ]) {
        execFileSync('ssh-keygen', [
          '-q',
          '-t',
          file.endsWith('custom-key') ? hostType : 'ed25519',
          '-N',
          '',
          '-f',
          file,
        ])
      }
      const actual = readFileSync(join(root, 'custom-key.pub'), 'utf8')
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .join(' ')
      const version = await detectSshdVersion()
      const port = await freePort()
      const forwarded = await freePort()
      writeFileSync(join(root, 'authorized_keys'), readFileSync(join(root, 'client.pub')))
      writeFileSync(
        join(root, 'sshd_config'),
        [
          `Port ${port}`,
          'ListenAddress 127.0.0.1',
          `HostKey ${root}/custom-key`,
          `PidFile ${root}/pid`,
          `AuthorizedKeysFile ${root}/authorized_keys`,
          'UsePAM no',
          'StrictModes no',
          // 高频夹具握手不测 sshd 的限流；只改本次临时服务，不碰系统配置。
          ...(version && (version[0] > 9 || (version[0] === 9 && version[1] >= 8))
            ? ['PerSourcePenalties no']
            : []),
          'PasswordAuthentication no',
          'KbdInteractiveAuthentication no',
          `SetEnv HOME=${root}/home`,
          '',
        ].join('\n'),
      )
      const daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(root, 'sshd_config')])
      let log = ''
      daemon.stderr.on('data', (chunk) => {
        log += chunk
      })
      stops.push(() => daemon.kill())
      const proxy = createServer((socket) => {
        const remote = connect(port, '127.0.0.1')
        socket.pipe(remote).pipe(socket)
        socket.on('error', () => remote.destroy())
        remote.on('error', () => socket.destroy())
        socket.on('close', () => remote.destroy())
      })
      await new Promise<void>((resolve) => proxy.listen(forwarded, '127.0.0.1', resolve))
      stops.push(() => proxy.close())
      writeFileSync(
        join(root, 'known_hosts'),
        `[127.0.0.1]:${port} ${actual}\n[127.0.0.1]:${forwarded} ${actual}\nentry-alias ${actual}\n`,
      )
      writeFileSync(
        join(root, 'ssh_config'),
        [
          `Host direct forward aliased jumped`,
          '  HostName 127.0.0.1',
          `  User ${userInfo().username}`,
          `  IdentityFile ${root}/client`,
          '  IdentityAgent none',
          '  IdentitiesOnly yes',
          `  UserKnownHostsFile ${root}/known_hosts`,
          '  GlobalKnownHostsFile /dev/null',
          '  StrictHostKeyChecking yes',
          `Host direct aliased jumped`,
          `  Port ${port}`,
          `Host forward`,
          `  Port ${forwarded}`,
          'Host aliased',
          '  HostKeyAlias entry-alias',
          'Host jumped',
          '  ProxyJump direct',
          '',
        ].join('\n'),
      )
      process.env.LITCH_SSH_CONFIG = join(root, 'ssh_config')
      const platform = desktopPairing({ dataDir: root, localName: () => 'test' })
      const probe = join(root, 'probe')
      writeFileSync(probe, `#!/bin/sh\ncat >/dev/null\nprintf '{"ok":true,"probe":true}\\n'\n`, {
        mode: 0o700,
      })
      let useListener = true
      const device = new DevicePairing(
        {
          keysFile: join(root, 'authorized_keys'),
          adapterCli: probe,
          adapterHome: root,
          unsupported: null,
          hostKeys: async (endpoint) =>
            useListener && endpoint ? listenerHostKeys(endpoint) : readHostKeys(system),
          sshdVersion: async () => version,
          tailscaleSsh: async () => false,
        },
        { announce() {}, log() {} },
      )
      stops.push(() => device.close())
      const pairingFor = (alias: string) =>
        createPairing({
          deviceId: alias,
          kind: 'ssh',
          target: () => ({ kind: 'alias', alias }),
          displayName: () => alias,
          online: () => true,
          supported: () => true,
          approvals: () => false,
          platform,
          request: (async (method, params) =>
            device.call(method, params)) as PairingHost['request'],
          fail: (error) =>
            error instanceof ChannelError ? error : new ChannelError('remote', String(error)),
          log() {},
        })
      for (let i = 0; i < 50 && !(await platform.banner('127.0.0.1', port)); i++) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      assert.ok(await platform.banner('127.0.0.1', port), log)
      for (const alias of ['direct', 'forward', 'aliased', 'jumped']) {
        const target = { kind: 'alias' as const, alias }
        const resolved = await platform.resolve(target)
        const known = await platform.knownKeys(target)
        assert.deepEqual(known, [actual])
        assert.equal(hostKeyTrusted(readHostKeys(system), known), false)
        const inspected = await platform.inspect?.(target, resolved, resolved)
        assert.ok(inspected?.sshEndpoint)
        assert.equal(inspected.sshEndpoint.port, port)
        assert.equal(inspected.entrance[0]?.publicKey, actual)
        const corrected = await listenerHostKeys(inspected.sshEndpoint)
        assert.equal(hostKeyTrusted(corrected, known), true)
        const pair = pairingFor(alias)
        const ready = await pair.start()
        assert.equal(ready.hostKey.publicKey, actual)
        assert.equal(ready.checked, true)
        await pair.cancel(ready.pairId)
        assert.equal(
          readFileSync(join(root, 'authorized_keys'), 'utf8').includes('litch-pair:'),
          false,
        )
        console.log(
          JSON.stringify({
            alias,
            port: resolved.port,
            listenerPort: inspected.sshEndpoint.port,
            lookupCorrect: true,
            oldMismatch: true,
            corrected: true,
          }),
        )
      }
      // 模拟旧设备仍自报文件里的另一把钥匙：确认后仍钉住入口、自检不再沿用原 known_hosts。
      useListener = false
      for (const missing of [false, true]) {
        if (missing) writeFileSync(join(root, 'known_hosts'), '')
        const pair = pairingFor('direct')
        let warning: ChannelError | undefined
        try {
          await pair.start()
        } catch (error) {
          warning = error as ChannelError
        }
        assert.equal(warning?.key, 'hostKeyMismatch')
        assert.ok(warning.pairingHostKey)
        assert.equal(warning.pairingHostKey.reason, missing ? 'unknown' : 'mismatch')
        assert.equal(warning.pairingHostKey.selected.publicKey, actual)
        assert.equal(
          readFileSync(join(root, 'authorized_keys'), 'utf8').includes('litch-pair:'),
          false,
        )
        const ready = await pair.start({ hostKeyConfirmation: warning.pairingHostKey.token })
        assert.equal(ready.checked, true)
        assert.equal(ready.hostKey.publicKey, actual)
        await pair.cancel(ready.pairId)
        assert.equal(
          readFileSync(join(root, 'authorized_keys'), 'utf8').includes('litch-pair:'),
          false,
        )
      }
    } finally {
      delete process.env.LITCH_SSH_CONFIG
      for (const stop of stops.reverse()) stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
