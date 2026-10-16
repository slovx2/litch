// 可重连的终端：句柄的范围与冲突、标记、没有连接挂着时的期限、启动选项。
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseArgs } from '../src/args.mjs'
import { rig, settle } from './helpers.mjs'
import {
  assertProcessErrorData,
  declared,
  exited,
  FEED,
  lines,
  list,
  OPEN,
  output,
  plainOutput,
  processErrorCode,
  SLEEP,
  until,
  write,
} from './process-kit.mjs'

const DUPLICATE = 'duplicate active process handle: "h"'

test('句柄在设备范围内不撞：两条连接各起一个同名的，后一个被拒绝，不顶掉前一个', async () => {
  const setup = rig({})
  try {
    const one = await declared(setup)
    const two = await declared(setup)
    const device = {
      processHandle: 'h',
      command: FEED,
      cwd: setup.stateDir,
      streamStdin: true,
      ...OPEN,
      litchDevice: {},
    }
    const own = { ...device, streamStdoutStderr: true, litchDevice: undefined }
    await one.call('process/spawn', device)
    const taken = await two.fails('process/spawn', device)
    assert.equal(taken.code, processErrorCode('processHandleInUse'))
    assert.deepEqual(taken.data, { litch: 'processHandleInUse', processHandle: 'h' })
    assertProcessErrorData(taken.data)
    // 前一个没有被顶掉
    await write(one, 'h', '1 3 0\n')
    await until('先起的那个照常', () => output(one, 'h') === lines(1, 3))
    assert.equal((await list(two)).length, 1)

    // 属于连接的进程是另一个范围：别的连接可以有自己的 h，各用各的
    assert.deepEqual(await two.call('process/spawn', own), {})
    await write(two, 'h', '7 9 0\n')
    await until('第二条连接自己的进程收到了输入', () => plainOutput(two, 'h') === lines(7, 9))
    await settle(50)
    assert.equal(output(one, 'h'), lines(1, 3), '设备上的那个没有收到这份输入')
    // 第二条连接自己已经有 h：再挂设备上的 h，同一个句柄就指着两个进程了
    const confused = await two.fails('litch/process/attach', { processHandle: 'h' })
    assert.deepEqual(
      [confused.code, confused.message, confused.data],
      [-32600, DUPLICATE, undefined],
    )
    // 反过来也一样：挂着设备上的 h 的连接，不能再起一个自己的 h
    const again = await one.fails('process/spawn', own)
    assert.deepEqual([again.code, again.message], [-32600, DUPLICATE])
    // 自己已经有 x 的连接，不能再起设备上的 x
    await one.call('process/spawn', { ...own, processHandle: 'x' })
    const mixed = await one.fails('process/spawn', { ...device, processHandle: 'x' })
    assert.equal(mixed.message, 'duplicate active process handle: "x"')
    assert.equal((await list(one)).length, 1)

    // 退出后记录还留着的，句柄也还占着；清掉才能再用
    await one.call('process/kill', { processHandle: 'h' })
    await exited(one, 'h')
    const three = await declared(setup)
    assert.equal((await three.fails('process/spawn', device)).data.litch, 'processHandleInUse')
    await three.call('litch/process/remove', { processHandle: 'h' })
    const reused = await three.call('process/spawn', device)
    assert.equal(reused.litchDevice.retained.to, 0, '是一个新的进程，不是原来那个')
    // 句柄不成样子的，和标准协议报的一样
    const empty = await three.fails('process/spawn', { ...device, processHandle: '' })
    assert.deepEqual([empty.code, empty.message], [-32600, 'processHandle must not be empty'])
    assert.equal((await three.fails('process/spawn', { ...device, processHandle: 5 })).code, -32602)
    // 起不来的不留记录，也不占句柄
    const broken = { ...device, processHandle: 'bad', command: ['/nonexistent/program'] }
    assert.match((await three.fails('process/spawn', broken)).message, /failed to spawn process/)
    assert.match((await three.fails('process/spawn', broken)).message, /failed to spawn process/)
    assert.deepEqual(
      (await list(three)).map((item) => item.processHandle),
      ['h'],
    )
  } finally {
    await setup.close()
  }
})

