// 可重连的终端：结束与清除、退出后的记录、数量上限。
import assert from 'node:assert/strict'
import test from 'node:test'
import { rig, settle } from './helpers.mjs'
import {
  assertExitMark,
  assertProcessErrorData,
  changes,
  collect,
  declared,
  exited,
  list,
  OPEN,
  output,
  processErrorCode,
  SLEEP,
  until,
} from './process-kit.mjs'

const handles = (items: any[]) => items.map((item) => `${item.processHandle}:${item.running}`)

test('显式结束进程、清掉退出后的记录', async () => {
  const setup = rig({})
  try {
    const owner = await declared(setup)
    const other = await declared(setup)
    const spawn = (handle: string) =>
      owner.call('process/spawn', {
        processHandle: handle,
        command: SLEEP,
        cwd: setup.stateDir,
        ...OPEN,
        litchDevice: {},
      })
    await spawn('k1')
    // 还在跑的不能清
    const running = await other.fails('litch/process/remove', { processHandle: 'k1' })
    assert.equal(running.code, processErrorCode('processRunning'))
    assert.deepEqual(running.data, { litch: 'processRunning', processHandle: 'k1' })
    assertProcessErrorData(running.data)
    // 没挂着的连接按句柄结束它；挂着的那条收到退出通知
    assert.deepEqual(await other.call('litch/process/kill', { processHandle: 'k1' }), {})
    const gone = await exited(owner, 'k1')
    assertExitMark(gone.litchDevice)
    const [record] = await list(other)
    assert.equal(record.running, false)
    assert.ok(record.exit.exitCode !== 0 && record.exit.exitedAt >= record.startedAt)
    // 已经退出的：扩展的结束算成功，标准的结束照协议原有的报
    assert.deepEqual(await other.call('litch/process/kill', { processHandle: 'k1' }), {})
    const already = await owner.fails('process/kill', { processHandle: 'k1' })
    assert.equal(already.message, 'no active process for process handle "k1"')
    assert.deepEqual(await other.call('litch/process/remove', { processHandle: 'k1' }), {})
    assert.deepEqual(await list(other), [])
    const unknown = await other.fails('litch/process/remove', { processHandle: 'k1' })
    assert.equal(unknown.code, processErrorCode('unknownProcess'))
    assert.deepEqual(unknown.data, { litch: 'unknownProcess', processHandle: 'k1' })
    assertProcessErrorData(unknown.data)
    await settle(30)
    assert.deepEqual(changes(other, 'k1'), ['started', 'exited', 'removed'])
    // 挂着的连接用标准的 process/kill
    await spawn('k2')
    assert.deepEqual(await owner.call('process/kill', { processHandle: 'k2' }), {})
    await exited(owner, 'k2')
    // 结束时说了不留记录：挂着的连接照样收到退出通知，列表里直接没了
    await spawn('k3')
    await other.call('litch/process/kill', { processHandle: 'k3', remove: true })
    await exited(owner, 'k3')
    await until(
      'k3 的记录没了',
      async () =>
        !handles(await list(other))
          .join()
          .includes('k3'),
    )
    await settle(30)
    assert.deepEqual(changes(other, 'k3'), ['started', 'removed'])
    assert.deepEqual(handles(await list(other)), ['k2:false'])
    assert.equal(setup.device.processes, 0)
  } finally {
    await setup.close()
  }
})

test('进程自己退出：退出状态和末尾的输出留一阵，晚到的连接看得到它是怎么结束的，到期就没了', async () => {
  const setup = rig({}, {}, { processes: { exitedRetentionMs: 1500 } })
  try {
    const job = {
      processHandle: 'job',
      command: ['/bin/sh', '-c', 'printf bye; exit 3'],
      cwd: setup.stateDir,
      litchDevice: { tag: 'nightly' },
    }
    const first = await declared(setup)
    await first.call('process/spawn', job)
    assert.deepEqual(await exited(first, 'job'), {
      processHandle: 'job',
      exitCode: 3,
      stdout: '',
      stderr: '',
      stdoutCapReached: false,
      stderrCapReached: false,
      litchDevice: { offset: 3 },
    })
    assert.equal(output(first, 'job'), 'bye')
    first.close()

    const late = await declared(setup)
    const [record] = await list(late)
    assert.deepEqual(
      [record.running, record.exit.exitCode, record.retained, record.attached, record.tag],
      [false, 3, { from: 0, to: 3 }, 0, 'nightly'],
    )
    // 记录还在，句柄就还占着
    const inUse = await late.fails('process/spawn', job)
    assert.equal(inUse.code, processErrorCode('processHandleInUse'))
    assert.deepEqual(inUse.data, { litch: 'processHandleInUse', processHandle: 'job' })
    // 挂上去：先回放它最后的输出，再告诉我它是怎么结束的
    const attached = await late.call('litch/process/attach', { processHandle: 'job' })
    assert.deepEqual(
      [attached.replayFrom, attached.replayTo, attached.process.running],
      [0, 3, false],
    )
    assert.equal((await exited(late, 'job')).exitCode, 3)
    const seen = collect(late.notifications, 'job')
    assert.deepEqual([seen.data.toString(), seen.replayed], ['bye', 3])
    assert.deepEqual(
      late.notifications
        .filter((frame) => frame.method?.startsWith('process/'))
        .map((frame) => frame.method),
      ['process/outputDelta', 'process/exited'],
    )
    await until('留到期了', async () => (await list(late)).length === 0, 8000)
    await settle(30)
    assert.equal(changes(late, 'job').at(-1), 'removed')
    // 记录没了，句柄可以再用
    await late.call('process/spawn', job)
    await exited(late, 'job')
  } finally {
    await setup.close()
  }
})

test('数量上限：到了报清楚的错，属于连接的进程不占名额，退出后的记录也不会越攒越多', async () => {
  const setup = rig({}, {}, { processes: { maxProcesses: 2 } })
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
    await spawn('s1')
    await spawn('s2')
    const full = await client.fails('process/spawn', {
      processHandle: 's3',
      command: SLEEP,
      cwd: setup.stateDir,
      litchDevice: {},
    })
    assert.equal(full.code, processErrorCode('processLimitReached'))
    assert.deepEqual(full.data, { litch: 'processLimitReached', processHandle: 's3', limit: 2 })
    assertProcessErrorData(full.data)
    assert.match(full.message, /2 个/)
    // 属于连接的进程不归这个上限管
    assert.deepEqual(
      await client.call('process/spawn', {
        processHandle: 'own',
        command: SLEEP,
        cwd: setup.stateDir,
      }),
      {},
    )
    // 结束一个，名额就空出来了：退出后留着的记录不占名额
    await client.call('litch/process/kill', { processHandle: 's1' })
    await exited(client, 's1')
    await spawn('s3')
    assert.deepEqual(handles(await list(client)), ['s1:false', 's2:true', 's3:true'])
    // 退出后的记录最多留两条（和同时在跑的上限同一个数），先清退出得早的
    await client.call('litch/process/kill', { processHandle: 's2' })
    await exited(client, 's2')
    await client.call('litch/process/kill', { processHandle: 's3' })
    await exited(client, 's3')
    assert.deepEqual(handles(await list(client)), ['s2:false', 's3:false'])
  } finally {
    await setup.close()
  }
})
