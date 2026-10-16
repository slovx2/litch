// 可重连的终端：缓冲只留末尾一段、几条连接同时挂着同一个终端。
import assert from 'node:assert/strict'
import test from 'node:test'
import { rig, settle } from './helpers.mjs'
import {
  assertAttachResponse,
  assertExitMark,
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
  until,
  write,
} from './process-kit.mjs'

test('断开期间的输出超过缓冲上限：只留末尾，挂回去时知道中间丢了多少', async () => {
  const keep = 4096
  const setup = rig({}, {}, { processes: { bufferBytes: keep } })
  try {
    const first = await declared(setup)
    await first.call('process/spawn', {
      processHandle: 'big',
      command: FEED,
      cwd: setup.stateDir,
      streamStdin: true,
      ...OPEN,
      litchDevice: {},
    })
    await write(first, 'big', '1 50 0\n')
    await until('第一批输出到了', () => output(first, 'big').endsWith('END\n'))
    const had = collect(first.notifications, 'big')
    // 断开之后再出的这一批有十万多字节，远超过缓冲
    await write(first, 'big', '51 20000 0.2\n')
    first.close()

    const everything = lines(1, 50) + lines(51, 20000)
    const total = Buffer.byteLength(everything)
    const second = await declared(setup)
    await until('断开期间的输出出完了', async () => (await list(second))[0].retained.to === total)
    assert.deepEqual((await list(second))[0].retained, { from: total - keep, to: total })
    const attached = await second.call('litch/process/attach', {
      processHandle: 'big',
      fromOffset: had.end,
    })
    assertAttachResponse(attached)
    assert.deepEqual(
      [attached.replayFrom, attached.replayTo, attached.missedBytes],
      [total - keep, total, total - keep - had.end],
      '客户端知道从它手里的位置到回放起点之间丢了多少',
    )
    await until('回放完了', () => collect(second.notifications, 'big').end === total)
    const tail = collect(second.notifications, 'big')
    assert.deepEqual([tail.start, tail.contiguous, tail.replayed], [total - keep, true, keep])
    assert.equal(tail.data.toString(), everything.slice(-keep), '留着的正是末尾那一段')
    // 不说位置的：丢了多少从进程的开头算
    const third = await declared(setup)
    const whole = await third.call('litch/process/attach', { processHandle: 'big' })
    assert.deepEqual([whole.replayFrom, whole.missedBytes], [total - keep, total - keep])
    // 有连接挂着的时候接着出：新的照发，缓冲还是只留末尾那么多
    await write(third, 'big', '1 2000 0\n')
    for (const client of [second, third])
      await until('新输出到了', () => output(client, 'big').endsWith(lines(1, 2000)))
    const after = (await list(second))[0].retained
    assert.equal(after.to, total + Buffer.byteLength(lines(1, 2000)))
    assert.equal(after.to - after.from, keep)
    const live = collect(second.notifications, 'big')
    assert.deepEqual([live.contiguous, live.missed, live.end], [true, 0, after.to])
  } finally {
    await setup.close()
  }
})