test('标记：任意 JSON，原样带回；太大的、不成样子的不收', async () => {
  const setup = rig({})
  try {
    const client = await declared(setup)
    const tags: unknown[] = [
      { workspace: 'w-1', cwd: '/C:/not/a/path', nested: { list: [1, 'two', null, true] } },
      ['a', 1],
      '终端 一',
      42,
      null,
    ]
    for (const [index, tag] of tags.entries()) {
      const spawned = await client.call('process/spawn', {
        processHandle: `t${index}`,
        command: SLEEP,
        cwd: setup.stateDir,
        ...OPEN,
        litchDevice: { tag },
      })
      assert.deepEqual(spawned.litchDevice.tag, tag)
    }
    // 不带标记就是 null
    await client.call('process/spawn', {
      processHandle: 'none',
      command: SLEEP,
      cwd: setup.stateDir,
      ...OPEN,
      litchDevice: {},
    })
    assert.deepEqual(
      (await list(client)).map((item) => item.tag),
      [...tags, null],
    )
    const base = { processHandle: 'no', command: SLEEP, cwd: setup.stateDir }
    const huge = await client.fails('process/spawn', {
      ...base,
      litchDevice: { tag: 'x'.repeat(5000) },
    })
    assert.deepEqual([huge.code, /4096 字节/.test(huge.message)], [-32602, true])
    // 正好卡在上限上的收：4094 个字符加两个引号
    await client.call('process/spawn', {
      ...base,
      ...OPEN,
      processHandle: 'edge',
      litchDevice: { tag: 'x'.repeat(4094) },
    })
    for (const option of ['yes', true, 7, ['tag']])
      assert.equal(
        (await client.fails('process/spawn', { ...base, litchDevice: option })).code,
        -32602,
      )
    assert.equal(
      (await list(client)).some((item) => item.processHandle === 'no'),
      false,
    )
  } finally {
    await setup.close()
  }
})

test('没有连接挂着的进程：默认一直留着；配了期限的到点结束，期间有人挂上就不算', async () => {
  const setup = rig({}, {}, { processes: { idleTimeoutMs: 500 } })
  try {
    const one = await declared(setup)
    const two = await declared(setup)
    await one.call('process/spawn', {
      processHandle: 'idle',
      command: SLEEP,
      cwd: setup.stateDir,
      ...OPEN,
      litchDevice: {},
    })
    await one.call('litch/process/detach', { processHandle: 'idle' })
    await settle(200)
    // 期限没到又有人挂上：不结束，过了原来的期限也还在
    await two.call('litch/process/attach', { processHandle: 'idle' })
    await settle(700)
    assert.deepEqual(
      (await list(one)).map((item) => [item.running, item.attached]),
      [[true, 1]],
    )
    // 最后一条挂着的连接断了：重新开始计，到点结束
    two.close()
    await until('没人挂着的进程到点结束了', async () => (await list(one))[0].running === false)
    assert.equal(setup.device.processes, 0)
  } finally {
    await setup.close()
  }
})

test('启动选项：几项上限和期限', () => {
  const base = ['--listen', 'unix:///a.sock', '--state', '/s']
  assert.equal(parseArgs(base).processes, undefined, '不写就没有，用默认值')
  assert.deepEqual(
    parseArgs([
      ...base,
      '--process-buffer-bytes',
      '65536',
      '--process-limit',
      '4',
      '--process-idle-ms',
      '0',
      '--process-exited-ms',
      '1000',
    ]).processes,
    { bufferBytes: 65536, maxProcesses: 4, idleTimeoutMs: 0, exitedRetentionMs: 1000 },
  )
  assert.deepEqual(parseArgs([...base, '--process-limit', '8']).processes, { maxProcesses: 8 })
  for (const bad of ['-1', '1.5', 'many', '99999999999'])
    assert.throws(() => parseArgs([...base, '--process-idle-ms', bad]), /--process-idle-ms/)
  assert.throws(() => parseArgs([...base, '--process-limit']), /--process-limit/)
})
