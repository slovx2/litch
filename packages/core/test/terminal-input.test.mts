import assert from 'node:assert/strict'
import { test } from 'node:test'
import { terminalWorld, watchTerminals } from './terminal-world.mjs'

test('输入中途断线：重连后的回车不能执行远端保留的半行', async () => {
  const world = terminalWorld()
  await world.start()
  const id = await world.open()
  const list = watchTerminals(world.core)
  const write = (text: string) =>
    world.command('terminal.write', { terminalId: id, data: btoa(text) })
  await write('echo safe')
  await world.idle()
  await world.drop()
  await assert.rejects(write('-42'))
  await world.back()
  await assert.rejects(write('\r'))
  await world.idle()
  assert.equal(world.procs.writes.map((w) => w.text).join(''), 'echo safe')
  assert.equal(list.get(id).inputBlocked, true)
  await world.command('terminal.resumeInput', { terminalId: id })
  await write('\u0003')
  await write('echo safe-42\r')
  await world.idle()
  assert.equal(world.procs.writes.map((w) => w.text).join(''), 'echo safe\u0003echo safe-42\r')
  world.core.stop()
})

test('上一批没有确认之前，后续字符和回车都留在本机；失败后不再发送', async () => {
  let fail!: (error: Error) => void
  const received: string[] = []
  const world = terminalWorld({
    extra: {
      'process/writeStdin': (params) => {
        received.push(atob((params as { deltaBase64: string }).deltaBase64))
        return new Promise((_resolve, reject) => {
          fail = reject
        })
      },
    },
  })
  await world.start()
  const id = await world.open()
  const list = watchTerminals(world.core)
  for (const text of ['echo ', 'full-command', '\r']) {
    await world.command('terminal.write', { terminalId: id, data: btoa(text) })
  }
  await world.idle()
  assert.deepEqual(received, ['echo '])
  fail(new Error('写入失败'))
  await world.idle()
  assert.equal(list.get(id).inputBlocked, true)
  await assert.rejects(world.command('terminal.write', { terminalId: id, data: btoa('\r') }))
  await world.command('terminal.resumeInput', { terminalId: id })
  await world.idle()
  assert.deepEqual(received, ['echo '], '确认恢复也不能重放旧的后半段或回车')
  world.core.stop()
})

test('在途输入断线且确认晚到：不能释放上一条连接上排队的回车', async () => {
  let done!: (value: object) => void
  const received: string[] = []
  const world = terminalWorld({
    extra: {
      'process/writeStdin': (params) => {
        received.push(atob((params as { deltaBase64: string }).deltaBase64))
        return new Promise((resolve) => {
          done = resolve
        })
      },
    },
  })
  await world.start()
  const id = await world.open()
  await world.command('terminal.write', { terminalId: id, data: btoa('echo partial') })
  await world.command('terminal.write', { terminalId: id, data: btoa('\r') })
  await world.idle()
  await world.drop()
  await world.back()
  await world.command('terminal.resumeInput', { terminalId: id })
  done({})
  await world.idle()
  assert.deepEqual(received, ['echo partial'])
  world.core.stop()
})

test('输入确认超时和输入缓存溢出都暂停输入，不把下一次回车直接送走', async () => {
  for (const overflow of [false, true]) {
    const world = terminalWorld({ extra: { 'process/writeStdin': () => undefined } })
    await world.start()
    const id = await world.open()
    const list = watchTerminals(world.core)
    await world.command('terminal.write', { terminalId: id, data: btoa('echo ') })
    await world.idle()
    if (overflow) {
      await assert.rejects(
        world.command('terminal.write', {
          terminalId: id,
          data: btoa('x'.repeat(1024 * 1024 + 1)),
        }),
      )
    } else {
      world.time.advance(60_000)
      await world.idle()
    }
    assert.equal(list.get(id).inputBlocked, true)
    await assert.rejects(world.command('terminal.write', { terminalId: id, data: btoa('\r') }))
    assert.equal(world.sent('process/writeStdin').length, 1)
    world.core.stop()
  }
})

test('为写输入而重新挂接失败：明确暂停，后续回车不单独发送', async () => {
  const world = terminalWorld({
    extra: {
      'litch/process/attach': () => {
        throw new Error('挂接失败')
      },
    },
  })
  await world.start()
  const id = await world.open()
  await world.relaunch()
  const list = watchTerminals(world.core)
  await world.command('terminal.resumeInput', { terminalId: id })
  await world.command('terminal.write', { terminalId: id, data: btoa('echo incomplete') })
  await world.idle()
  assert.equal(list.get(id).inputBlocked, true)
  await assert.rejects(world.command('terminal.write', { terminalId: id, data: btoa('\r') }))
  assert.deepEqual(world.procs.writes, [])
  world.core.stop()
})