test('几条连接同时挂着同一个终端：输出各发一份，谁写都行，行列数以最后一次为准', async () => {
  const setup = rig({})
  try {
    const one = await declared(setup)
    const two = await declared(setup)
    const spawned = await one.call('process/spawn', {
      processHandle: 'tty',
      command: ['/bin/sh'],
      cwd: setup.stateDir,
      tty: true,
      size: { rows: 24, cols: 80 },
      ...OPEN,
      litchDevice: {},
    })
    assert.deepEqual(
      [spawned.litchDevice.tty, spawned.litchDevice.size],
      [true, { rows: 24, cols: 80 }],
    )
    await write(one, 'tty', 'echo one-$((40+2))\n')
    await until('第一条连接看到输出', () => output(one, 'tty').includes('one-42'))
    // 第二条连接挂上来：先拿到之前的，再和第一条一起收新的
    const attached = await two.call('litch/process/attach', { processHandle: 'tty' })
    assert.deepEqual([attached.replayFrom, attached.process.attached], [0, 2])
    await write(two, 'tty', 'echo two-$((50+5))\n')
    for (const client of [one, two])
      await until('两条连接都看到第二条连接敲的命令的结果', () =>
        output(client, 'tty').includes('two-55'),
      )
    // 两条连接先后改行列数：以后一次为准，终端里真的变了
    await one.call('process/resizePty', {
      processHandle: 'tty',
      size: { rows: 30, cols: 100 },
    })
    await two.call('process/resizePty', {
      processHandle: 'tty',
      size: { rows: 40, cols: 120 },
    })
    assert.deepEqual((await list(one))[0].size, { rows: 40, cols: 120 })
    await write(one, 'tty', 'stty size\n')
    for (const client of [one, two])
      await until('终端里看到的是最后一次的行列数', () => /40 120/.test(output(client, 'tty')))
    await settle(100)
    const [mine, theirs] = [collect(one.notifications, 'tty'), collect(two.notifications, 'tty')]
    assert.deepEqual([mine.contiguous, theirs.contiguous, mine.end], [true, true, theirs.end])
    assert.ok(mine.data.equals(theirs.data), '两条连接收到的是同一份')
    assert.ok(theirs.replayed > 0 && theirs.replayed < theirs.end, '第二条连接的前一段是回放')
    // 另一个窗口的终端列表跟着变：起了、有连接挂上来、两次改行列数
    assert.deepEqual(changes(two, 'tty'), ['started', 'updated', 'updated', 'updated'])
    const resized = two.notifications
      .filter((frame) => frame.method === 'litch/process/changed')
      .map((frame) => (frame.params as any).process.size)
    assert.deepEqual(resized.at(-1), { rows: 40, cols: 120 })

    // 一条解除挂接：进程不受影响，另一条照收，解除的那条不再收
    assert.deepEqual(await two.call('litch/process/detach', { processHandle: 'tty' }), {})
    assert.deepEqual(await two.call('litch/process/detach', { processHandle: 'tty' }), {})
    const before = collect(two.notifications, 'tty').end
    await write(one, 'tty', 'echo three-$((60+6))\n')
    await until('挂着的那条照收', () => output(one, 'tty').includes('three-66'))
    await settle(50)
    assert.equal(collect(two.notifications, 'tty').end, before)
    assert.equal((await list(two))[0].attached, 1)
    // 没挂着的连接，标准的方法不认这个句柄
    const missing = await two.fails('process/writeStdin', {
      processHandle: 'tty',
      deltaBase64: b64('x'),
    })
    assert.equal(missing.message, 'no active process for process handle "tty"')
    // 终端里的 shell 自己退出
    await write(one, 'tty', 'exit 7\n')
    const gone = await exited(one, 'tty')
    assertExitMark(gone.litchDevice)
    assert.deepEqual(
      [gone.exitCode, gone.stdout, gone.litchDevice.offset],
      [7, '', collect(one.notifications, 'tty').end],
      '退出通知排在输出之后，上面的偏移就是输出的总量',
    )
  } finally {
    await setup.close()
  }
})

test('输出正在出的时候反复断开、带着位置重连：每一段首尾相接，拼起来一个字节不差', async () => {
  const setup = rig({})
  try {
    let client = await declared(setup)
    await client.call('process/spawn', {
      processHandle: 'busy',
      command: FEED,
      cwd: setup.stateDir,
      streamStdin: true,
      ...OPEN,
      litchDevice: {},
    })
    const parts: Buffer[] = []
    let expected = ''
    let have = 0
    const rounds = 20
    for (let round = 0; round < rounds; round++) {
      // 每一轮让它出十几万字节。等到这条连接上有输出到了再断（机器忙的时候进程起步慢，光按时间等会一帧都收不到），
      // 之后再等的时间一轮比一轮长一点：断开的那一刻落在这批输出的各个位置上
      const [from, to] = [round * 20_000 + 1, (round + 1) * 20_000]
      expected += lines(from, to)
      await write(client, 'busy', `${from} ${to} 0\n`)
      await until('这一轮有输出到了', () => collect(client.notifications, 'busy').frames > 0)
      await settle(round % 5)
      const got = collect(client.notifications, 'busy')
      client.close()
      assert.deepEqual([got.contiguous, got.missed], [true, 0])
      if (got.frames) {
        assert.equal(got.start, have, '这一段从上一段结束的地方开始')
        parts.push(got.data)
        have = got.end
      }
      client = await declared(setup)
      const attached = await client.call('litch/process/attach', {
        processHandle: 'busy',
        fromOffset: have,
      })
      assert.deepEqual([attached.replayFrom, attached.missedBytes], [have, 0])
    }
    const total = Buffer.byteLength(expected)
    // 最后一轮断开之前就全收到了的话，这条连接上不会再有输出
    const remaining = () => collect(client.notifications, 'busy')
    await until('最后一段收完了', () => have === total || remaining().end === total)
    const last = remaining()
    if (last.frames) {
      assert.deepEqual([last.start, last.contiguous, last.missed], [have, true, 0])
      parts.push(last.data)
    }
    assert.ok(Buffer.concat(parts).equals(Buffer.from(expected)), '不丢、不重、不乱')
    assert.ok(parts.length > rounds / 2, '确实是分了很多段收到的')
  } finally {
    await setup.close()
  }
})
