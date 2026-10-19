// 扫码绑定手机（devicePairing 扩展）：核心对着假的聚合面（fake-device.mts）、假的配对方法和假的外壳跑。
// 守的是这几条：握手声明、看设备的 extensions 决定能不能用、出码一步做完（本机先探 SSH 服务、主机钥匙核对、
// 自检，哪一步没过都把配对作废）、预填记住的地址而原配置不变、主题只跟这台桌面端开的配对、
// 已绑定的手机跟着通知走、撤销、记住的地址存进设备配置。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PairHostKey, PairStatus } from '../../protocol/src/device-pairing.mjs'
import {
  type ChannelError,
  checkPairingAddress,
  checkSaved,
  createCore,
  type DeviceStore,
  hostKeyTrusted,
  type PairingOp,
  type PairingPlatform,
  type PairingTopicView,
  type PairingView,
  type PairSelfTestInput,
  type SavedDevices,
} from '../src/index.mjs'
import { fakeDevice, harness } from './fake-device.mjs'
import { fakeOpener, RpcFailure } from './fake-server.mjs'
import { thread } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'

const never = { aborted: false, addEventListener() {} }

const ED: PairHostKey = {
  type: 'ssh-ed25519',
  fingerprint: 'SHA256:aaa',
  publicKey: 'ssh-ed25519 AAAAED',
}
const RSA: PairHostKey = {
  type: 'ssh-rsa',
  fingerprint: 'SHA256:bbb',
  publicKey: 'ssh-rsa AAAARSA',
}

interface Options {
  extensions?: string[]
  kind?: 'local' | 'ssh'
  known?: string[]
  sshOn?: boolean
  selfTest?: (input: PairSelfTestInput) => { ok: true } | { ok: false; said: string }
  startError?: RpcFailure
  store?: DeviceStore
}

function world(options: Options = {}) {
  const fake = fakeDevice([harness('pi', { threads: [thread({ id: 'p1' })] })])
  fake.device.extensions = options.extensions ?? ['harness', 'devicePairing']
  const calls = { tests: [] as PairSelfTestInput[], localSsh: 0 }
  let n = 0
  const phones = [{ phoneId: 'ph1', name: 'Pixel 8', fingerprint: 'SHA256:p1', addedAt: 5 }]
  const handlers = {
    'litch/pair/start': () => {
      if (options.startError) throw options.startError
      n++
      return {
        pairId: `pair${n}`,
        seed: 'c2VlZA',
        expiresAt: 1_000_000 + n,
        hostKey: ED,
        hostKeys: [ED, RSA],
        hostname: 'mac.lan',
        user: 'song',
      }
    },
    'litch/pair/cancel': () => ({}),
    'litch/pair/decide': (params: unknown) => {
      const { pairId, allow } = params as { pairId: string; allow: boolean }
      return { pairId, state: allow ? 'done' : 'rejected', expiresAt: 1, phone: null }
    },
    'litch/pair/phones': () => ({ data: phones }),
    'litch/pair/revoke': (params: unknown) => {
      const { phoneId } = params as { phoneId: string }
      if (!phones.some((phone) => phone.phoneId === phoneId)) {
        throw new RpcFailure(-32000, '没有这部手机', { reason: 'unknownPhone' })
      }
      return {}
    },
  }
  const peer = fakeOpener({ ...fake.handlers, ...handlers })
  const platform: PairingPlatform = {
    resolve: async () => ({ host: '10.0.0.5', port: 2222, user: 'dev' }),
    knownKeys: async () => options.known ?? ['ssh-rsa AAAARSA'],
    localSsh: async () => {
      calls.localSsh++
      return options.sshOn ?? true
    },
    localName: () => 'Song 的 MacBook',
    selfTest: async (input) => {
      calls.tests.push(input)
      return options.selfTest?.(input) ?? { ok: true }
    },
  }
  const time = fakeClock()
  const kind = options.kind ?? 'ssh'
  const core = createCore({
    clock: time.clock,
    version: '9.9.9',
    log: () => {},
    pairing: platform,
    ...(options.store ? { store: options.store } : {}),
    devices: [
      {
        id: 'dev',
        name: kind === 'ssh' ? 'build-01' : '本机',
        host: 'dev@build-01',
        kind,
        target: kind === 'ssh' ? { kind: 'alias', alias: 'build-01' } : null,
        wire: 'green',
        open: peer.open,
      },
    ],
  })
  const command = (name: string, params: object = {}) =>
    core.command(name, { deviceId: 'dev', ...params }, never)
  const sent = (method: string) =>
    peer.servers
      .flatMap((server) => server.seen)
      .filter((entry) => entry.method === method)
      .map((entry) => entry.params as Record<string, unknown>)
  const broadcast = (method: string, params: unknown) => {
    for (const server of peer.servers) server.notify(method, params)
  }
  const watch = () => {
    const seen = { snapshots: [] as PairingTopicView[], ops: [] as PairingOp[] }
    const close = core.subscribe(
      { kind: 'pairing', deviceId: 'dev' },
      {
        snapshot: (data) => seen.snapshots.push(structuredClone(data as PairingTopicView)),
        delta: (ops) => seen.ops.push(...structuredClone(ops as PairingOp[])),
        error() {},
      },
    )
    return { seen, close }
  }
  return { core, peer, calls, command, sent, broadcast, watch, phones }
}

