import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { ChromeBridge } from '../src/bridge.mjs'

test('原生握手验证 token/来源，协议 1 往返与重连撤销在途调用', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'chrome-bridge-'))
  const path =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\chrome-test-${process.pid}`
      : join(root, 'bridge.sock')
  const id = 'a'.repeat(32),
    token = 'b'.repeat(64)
  const bridge = new ChromeBridge({
    socketPath: path,
    token,
    extensionIds: [id],
    version: '0.34.1',
    productName: 'Test',
    protocol: { min: 1, max: 1 },
  })
  const sockets: Socket[] = []
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await bridge.close()
    await rm(root, { recursive: true, force: true })
  })
  await bridge.start()
  const open = async () => {
    const socket = connect(path)
    sockets.push(socket)
    await once(socket, 'connect')
    return socket
  }
  for (const wrong of [
    { token: 'wrong', origin: `chrome-extension://${id}/` },
    { token, origin: `chrome-extension://${'c'.repeat(32)}/` },
  ]) {
    const socket = await open()
    socket.write(`${JSON.stringify({ kind: 'nativeHello', ...wrong })}\n`)
    await once(socket, 'close')
    assert.deepEqual(bridge.instances(), [])
  }
  const peer = async (epoch: string, protocol = 1) => {
    const socket = await open()
    const lines = createInterface({ input: socket })
    const welcome = once(lines, 'line')
    socket.write(
      `${JSON.stringify({ kind: 'nativeHello', token, origin: `chrome-extension://${id}/` })}\n`,
    )
    socket.write(
      `${JSON.stringify({ kind: 'hello', instanceId: 'instance', epoch, protocol, minProtocol: protocol, version: '0.34.1' })}\n`,
    )
    return { socket, lines, welcome: JSON.parse((await welcome)[0]) }
  }
  const first = await peer('first')
  assert.equal(first.welcome.protocol, 1)
  const request = once(first.lines, 'line')
  const result = bridge.call('instance', { op: 'list', args: {} })
  const call = JSON.parse((await request)[0])
  assert.equal(call.epoch, 'first')
  first.socket.write(`${JSON.stringify({ kind: 'result', id: call.id, result: ['ok'] })}\n`)
  assert.deepEqual(await result, ['ok'])
  const outstanding = bridge.call('instance', { op: 'list', args: {} })
  const rejected = assert.rejects(outstanding, /disconnected/)
  const second = await peer('second')
  await rejected
  assert.equal(bridge.instances()[0]?.epoch, 'second')
  assert.equal(second.welcome.protocol, 1)
  const incompatible = await peer('future', 2)
  assert.equal(incompatible.welcome.incompatible, 'litchOutdated')
  await assert.rejects(bridge.call('instance', { op: 'list', args: {} }), /newer Test/)
})
