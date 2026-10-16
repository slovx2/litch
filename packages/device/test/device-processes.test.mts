// 可重连的终端（deviceProcesses 扩展）：进程属于设备。真的子进程、真的伪终端，客户端直接接在设备上。
// 流量控制和“设备进程退出不留孤儿”要经真的套接字，在 device-processes-flow.test.mts。
import assert from 'node:assert/strict'
import test from 'node:test'
import { errorCode, rig, settle } from './helpers.mjs'
import {
  assertAttachResponse,
  assertProcess,
  assertSpawnResponse,
  assertStandard,
  b64,
  changes,
  collect,
  declared,
  exited,
  FEED,
  lines,
  list,
  OPEN,
  output,
  SLEEP,
  until,
  write,
} from './process-kit.mjs'

test('不带扩展参数：和没有这个扩展时一样，握手时声明没声明都一样', async () => {
  const setup = rig({})
  try {
    const aware = await declared(setup)
    const plain = setup.connect()
    await plain.initialize()
    const info = await aware.call('runtime/info', {})
    assert.ok(info.device.extensions.includes('deviceProcesses'), '设备报了这项扩展')
    const params = {
      processHandle: 'p',
      command: ['/bin/sh', '-c', 'printf out; exit 3'],
      cwd: setup.stateDir,
      streamStdoutStderr: true,
    }
    // 协议原有的通知，一个字节都不多：这两行就是加这个扩展之前线上的原文
    const standard = [
      '{"method":"process/outputDelta","params":{"processHandle":"p","stream":"stdout","deltaBase64":"b3V0","capReached":false}}',
      '{"method":"process/exited","params":{"processHandle":"p","exitCode":3,"stdout":"","stderr":"","stdoutCapReached":false,"stderrCapReached":false}}',
    ]
    for (const client of [aware, plain]) {
      assert.deepEqual(await client.call('process/spawn', params), {})
      await exited(client, 'p')
      assert.deepEqual(
        client.raw.filter((raw) => raw.includes('"process/')),
        standard,
      )
    }
    // 没声明的连接带了扩展参数：等于没带，和别的不认识的字段一样略过
    const ignored = await plain.call('process/spawn', {
      ...params,
      processHandle: 'q',
      litchDevice: { tag: 'x' },
    })
    assertStandard('ProcessSpawnResponse', ignored)
    assert.deepEqual(ignored, {})
    assertStandard('ProcessExitedNotification', await exited(plain, 'q'))
    for (const frame of plain.notifications.filter((item) => item.method === 'process/outputDelta'))
      assertStandard('ProcessOutputDeltaNotification', frame.params)
    // 声明了的连接给 null：也等于没带
    assert.deepEqual(
      await aware.call('process/spawn', { ...params, processHandle: 'n', litchDevice: null }),
      {},
    )
    await exited(aware, 'n')
    assert.deepEqual(await list(aware), [], '这些都不是属于设备的进程')
    // 属于连接的进程，连接断了就结束
    await plain.call('process/spawn', {
      processHandle: 'long',
      command: SLEEP,
      cwd: setup.stateDir,
    })
    await plain.call('process/spawn', {
      processHandle: 'long2',
      command: SLEEP,
      cwd: setup.stateDir,
      litchDevice: {},
    })
    assert.equal(setup.device.processes, 2)
    plain.close()
    await until('断开的连接起的进程都结束了', () => setup.device.processes === 0)
    // 没声明的连接：扩展自己的方法用不了，通知也收不到
    const other = setup.connect()
    await other.initialize()
    await aware.call('process/spawn', {
      processHandle: 'd1',
      command: SLEEP,
      cwd: setup.stateDir,
      ...OPEN,
      litchDevice: {},
    })
    for (const method of ['litch/process/list', 'litch/process/attach', 'litch/process/kill']) {
      const refused = await other.fails(method, { processHandle: 'd1' })
      assert.equal(refused.code, errorCode('extensionRequired'))
      assert.deepEqual(refused.data, {
        litch: 'extensionRequired',
        method,
        required: ['deviceProcesses'],
      })
    }
    // 标准的方法只认这条连接自己的进程：别的连接起的设备进程对它不存在
    for (const method of ['process/writeStdin', 'process/kill']) {
      const missing = await other.fails(method, { processHandle: 'd1', deltaBase64: b64('x') })
      assert.equal(missing.message, 'no active process for process handle "d1"')
    }
    assert.equal((await list(aware))[0].running, true)
    await settle(50)
    assert.deepEqual(
      other.notifications.filter((frame) => frame.method?.startsWith('litch/process/')),
      [],
    )
    assert.deepEqual(changes(aware, 'd1'), ['started'])
  } finally {
    await setup.close()
  }
})