const settled = async () => {
  for (let round = 0; round < 6; round++) await settle()
}

async function failureOf(run: Promise<unknown>): Promise<ChannelError> {
  try {
    await run
  } catch (error) {
    return error as ChannelError
  }
  throw new Error('这条命令本该失败')
}

const started = async (w: ReturnType<typeof world>): Promise<PairingView> =>
  ((await w.command('pairing.start')) as { pairing: PairingView }).pairing

/** 像界面那样订阅 app 主题，取这台设备现在的样子 */
const deviceView = (w: ReturnType<typeof world>) => {
  let pairing: boolean | undefined
  const close = w.core.subscribe(
    { kind: 'app' },
    {
      snapshot: (data) => {
        pairing = (data as { devices: { pairing: boolean }[] }).devices[0]?.pairing
      },
      delta() {},
      error() {},
    },
  )
  close()
  return pairing
}

test('握手声明 devicePairing；设备列了它才算支持，没列时出码以 unsupported 结束', async () => {
  const w = world()
  w.core.start()
  await settled()
  const init = w.sent('initialize')[0] as { capabilities: { litchExtensions: string[] } }
  assert.ok(init.capabilities.litchExtensions.includes('devicePairing'))
  assert.equal(deviceView(w), true)

  const old = world({ extensions: ['harness'] })
  old.core.start()
  await settled()
  assert.equal(deviceView(old), false)
  const failure = await failureOf(old.command('pairing.start'))
  assert.equal(failure.code, 'unsupported')
  assert.equal(failure.key, 'unsupported')
  assert.equal(old.sent('litch/pair/start').length, 0)
})

test('ssh 设备出码：核对主机钥匙、按别名自检，地址预填原配置、别名当名字', async () => {
  const w = world()
  w.core.start()
  await settled()
  const pairing = await started(w)
  assert.equal(pairing.pairId, 'pair1')
  assert.equal(pairing.seed, 'c2VlZA')
  assert.deepEqual(pairing.hostKey, ED)
  const original = { name: 'build-01', host: '10.0.0.5', port: 2222, user: 'dev' }
  assert.deepEqual(pairing.original, original)
  assert.deepEqual(pairing.address, original)
  assert.equal(w.calls.localSsh, 0)
  const [tested] = w.calls.tests
  assert.deepEqual(tested?.target, { kind: 'alias', alias: 'build-01' })
  assert.equal(tested?.seed, 'c2VlZA')
  assert.equal(tested?.hostKeys.length, 2)
  assert.equal(w.sent('litch/pair/cancel').length, 0)

  // 记住改过的地址：下一次预填它，原配置照旧
  const changed = { name: '开发机', host: 'device-ts', port: 22, user: 'dev' }
  await w.command('pairing.rememberAddress', { address: changed })
  const again = await started(w)
  assert.deepEqual(again.address, changed)
  assert.deepEqual(again.original, original)
  // 忘掉：回到原配置
  await w.command('pairing.rememberAddress', { address: null })
  assert.deepEqual((await started(w)).address, original)
  // 不合规矩的地址不记
  const bad = await failureOf(
    w.command('pairing.rememberAddress', { address: { ...changed, host: '-oProxy' } }),
  )
  assert.equal(bad.code, 'invalid')
})

