// 配对的状态机：start → enroll → decide，过期、拒绝、2 分钟没表态、取消、重复登记、长轮询、撤销、启动时清理。
// 时间用假时钟拨，钥匙文件在临时目录里。
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  PAIR_DECIDE_TIMEOUT_MS,
  PAIR_TTL_MS,
  type PairStatus,
} from '../../protocol/src/device-pairing.mjs'
import { detectTailscaleSsh } from '../src/pair-host.mjs'
import { confirmCodeOf, parseEd25519Line, phoneIdOf } from '../src/pair-keys.mjs'
import { DevicePairing, PAIR_FORGET_MS, PAIR_WAIT_MS, type PairingConfig } from '../src/pairing.mjs'
import { FakeClock, type PairPlace, pairConfig, pairPlace, phoneKey } from './pair-kit.mjs'

interface Rig {
  place: PairPlace
  clock: FakeClock
  pairing: DevicePairing
  /** 发出去的通知 */
  sent: { method: string; params: any; extension: string }[]
  log: string[]
  call(method: string, params?: unknown): Promise<any>
  fails(method: string, params?: unknown): Promise<{ code: number; data?: any; message: string }>
  /** 钥匙文件现在的内容 */
  keys(): string
  close(): void
}

function rig(more: Partial<PairingConfig> = {}, place = pairPlace()): Rig {
  const clock = new FakeClock()
  const sent: Rig['sent'] = []
  const log: string[] = []
  const pairing = new DevicePairing(pairConfig(place, { clock, ...more }), {
    announce: (method, params, extension) => sent.push({ method, params, extension }),
    log: (line) => log.push(line),
  })
  const call = async (method: string, params: unknown = {}) => pairing.call(method, params)
  return {
    place,
    clock,
    pairing,
    sent,
    log,
    call,
    async fails(method, params = {}) {
      try {
        await call(method, params)
      } catch (error) {
        return error as any
      }
      throw new Error(`${method} 应该失败`)
    },
    keys: () => {
      try {
        return readFileSync(place.keysFile, 'utf8')
      } catch {
        return ''
      }
    },
    close() {
      pairing.close()
      rmSync(place.root, { recursive: true, force: true })
    },
  }
}

const enrollInput = (key: string, name = 'Pixel 8') => ({ v: 1, publicKey: key, name })

/** 发起登记，等它变成 requested（enroll 本身挂着） */
async function request(r: Rig, pairId: string, key = phoneKey(), name = 'Pixel 8') {
  const pending = r.call('litch/pair/enroll', {
    pairId,
    input: enrollInput(key, name),
  }) as Promise<any>
  const status: PairStatus = await r.call('litch/pair/wait', { pairId, since: 'waiting' })
  assert.equal(status.state, 'requested')
  return { pending, key, status }
}