test('发起的连接断开后进程还在：列得出，带着手里的位置挂回去，回放加新输出不丢不重', async () => {
  const setup = rig({})
  try {
    const first = await declared(setup)
    const tag = { workspace: 'w-1', order: [1, 2], title: '终端 一' }
    const spawned = await first.call('process/spawn', {
      processHandle: 'term',
      command: FEED,
      cwd: setup.stateDir,
      streamStdin: true,
      ...OPEN,
      litchDevice: { tag },
    })
    assertSpawnResponse(spawned)
    assert.deepEqual(
      { ...spawned.litchDevice, startedAt: 0 },
      {
        processHandle: 'term',
        command: FEED,
        cwd: setup.stateDir,
        tty: false,
        size: null,
        startedAt: 0,
        running: true,
        exit: null,
        attached: 1,
        tag,
        retained: { from: 0, to: 0 },
      },
    )
    await write(first, 'term', '1 100 0\n')
    await until('第一批输出到了', () => output(first, 'term').endsWith('END\n'))
    const had = collect(first.notifications, 'term')
    assert.deepEqual(
      [had.start, had.contiguous, had.missed, had.replayed, had.data.toString()],
      [0, true, 0, 0, lines(1, 100)],
    )
    // 断开之前交代它过一会儿再出一批：这一批出来的时候没有任何连接挂着
    await write(first, 'term', '101 200 0.3\n')
    first.close()

    const second = await declared(setup)
    const [listed] = await list(second)
    assertProcess(listed)
    assert.deepEqual(
      [listed.processHandle, listed.running, listed.attached, listed.tag, listed.command],
      ['term', true, 0, tag, FEED],
    )
    const total = Buffer.byteLength(lines(1, 100) + lines(101, 200))
    await until('断开期间的输出进了缓冲', async () => (await list(second))[0].retained.to === total)
    assert.equal(setup.device.processes, 1, '进程一直在')
    // “我已经有到 had.end 了”：只补后面的
    const attached = await second.call('litch/process/attach', {
      processHandle: 'term',
      fromOffset: had.end,
    })
    assertAttachResponse(attached)
    assert.deepEqual(
      [attached.replayFrom, attached.replayTo, attached.missedBytes, attached.process.attached],
      [had.end, total, 0, 1],
    )
    await write(second, 'term', '201 300 0\n')
    await until('重连后的新输出到了', () => output(second, 'term').endsWith(lines(201, 300)))
    const more = collect(second.notifications, 'term')
    assert.deepEqual(
      [more.start, more.contiguous, more.missed, more.replayed],
      [had.end, true, 0, total - had.end],
    )
    assert.equal(
      Buffer.concat([had.data, more.data]).toString(),
      lines(1, 100) + lines(101, 200) + lines(201, 300),
      '两段接起来一个字节不多、一个字节不少',
    )
    // 不说位置：留着的全部回放一遍。两条连接这时同时挂着
    const third = await declared(setup)
    const whole = await third.call('litch/process/attach', { processHandle: 'term' })
    assert.deepEqual([whole.replayFrom, whole.missedBytes, whole.process.attached], [0, 0, 2])
    await until('回放完了', () => collect(third.notifications, 'term').end === whole.replayTo)
    const replayed = collect(third.notifications, 'term')
    assert.equal(replayed.replayed, whole.replayTo, '全是回放')
    assert.equal(replayed.data.toString(), lines(1, 100) + lines(101, 200) + lines(201, 300))
    // 已经挂着的再挂一次：从新给的位置重新回放，挂着的连接数不变
    const again = await third.call('litch/process/attach', {
      processHandle: 'term',
      fromOffset: whole.replayTo - 4,
    })
    assert.deepEqual([again.replayFrom, again.process.attached], [whole.replayTo - 4, 2])
    await until('又回放了末尾四个字节', () => output(third, 'term').endsWith('END\nEND\n'))
    // 手里的位置比这个进程的输出还靠后：不是这个进程的
    const ahead = await third.fails('litch/process/attach', {
      processHandle: 'term',
      fromOffset: whole.replayTo + 1,
    })
    assert.equal(ahead.code, -32602)
    assert.deepEqual(changes(second, 'term'), ['updated', 'updated'], '两次有连接挂上来')
  } finally {
    await setup.close()
  }
})