test('主机钥匙对不上、自检没过：配对作废，报对应的 key，自检的原话照出', async () => {
  const mismatch = world({ known: ['ssh-ed25519 AAAAOTHER'] })
  mismatch.core.start()
  await settled()
  const one = await failureOf(mismatch.command('pairing.start'))
  assert.equal(one.key, 'hostKeyMismatch')
  assert.equal(mismatch.calls.tests.length, 0)
  assert.deepEqual(mismatch.sent('litch/pair/cancel'), [{ pairId: 'pair1' }])

  const unknown = world({ known: [] })
  unknown.core.start()
  await settled()
  assert.equal((await failureOf(unknown.command('pairing.start'))).key, 'hostKeyMismatch')

  const denied = world({ selfTest: () => ({ ok: false, said: 'Permission denied (publickey).' }) })
  denied.core.start()
  await settled()
  const two = await failureOf(denied.command('pairing.start'))
  assert.equal(two.code, 'rejected')
  assert.equal(two.key, 'selfTest')
  assert.equal(two.message, 'Permission denied (publickey).')
  assert.deepEqual(denied.sent('litch/pair/cancel'), [{ pairId: 'pair1' }])
})

test('设备回的 keysFile、noHostKey 换成同名的 key', async () => {
  for (const reason of ['keysFile', 'noHostKey'] as const) {
    const w = world({ startError: new RpcFailure(-32000, `坏了：${reason}`, { reason }) })
    w.core.start()
    await settled()
    const failure = await failureOf(w.command('pairing.start'))
    assert.equal(failure.key, reason)
    assert.equal(failure.message, `坏了：${reason}`)
  }
})

test('本机：先探 SSH 服务，没开报 sshOff 且不建配对；开着时直接信设备报的主机钥匙，自检连本机', async () => {
  const off = world({ kind: 'local', sshOn: false })
  off.core.start()
  await settled()
  const failure = await failureOf(off.command('pairing.start'))
  assert.equal(failure.key, 'sshOff')
  assert.equal(off.sent('litch/pair/start').length, 0)

  // known_hosts 里什么都没有也照样过：本机不比
  const on = world({ kind: 'local', known: [] })
  on.core.start()
  await settled()
  const pairing = await started(on)
  assert.deepEqual(pairing.original, {
    name: 'Song 的 MacBook',
    host: 'mac.lan',
    port: 22,
    user: 'song',
  })
  const [tested] = on.calls.tests
  assert.equal(tested?.target, null)
  assert.equal(tested?.user, 'song')
})

test('主题：订阅时去取已绑定的手机；只跟自己开的配对；手机的变化跟着通知；撤销先改', async () => {
  const w = world()
  w.core.start()
  await settled()
  const { seen, close } = w.watch()
  await settled()
  assert.equal(seen.snapshots[0]?.available, true)
  assert.equal(w.sent('litch/pair/phones').length, 1)
  assert.deepEqual(seen.ops.at(-1), { op: 'phones.set', phones: w.phones })

  const pairing = await started(w)
  assert.deepEqual(seen.ops.at(-1), {
    op: 'pair.status',
    status: { pairId: pairing.pairId, state: 'waiting', expiresAt: pairing.expiresAt, phone: null },
  })
  const requested: PairStatus = {
    pairId: pairing.pairId,
    state: 'requested',
    expiresAt: pairing.expiresAt,
    phone: { phoneId: 'ph2', name: 'iPhone', fingerprint: 'SHA256:p2', code: '123456' },
  }
  w.broadcast('litch/pair/changed', requested)
  // 别处开的配对不管
  w.broadcast('litch/pair/changed', { ...requested, pairId: 'elsewhere' })
  await settled()
  assert.deepEqual(seen.ops.at(-1), { op: 'pair.status', status: requested })
  assert.deepEqual(
    ((await w.command('pairing.status', { pairId: pairing.pairId })) as { status: PairStatus })
      .status,
    requested,
  )
  const decided = (await w.command('pairing.decide', { pairId: pairing.pairId, allow: true })) as {
    status: PairStatus
  }
  assert.equal(decided.status.state, 'done')
  assert.deepEqual(w.sent('litch/pair/decide'), [{ pairId: pairing.pairId, allow: true }])
  // 作废了的不会再活过来
  w.broadcast('litch/pair/changed', requested)
  await settled()
  assert.equal(seen.ops.at(-1)?.op, 'pair.status')
  assert.equal((seen.ops.at(-1) as { status: PairStatus }).status.state, 'done')

  const more = [
    ...w.phones,
    { phoneId: 'ph2', name: 'iPhone', fingerprint: 'SHA256:p2', addedAt: 9 },
  ]
  w.broadcast('litch/pair/phones/changed', { data: more })
  await settled()
  assert.deepEqual(seen.ops.at(-1), { op: 'phones.set', phones: more })

  await w.command('pairing.revoke', { phoneId: 'ph1' })
  assert.deepEqual(w.sent('litch/pair/revoke'), [{ phoneId: 'ph1' }])
  assert.deepEqual(seen.ops.at(-1), { op: 'phones.set', phones: [more[1]] })
  const gone = await failureOf(w.command('pairing.revoke', { phoneId: 'nope' }))
  assert.equal(gone.code, 'notFound')

  // pairing.phones 每次现取
  const listed = (await w.command('pairing.phones')) as { phones: unknown[] }
  assert.equal(listed.phones.length, 1)
  assert.equal(w.sent('litch/pair/phones').length, 2)
  close()
})

