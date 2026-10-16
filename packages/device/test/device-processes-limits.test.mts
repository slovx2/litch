// 可重连的终端：上限和期限跟着设置走。适配器主进程经控制通道把现行值推过来，设备进程当场换，
// 不重启、不动已经在跑的进程。
import assert from 'node:assert/strict'
import test from 'node:test'
import { FakeControl } from './fake-control.mjs'
import { rig, settle } from './helpers.mjs'
import {
  declared,
  FEED,
  lines,
  list,
  OPEN,
  output,
  processErrorCode,
  SLEEP,
  until,
  write,
} from './process-kit.mjs'

const handles = (items: any[]) => items.map((item) => `${item.processHandle}:${item.running}`)

test('数量上限当场换：调小了不结束已经在跑的，只是不让再起；调大了马上能起', async () => {
  const control = new FakeControl([])
  const setup = rig({}, {}, { control })
  try {
    const client = await declared(setup)
    const spawn = (handle: string) =>
      client.call('process/spawn', {
        processHandle: handle,
        command: SLEEP,
        cwd: setup.stateDir,
        ...OPEN,
        litchDevice: {},
      })
    await spawn('a')
    await spawn('b')
    control.limit({ maxProcesses: 1 })
    assert.deepEqual(handles(await list(client)), ['a:true', 'b:true'], '已经在跑的两个都还在')
    const full = await client.fails('process/spawn', {
      processHandle: 'c',
      command: SLEEP,
      cwd: setup.stateDir,
      litchDevice: {},
    })
    assert.equal(full.code, processErrorCode('processLimitReached'))
    assert.deepEqual(full.data, { litch: 'processLimitReached', processHandle: 'c', limit: 1 })
    control.limit({ maxProcesses: 3 })
    await spawn('c')
    assert.deepEqual(handles(await list(client)), ['a:true', 'b:true', 'c:true'])
  } finally {
    await setup.close()
  }
})

test('没人挂着留多久当场换：这时没人挂着的从改的那一刻起计，改回 0 就不再计', async () => {
  const control = new FakeControl([])
  const setup = rig({}, {}, { control })
  try {
    const client = await declared(setup)
    for (const handle of ['x', 'y']) {
      await client.call('process/spawn', {
        processHandle: handle,
        command: SLEEP,
        cwd: setup.stateDir,
        ...OPEN,
        litchDevice: {},
      })
    }
    // x 没人挂着，y 还挂着
    await client.call('litch/process/detach', { processHandle: 'x' })
    await settle(300)
    assert.deepEqual(handles(await list(client)), ['x:true', 'y:true'], '默认不设期限，一直留着')
    // 先给一个长的期限再改回 0：之前排上的那一次计时得撤掉
    control.limit({ idleTimeoutMs: 200 })
    control.limit({ idleTimeoutMs: 0 })
    await settle(400)
    assert.deepEqual(handles(await list(client)), ['x:true', 'y:true'], '改回 0 之后不再计')
    control.limit({ idleTimeoutMs: 200 })
    await until('没人挂着的那个到点结束了', async () =>
      (await list(client)).some((item) => item.processHandle === 'x' && !item.running),
    )
    assert.deepEqual(handles(await list(client)), ['x:false', 'y:true'], '有人挂着的不受影响')
  } finally {
    await setup.close()
  }
})

test('缓冲的大小只管之后新起的；设备进程起来时主进程已经给了的那一份直接用上', async () => {
  // 第一条状态里就带着上限：设备进程一起来就按它
  const control = new FakeControl([], false)
  control.limit({ bufferBytes: 4096, maxProcesses: 2 })
  const setup = rig({}, {}, { control })
  try {
    const first = await declared(setup)
    const feed = (handle: string) =>
      first.call('process/spawn', {
        processHandle: handle,
        command: FEED,
        cwd: setup.stateDir,
        streamStdin: true,
        ...OPEN,
        litchDevice: {},
      })
    await feed('old')
    control.limit({ bufferBytes: 8192 })
    await feed('new')
    const third = await first.fails('process/spawn', {
      processHandle: 'third',
      command: SLEEP,
      cwd: setup.stateDir,
      litchDevice: {},
    })
    assert.deepEqual(third.data, { litch: 'processLimitReached', processHandle: 'third', limit: 2 })
    // 不成样子的值不收，原来的照旧
    control.limit({ maxProcesses: -1, bufferBytes: 1.5 } as never)
    assert.equal(
      (
        await first.fails('process/spawn', {
          processHandle: 'third',
          command: SLEEP,
          cwd: setup.stateDir,
          litchDevice: {},
        })
      ).data.limit,
      2,
    )
    for (const handle of ['old', 'new']) await write(first, handle, '1 5 0\n')
    await until('两边的第一批输出都到了', () =>
      ['old', 'new'].every((handle) => output(first, handle).endsWith('END\n')),
    )
    // 断开之后各出十万多字节，都远超过缓冲
    for (const handle of ['old', 'new']) await write(first, handle, '6 20000 0.2\n')
    first.close()
    const total = Buffer.byteLength(lines(1, 5) + lines(6, 20000))
    const second = await declared(setup)
    await until('断开期间的输出出完了', async () =>
      (await list(second)).every((item) => item.retained.to === total),
    )
    const kept = Object.fromEntries(
      (await list(second)).map((item) => [
        item.processHandle,
        item.retained.to - item.retained.from,
      ]),
    )
    assert.deepEqual(kept, { old: 4096, new: 8192 })
  } finally {
    await setup.close()
  }
})
