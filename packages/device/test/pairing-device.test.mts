// 聚合面上的扫码绑定手机：runtime/info 列 devicePairing；方法不握手也能调（命令行直连 device.sock）；
// 两个通知只发给握手时声明了 devicePairing 的连接；应答和通知的形状按 protocol/extensions/device-pairing.json 校验。
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { Ajv } from 'ajv'
import { REPO, rig, TestClient } from './helpers.mjs'
import { pairConfig, pairPlace, phoneKey } from './pair-kit.mjs'

const definition = JSON.parse(
  readFileSync(join(REPO, 'protocol/extensions/device-pairing.json'), 'utf8'),
)
const ajv = new Ajv({ strict: false, allErrors: true })

function part(kind: string, method?: string): any {
  const found = definition.parts.find(
    (item: any) => item.kind === kind && (method === undefined || item.method === method),
  )
  if (!found) throw new Error(`扩展定义里没有 ${kind} ${method ?? ''}`)
  return found
}

function check(schema: unknown, value: unknown, what: string): void {
  const validate = ajv.compile({ ...(schema as object), definitions: definition.definitions })
  if (!validate(value))
    throw new Error(`${what} 和扩展定义对不上：${JSON.stringify(validate.errors)}`)
}

const response = (method: string, value: unknown) =>
  check(part('ClientRequest', method).response, value, `${method} 的应答`)
const params = (method: string, value: unknown) =>
  check(part('ClientRequest', method).params, value, `${method} 的参数`)
const notice = (method: string, value: unknown) =>
  check(part('ServerNotification', method).params, value, `${method} 的通知`)

test('runtime/info 列 devicePairing；不给配置时不列，方法回 unsupported', async () => {
  const place = pairPlace()
  const on = rig({}, {}, { pairing: pairConfig(place) })
  const off = rig({})
  try {
    const client = on.connect()
    await client.initialize(['harness'])
    assert.ok((await client.call('runtime/info')).device.extensions.includes('devicePairing'))
    const bare = off.connect()
    await bare.initialize(['harness'])
    assert.ok(!(await bare.call('runtime/info')).device.extensions.includes('devicePairing'))
    const failure = await bare.fails('litch/pair/start', {})
    assert.deepEqual([failure.code, failure.data], [-32000, { reason: 'unsupported' }])
    check(part('Error').data, failure.data, 'error.data')
    const unsupported = rig({}, {}, { pairing: pairConfig(place, { adapterCli: '' }) })
    try {
      const client2 = unsupported.connect()
      await client2.initialize(['harness'])
      assert.ok(!(await client2.call('runtime/info')).device.extensions.includes('devicePairing'))
    } finally {
      await unsupported.close()
    }
  } finally {
    await on.close()
    await off.close()
    rmSync(place.root, { recursive: true, force: true })
  }
})

test('不握手也能走完一次配对；通知只发给声明了 devicePairing 的连接', async () => {
  const place = pairPlace()
  const device = rig({}, {}, { pairing: pairConfig(place) })
  try {
    const declared = device.connect()
    await declared.initialize(['harness', 'devicePairing'])
    const plain = device.connect()
    await plain.initialize(['harness'])
    // 命令行：不握手
    const cli = new TestClient(device.device)
    const started = await cli.call('litch/pair/start', {})
    response('litch/pair/start', started)
    const { pairId } = started
    const enrollParams = { pairId, input: { v: 1, publicKey: phoneKey(), name: 'Pixel 8' } }
    params('litch/pair/enroll', enrollParams)
    // pair-enroll 子命令：另一条不握手的连接，挂着
    const enroller = new TestClient(device.device)
    const enrolled = enroller.call('litch/pair/enroll', enrollParams)
    const waited = await cli.call('litch/pair/wait', { pairId, since: 'waiting' })
    response('litch/pair/wait', waited)
    assert.equal(waited.state, 'requested')
    const requested = await declared.waitFor(
      (frame) =>
        frame.method === 'litch/pair/changed' && (frame.params as any).state === 'requested',
    )
    notice('litch/pair/changed', requested.params)
    const decided = await declared.call('litch/pair/decide', { pairId, allow: true })
    response('litch/pair/decide', decided)
    const result = await enrolled
    response('litch/pair/enroll', result)
    assert.equal(result.ok, true)
    const phones = await declared.waitFor((frame) => frame.method === 'litch/pair/phones/changed')
    notice('litch/pair/phones/changed', phones.params)
    const listed = await cli.call('litch/pair/phones', {})
    response('litch/pair/phones', listed)
    assert.equal(listed.data.length, 1)
    await declared.waitFor(
      (frame) => frame.method === 'litch/pair/changed' && (frame.params as any).state === 'done',
    )
    // 没声明的连接、不握手的连接都收不到这两个通知
    await new Promise((resolve) => setTimeout(resolve, 50))
    for (const client of [plain, cli, enroller])
      assert.ok(!client.notifications.some((frame) => frame.method?.startsWith('litch/pair/')))
    // 不认识的配对：-32602
    const unknown = await cli.fails('litch/pair/decide', {
      pairId: 'ZZZZZZZZZZZZZZZZ',
      allow: true,
    })
    assert.deepEqual([unknown.code, unknown.data], [-32602, { reason: 'unknownPair' }])
    response('litch/pair/revoke', await cli.call('litch/pair/revoke', { phoneId: result.phoneId }))
  } finally {
    await device.close()
    rmSync(place.root, { recursive: true, force: true })
  }
})

test('Tailscale 方式的应答也合扩展定义：没有 seed，有 enrollCommand', async () => {
  const place = pairPlace()
  const device = rig({}, {}, { pairing: pairConfig(place, { tailscaleSsh: async () => true }) })
  try {
    const cli = new TestClient(device.device)
    params('litch/pair/start', { mode: 'tailscale' })
    const started = await cli.call('litch/pair/start', { mode: 'tailscale' })
    response('litch/pair/start', started)
    assert.deepEqual(
      [started.mode, started.tailscaleSsh, 'seed' in started],
      ['tailscale', true, false],
    )
    // 两种方式的字段混在一起不合定义
    assert.throws(() => response('litch/pair/start', { ...started, seed: 'A'.repeat(43) }))
    const keyed = await cli.call('litch/pair/start', {})
    response('litch/pair/start', keyed)
    assert.throws(() =>
      response('litch/pair/start', { ...keyed, enrollCommand: started.enrollCommand }),
    )
    response('litch/pair/phones', await cli.call('litch/pair/phones', {}))
  } finally {
    await device.close()
    rmSync(place.root, { recursive: true, force: true })
  }
})