test('取消：设备上已经没有了也当作作废；没连上时出码以 offline 结束', async () => {
  const w = world()
  w.core.start()
  await settled()
  const pairing = await started(w)
  await w.command('pairing.cancel', { pairId: pairing.pairId })
  assert.deepEqual(w.sent('litch/pair/cancel'), [{ pairId: pairing.pairId }])
  const status = (await w.command('pairing.status', { pairId: pairing.pairId })) as {
    status: PairStatus
  }
  assert.equal(status.status.state, 'cancelled')
  // 已经作废的再取消不发请求
  await w.command('pairing.cancel', { pairId: pairing.pairId })
  assert.equal(w.sent('litch/pair/cancel').length, 1)

  const idle = world()
  const failure = await failureOf(idle.command('pairing.start'))
  assert.equal(failure.code, 'offline')
  assert.equal(failure.key, 'offline')
})

test('记住的地址存进设备配置；读回来时只留认识的设备', async () => {
  let saved: SavedDevices = { localWire: null, remotes: [] }
  const store: DeviceStore = {
    load: () => saved,
    save(next) {
      saved = JSON.parse(JSON.stringify(next))
    },
    snapshot: () => ({ load: () => null, save() {} }),
    forget() {},
  }
  const w = world({ kind: 'local', store })
  const address = { name: '我的 Mac', host: 'mac-ts', port: 22, user: 'song' }
  await w.command('pairing.rememberAddress', { address })
  assert.deepEqual(saved.pairing, { dev: address })
  await w.command('pairing.rememberAddress', { address: null })
  assert.equal(saved.pairing, undefined)
  // 读回来时只留认识的设备：dev 不是本机也不在远程设备里，丢掉
  assert.equal(checkSaved({ pairing: { dev: address } }).pairing, undefined)
  assert.deepEqual(checkSaved({ pairing: { local: address } }).pairing, { local: address })
})

test('主机钥匙核对、地址检查', () => {
  assert.equal(hostKeyTrusted([ED, RSA], ['ssh-rsa AAAARSA comment']), true)
  assert.equal(hostKeyTrusted([ED], ['  ssh-ed25519   AAAAED  ']), true)
  assert.equal(hostKeyTrusted([ED], ['ssh-rsa AAAAED']), false)
  assert.equal(hostKeyTrusted([ED], []), false)
  const ok = { name: ' 开发机 ', host: ' device-ts ', port: 2222, user: 'dev' }
  assert.deepEqual(checkPairingAddress(ok), {
    name: '开发机',
    host: 'device-ts',
    port: 2222,
    user: 'dev',
  })
  for (const bad of [
    { ...ok, name: '' },
    { ...ok, host: 'a b' },
    { ...ok, host: '-x' },
    { ...ok, host: 'u@h' },
    { ...ok, user: '' },
    { ...ok, port: 0 },
    { ...ok, port: 70000 },
    { ...ok, port: 22.5 },
    { ...ok, name: 'x'.repeat(65) },
    null,
  ]) {
    assert.equal(checkPairingAddress(bad), null, JSON.stringify(bad))
  }
})