test('start 写一次性钥匙行，回种子、主机钥匙、主机名和用户，通知 waiting', async () => {
  const r = rig()
  try {
    const started = await r.call('litch/pair/start')
    assert.match(started.pairId, /^[A-Za-z0-9]{16}$/)
    assert.match(started.seed, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(started.expiresAt, r.clock.now() + PAIR_TTL_MS)
    assert.equal(started.hostKey.type, 'ssh-ed25519')
    assert.deepEqual(started.hostKeys, [started.hostKey])
    assert.equal(started.hostname, 'test-host')
    assert.equal(started.user, 'tester')
    const lines = r.keys().trimEnd().split('\n')
    assert.equal(lines.length, 1)
    assert.match(
      lines[0] ?? '',
      new RegExp(
        `^restrict,command="'/opt/litch/bin/codex-harness-adapter' pair-enroll --home '/home/tester/.codex-harness-adapter' ${started.pairId}",expiry-time="\\d{14}Z" ssh-ed25519 \\S+ litch-pair:${started.pairId}$`,
      ),
    )
    assert.deepEqual(r.sent, [
      {
        method: 'litch/pair/changed',
        params: {
          pairId: started.pairId,
          state: 'waiting',
          expiresAt: started.expiresAt,
          phone: null,
        },
        extension: 'devicePairing',
      },
    ])
  } finally {
    r.close()
  }
})

test('sshd 太老或认不出版本时不加 expiry-time', async () => {
  const r = rig({ sshdVersion: async () => null })
  try {
    await r.call('litch/pair/start')
    assert.doesNotMatch(r.keys(), /expiry-time/)
  } finally {
    r.close()
  }
})

test('登记、允许：追加手机行、删一次性钥匙行，enroll 回 ok，通知手机列表', async () => {
  const r = rig()
  try {
    mkdirSync(dirname(r.place.keysFile))
    writeFileSync(r.place.keysFile, 'ssh-ed25519 AAAAmine me@laptop\n')
    const { pairId } = await r.call('litch/pair/start')
    // 自检不消耗、不通知
    const notices = r.sent.length
    assert.deepEqual(await r.call('litch/pair/enroll', { pairId, input: { v: 1, probe: true } }), {
      ok: true,
      probe: true,
    })
    assert.equal(r.sent.length, notices)
    const { pending, key, status } = await request(r, pairId, phoneKey(), 'Pixel 8')
    const blob = parseEd25519Line(key)?.blob
    assert.ok(blob)
    const phoneId = phoneIdOf(blob)
    assert.equal(status.phone?.code, confirmCodeOf(pairId, key))
    assert.equal(status.phone?.name, 'Pixel 8')
    assert.equal(status.phone?.phoneId, phoneId)
    const decided: PairStatus = await r.call('litch/pair/decide', { pairId, allow: true })
    assert.equal(decided.state, 'done')
    assert.deepEqual(await pending, { ok: true, phoneId })
    const today = new Date(r.clock.now()).toISOString().slice(0, 10)
    assert.equal(
      r.keys(),
      `ssh-ed25519 AAAAmine me@laptop\n${key} litch-mobile:${phoneId} Pixel 8 ${today}\n`,
    )
    const phones = await r.call('litch/pair/phones')
    assert.equal(phones.data.length, 1)
    assert.equal(phones.data[0].phoneId, phoneId)
    assert.ok(r.sent.some((item) => item.method === 'litch/pair/phones/changed'))
    // 已经结束：再登记算用过了，再表态回 notRequested，自检回过期
    const again = await r.call('litch/pair/enroll', { pairId, input: enrollInput(phoneKey()) })
    assert.equal(again.error, 'used')
    assert.equal(
      (await r.fails('litch/pair/decide', { pairId, allow: true })).data.reason,
      'notRequested',
    )
    assert.equal(
      (await r.call('litch/pair/enroll', { pairId, input: { v: 1, probe: true } })).error,
      'expired',
    )
  } finally {
    r.close()
  }
})

test('同一把公钥已经在文件里就不重复写', async () => {
  const r = rig()
  try {
    const key = phoneKey()
    mkdirSync(dirname(r.place.keysFile))
    writeFileSync(r.place.keysFile, `${key} added-by-hand\n`)
    const { pairId } = await r.call('litch/pair/start')
    const { pending } = await request(r, pairId, key)
    await r.call('litch/pair/decide', { pairId, allow: true })
    assert.equal((await pending).ok, true)
    assert.equal(r.keys(), `${key} added-by-hand\n`)
  } finally {
    r.close()
  }
})

test('一个配对只接一部手机：requested 期间别的登记回 used，输入不对回 invalid 且不消耗', async () => {
  const r = rig()
  try {
    const { pairId } = await r.call('litch/pair/start')
    const bad = await r.call('litch/pair/enroll', {
      pairId,
      input: { v: 1, publicKey: 'ssh-rsa AAAA', name: 'x' },
    })
    assert.equal(bad.error, 'invalid')
    assert.equal((await r.call('litch/pair/enroll', { pairId, input: { v: 2 } })).error, 'invalid')
    const { pending } = await request(r, pairId)
    const second = await r.call('litch/pair/enroll', { pairId, input: enrollInput(phoneKey()) })
    assert.equal(second.error, 'used')
    await r.call('litch/pair/decide', { pairId, allow: false })
    assert.equal((await pending).error, 'rejected')
    assert.doesNotMatch(r.keys(), /litch-pair:|litch-mobile:/)
    // 不认识的配对号
    const unknown = await r.call('litch/pair/enroll', {
      pairId: 'ZZZZZZZZZZZZZZZZ',
      input: enrollInput(phoneKey()),
    })
    assert.equal(unknown.error, 'expired')
  } finally {
    r.close()
  }
})

test('2 分钟没表态按拒绝，手机收到 timeout', async () => {
  const r = rig()
  try {
    const { pairId } = await r.call('litch/pair/start')
    const { pending } = await request(r, pairId)
    r.clock.advance(PAIR_DECIDE_TIMEOUT_MS - 1)
    assert.equal((await r.call('litch/pair/wait', { pairId, since: null })).state, 'requested')
    r.clock.advance(1)
    assert.equal((await pending).error, 'timeout')
    const status = await r.call('litch/pair/wait', { pairId, since: null })
    assert.equal(status.state, 'rejected')
    assert.ok(status.phone)
    assert.equal(r.keys(), '')
  } finally {
    r.close()
  }
})

test('10 分钟过期：删行、通知 expired，之后登记回 expired；已经在登记的不因到期中断', async () => {
  const r = rig()
  try {
    const { pairId } = await r.call('litch/pair/start')
    r.clock.advance(PAIR_TTL_MS - 1)
    assert.match(r.keys(), /litch-pair:/)
    r.clock.advance(1)
    assert.equal(r.keys(), '')
    assert.equal(r.sent.at(-1)?.params.state, 'expired')
    assert.equal(
      (await r.call('litch/pair/enroll', { pairId, input: enrollInput(phoneKey()) })).error,
      'expired',
    )

    const second = await r.call('litch/pair/start')
    r.clock.advance(PAIR_TTL_MS - 1000)
    const { pending } = await request(r, second.pairId)
    r.clock.advance(5000)
    assert.equal(
      (await r.call('litch/pair/wait', { pairId: second.pairId, since: null })).state,
      'requested',
    )
    await r.call('litch/pair/decide', { pairId: second.pairId, allow: true })
    assert.equal((await pending).ok, true)
  } finally {
    r.close()
  }
})

test('取消：删行，挂着的登记回 expired；结束的配对过一阵就不认识了', async () => {
  const r = rig()
  try {
    const { pairId } = await r.call('litch/pair/start')
    const { pending } = await request(r, pairId)
    assert.deepEqual(await r.call('litch/pair/cancel', { pairId }), {})
    assert.equal((await pending).error, 'expired')
    assert.equal(r.keys(), '')
    // 再取消一次什么都不做
    await r.call('litch/pair/cancel', { pairId })
    r.clock.advance(PAIR_FORGET_MS)
    const gone = await r.fails('litch/pair/cancel', { pairId })
    assert.equal(gone.code, -32602)
    assert.equal(gone.data.reason, 'unknownPair')
  } finally {
    r.close()
  }
})

test('wait：状态不同立刻回，相同就等到变了，最多 30 秒', async () => {
  const r = rig()
  try {
    const { pairId } = await r.call('litch/pair/start')
    assert.equal((await r.call('litch/pair/wait', { pairId, since: null })).state, 'waiting')
    let settled: PairStatus | null = null
    const waiting = r.call('litch/pair/wait', { pairId, since: 'waiting' }).then((status) => {
      settled = status
    })
    await new Promise((resolve) => setImmediate(resolve))
    r.clock.advance(PAIR_WAIT_MS - 1)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(settled, null)
    r.clock.advance(1)
    await waiting
    assert.equal((settled as PairStatus | null)?.state, 'waiting')
    const later = r.call('litch/pair/wait', { pairId, since: 'waiting' })
    await r.call('litch/pair/cancel', { pairId })
    assert.equal((await later).state, 'cancelled')
  } finally {
    r.close()
  }
})

test('撤销手机：删它的行，没有回 unknownPhone', async () => {
  const r = rig()
  try {
    const { pairId } = await r.call('litch/pair/start')
    const { pending, status } = await request(r, pairId)
    await r.call('litch/pair/decide', { pairId, allow: true })
    await pending
    const phoneId = status.phone?.phoneId
    assert.deepEqual(await r.call('litch/pair/revoke', { phoneId }), {})
    assert.equal(r.keys(), '')
    // 通知要等开没开 Tailscale SSH 的结果，晚一拍
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(r.sent.at(-1), {
      method: 'litch/pair/phones/changed',
      params: { data: [], tailscaleSsh: false },
      extension: 'devicePairing',
    })
    assert.equal((await r.fails('litch/pair/revoke', { phoneId })).data.reason, 'unknownPhone')
    assert.equal((await r.fails('litch/pair/revoke', { phoneId: 'nope' })).code, -32602)
  } finally {
    r.close()
  }
})

test('启动时删掉上次留下的一次性钥匙行，别的字节不动；关闭时删还没结束的', async () => {
  const place = pairPlace()
  mkdirSync(dirname(place.keysFile))
  const original =
    'ssh-ed25519 AAAAmine me\r\nrestrict ssh-ed25519 AAAAold litch-pair:OLDOLDOLDOLDOLD1\nssh-rsa AAAAx y'
  writeFileSync(place.keysFile, original)
  const r = rig({}, place)
  try {
    assert.equal(r.keys(), 'ssh-ed25519 AAAAmine me\r\nssh-rsa AAAAx y')
    assert.ok(r.log.some((line) => line.includes('1 行')))
    await r.call('litch/pair/start')
    assert.match(r.keys(), /litch-pair:/)
    r.pairing.close()
    assert.equal(r.keys(), 'ssh-ed25519 AAAAmine me\r\nssh-rsa AAAAx y\n')
  } finally {
    r.close()
  }
})

test('不支持、读不到主机钥匙、钥匙文件改不了时 start 报对应的原因', async () => {
  const none = rig({ adapterCli: '' })
  try {
    assert.equal(none.pairing.available, false)
    assert.equal((await none.fails('litch/pair/start')).data.reason, 'unsupported')
    assert.equal((await none.fails('litch/pair/phones')).data.reason, 'unsupported')
  } finally {
    none.close()
  }
  const odd = rig({ adapterCli: '/opt/litch\n/bin/x' })
  try {
    assert.equal(odd.pairing.available, false)
  } finally {
    odd.close()
  }
  const admin = rig({ unsupported: 'Windows 管理员账号' })
  try {
    assert.equal(admin.pairing.available, false)
  } finally {
    admin.close()
  }
  const noHost = rig({ hostKeys: () => [] })
  try {
    const failure = await noHost.fails('litch/pair/start')
    assert.deepEqual([failure.code, failure.data.reason], [-32000, 'noHostKey'])
  } finally {
    noHost.close()
  }
  if (process.platform !== 'win32') {
    const place = pairPlace()
    mkdirSync(dirname(place.keysFile))
    writeFileSync(join(place.root, 'real'), 'x\n')
    symlinkSync(join(place.root, 'real'), place.keysFile)
    const linked = rig({}, place)
    try {
      assert.equal((await linked.fails('litch/pair/start')).data.reason, 'keysFile')
      assert.equal(readFileSync(join(place.root, 'real'), 'utf8'), 'x\n')
    } finally {
      linked.close()
    }
  }
})

test('Tailscale 方式：不写一次性钥匙行，回登记命令；登记、允许照旧写手机行，结束时没有行要删', async () => {
  const r = rig({ tailscaleSsh: async () => true })
  try {
    mkdirSync(dirname(r.place.keysFile))
    writeFileSync(r.place.keysFile, 'ssh-ed25519 AAAAmine me@laptop\n')
    const started = await r.call('litch/pair/start', { mode: 'tailscale' })
    assert.equal(started.mode, 'tailscale')
    assert.equal(started.seed, undefined)
    assert.equal(started.tailscaleSsh, true)
    assert.equal(
      started.enrollCommand,
      `'/opt/litch/bin/codex-harness-adapter' pair-enroll --home '/home/tester/.codex-harness-adapter' ${started.pairId}`,
    )
    assert.equal(r.keys(), 'ssh-ed25519 AAAAmine me@laptop\n')
    const { pairId } = started
    assert.deepEqual(await r.call('litch/pair/enroll', { pairId, input: { v: 1, probe: true } }), {
      ok: true,
      probe: true,
    })
    const { pending, key } = await request(r, pairId)
    await r.call('litch/pair/decide', { pairId, allow: true })
    const result = await pending
    assert.equal(result.ok, true)
    assert.ok(r.keys().startsWith(`ssh-ed25519 AAAAmine me@laptop\n${key} litch-mobile:`))
    assert.doesNotMatch(r.keys(), /litch-pair:/)
    const phones = await r.call('litch/pair/phones')
    assert.equal(phones.tailscaleSsh, true)
    assert.equal(phones.data.length, 1)
    // 过期、取消的也没有行要删，状态照常
    const other = await r.call('litch/pair/start', { mode: 'tailscale' })
    await r.call('litch/pair/cancel', { pairId: other.pairId })
    assert.equal(
      (await r.call('litch/pair/wait', { pairId: other.pairId, since: null })).state,
      'cancelled',
    )
  } finally {
    r.close()
  }
})

test('key 方式也回 mode 和 tailscaleSsh；开没开 Tailscale SSH 记 30 秒', async () => {
  let asked = 0
  let on = false
  const r = rig({
    tailscaleSsh: async () => {
      asked++
      return on
    },
  })
  try {
    const started = await r.call('litch/pair/start', { mode: 'key' })
    assert.deepEqual([started.mode, started.tailscaleSsh], ['key', false])
    assert.equal(started.enrollCommand, undefined)
    on = true
    assert.equal((await r.call('litch/pair/phones')).tailscaleSsh, false)
    assert.equal(asked, 1)
    r.clock.advance(30_000)
    assert.equal((await r.call('litch/pair/phones')).tailscaleSsh, true)
    assert.equal(asked, 2)
  } finally {
    r.close()
  }
})

test('mode 不认识回 -32602；Windows 上不支持 tailscale 方式', async () => {
  const r = rig()
  try {
    const failure = await r.fails('litch/pair/start', { mode: 'magic' })
    assert.deepEqual([failure.code, failure.data], [-32602, undefined])
  } finally {
    r.close()
  }
  const windows = rig({ platform: 'win32' })
  try {
    assert.equal(
      (await windows.fails('litch/pair/start', { mode: 'tailscale' })).data.reason,
      'unsupported',
    )
  } finally {
    windows.close()
  }
})

test('detectTailscaleSsh：认 tailscale debug prefs 的 RunSSH，命令不在、看不懂都算没开', {
  skip: process.platform === 'win32',
}, async () => {
  const place = pairPlace()
  try {
    const cli = (name: string, body: string) => {
      const file = join(place.root, name)
      writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
      return file
    }
    const prefs = (value: string) => ({
      LITCH_TAILSCALE_CLI: cli(
        `ts-${value}`,
        `[ "$1 $2" = "debug prefs" ] || exit 2\necho '{"RunSSH": ${value}, "Hostname": "h"}'`,
      ),
    })
    assert.equal(await detectTailscaleSsh(prefs('true')), true)
    assert.equal(await detectTailscaleSsh(prefs('false')), false)
    assert.equal(
      await detectTailscaleSsh({ LITCH_TAILSCALE_CLI: cli('ts-bad', 'echo nope') }),
      false,
    )
    assert.equal(await detectTailscaleSsh({ LITCH_TAILSCALE_CLI: cli('ts-fail', 'exit 1') }), false)
    assert.equal(
      await detectTailscaleSsh({ LITCH_TAILSCALE_CLI: join(place.root, 'missing') }),
      false,
    )
  } finally {
    rmSync(place.root, { recursive: true, force: true })
  }
})
