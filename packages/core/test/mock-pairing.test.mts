// 模拟核心里的扫码绑定手机：界面在浏览器里对着它走完整个流程，所以它要和真的核心一个样——
// 出码之后有手机来登记、确认码、允许之后手机进了列表、拒绝、取消、到期作废、撤销、记住地址、不支持和没连上的设备。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type ChannelError,
  createMockCore,
  decodePairPayload,
  encodePairPayload,
  type PairingOp,
  type PairingTopicView,
  type PairingView,
  type PairStatus,
  pairingPayload,
} from '../src/index.mjs'
import { fakeClock, settle } from './helpers.mjs'

const never = { aborted: false, addEventListener() {} }

// 模拟的手机在出码后 800 毫秒（chunkMs 的 80 倍）来登记；ttl 比这短就能演“没人扫、到期作废”
function setup(pairTtlMs = 60_000) {
  const time = fakeClock()
  const core = createMockCore({ clock: time.clock, chunkMs: 10, pairTtlMs })
  const command = (name: string, params: object) => core.command(name, params, never)
  let view: PairingTopicView | null = null
  const ops: PairingOp[] = []
  core.subscribe(
    { kind: 'pairing', deviceId: 'build' },
    {
      snapshot: (data) => {
        view = data as PairingTopicView
      },
      delta: (next) => ops.push(...(next as PairingOp[])),
      error() {},
    },
  )
  const latest = (pairId: string): PairStatus | undefined =>
    ops
      .flatMap((op) => (op.op === 'pair.status' && op.status.pairId === pairId ? [op.status] : []))
      .at(-1)
  return { time, command, view: () => view, ops, latest }
}

async function failureOf(run: Promise<unknown>): Promise<ChannelError> {
  try {
    await run
  } catch (error) {
    return error as ChannelError
  }
  throw new Error('这条命令本该失败')
}

test('出码 → 手机来登记带确认码 → 允许 → 手机进了列表；二维码文本拼得出、解得回', async () => {
  const s = setup()
  assert.equal(s.view()?.available, true)
  assert.equal(s.view()?.phones?.length, 1)
  const { pairing } = (await s.command('pairing.start', { deviceId: 'build' })) as {
    pairing: PairingView
  }
  assert.deepEqual(pairing.original, { name: 'build-01', host: '10.0.3.11', port: 22, user: 'dev' })
  assert.equal(s.latest(pairing.pairId)?.state, 'waiting')
  assert.equal(pairing.mode, 'key')
  const text = encodePairPayload(pairingPayload(pairing, pairing.address))
  assert.equal(decodePairPayload(text)?.i, pairing.pairId)

  s.time.advance(1000)
  await settle()
  const asked = s.latest(pairing.pairId)
  assert.equal(asked?.state, 'requested')
  assert.match(asked?.phone?.code ?? '', /^\d{6}$/)
  const { status } = (await s.command('pairing.decide', {
    deviceId: 'build',
    pairId: pairing.pairId,
    allow: true,
  })) as { status: PairStatus }
  assert.equal(status.state, 'done')
  const phones = s.ops.filter((op) => op.op === 'phones.set').at(-1)
  assert.equal(phones?.op === 'phones.set' ? phones.phones.length : 0, 2)
  // 作废了的不再变：到期也不会改成 expired
  s.time.advance(120_000)
  await settle()
  assert.equal(s.latest(pairing.pairId)?.state, 'done')

  // 撤销
  const id = phones?.op === 'phones.set' ? phones.phones[1]?.phoneId : ''
  await s.command('pairing.revoke', { deviceId: 'build', phoneId: id })
  const after = s.ops.filter((op) => op.op === 'phones.set').at(-1)
  assert.equal(after?.op === 'phones.set' ? after.phones.length : -1, 1)
})

test('拒绝、取消、到期；记住的地址预填；不支持、没连上的设备', async () => {
  const s = setup()
  const start = async () =>
    ((await s.command('pairing.start', { deviceId: 'build' })) as { pairing: PairingView }).pairing
  const one = await start()
  s.time.advance(1000)
  await settle()
  await s.command('pairing.decide', { deviceId: 'build', pairId: one.pairId, allow: false })
  assert.equal(s.latest(one.pairId)?.state, 'rejected')

  const two = await start()
  await s.command('pairing.cancel', { deviceId: 'build', pairId: two.pairId })
  assert.equal(s.latest(two.pairId)?.state, 'cancelled')

  const address = { name: '开发机', host: 'device-ts', port: 22, user: 'dev' }
  await s.command('pairing.rememberAddress', { deviceId: 'build', address })
  const three = await start()
  assert.deepEqual(three.address, address)
  assert.equal(three.original.host, '10.0.3.11')

  const quick = setup(500)
  const four = (
    (await quick.command('pairing.start', { deviceId: 'build' })) as { pairing: PairingView }
  ).pairing
  quick.time.advance(500)
  await settle()
  assert.equal(quick.latest(four.pairId)?.state, 'expired')
  quick.time.advance(1000)
  await settle()
  assert.equal(quick.latest(four.pairId)?.state, 'expired')

  assert.equal(
    (await failureOf(s.command('pairing.start', { deviceId: 'nas' }))).key,
    'unsupported',
  )
  assert.equal((await failureOf(s.command('pairing.start', { deviceId: 'gpu' }))).key, 'offline')
  const local = (await s.command('pairing.start', { deviceId: 'local' })) as {
    pairing: PairingView
  }
  assert.equal(local.pairing.original.port, 22)
})

test('手机已经来请求的不因二维码到期作废，两分钟没人表态判拒绝', async () => {
  const s = setup()
  const { pairing } = (await s.command('pairing.start', { deviceId: 'build' })) as {
    pairing: PairingView
  }
  s.time.advance(1000)
  await settle()
  assert.equal(s.latest(pairing.pairId)?.state, 'requested')
  s.time.advance(60_000)
  await settle()
  assert.equal(s.latest(pairing.pairId)?.state, 'requested')
  s.time.advance(60_000)
  await settle()
  const status = s.latest(pairing.pairId)
  assert.equal(status?.state, 'rejected')
  assert.equal(status?.phone?.name, '小米 15')
})
