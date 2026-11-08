import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import {
  AGY_BACKGROUND_LIMIT_MS,
  AgyBackgroundWatch,
  newAgyBackgroundUpdates,
} from '../src/agy-background.mjs'

const invoke = {
  sessionUpdate: 'tool_call',
  toolCallId: 'invoke-1',
  name: 'invoke_subagent',
  status: 'completed',
}
const text = (value: string) => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: value },
})

test('agy 回放按原生工具 ID 定位，只追加新父回答；分块差异不重画历史', () => {
  const before = [invoke, text('已'), text('开始')]
  assert.deepEqual(
    newAgyBackgroundUpdates(
      before,
      [text('旧回合'), invoke, text('已开始结果来了')],
      invoke.toolCallId,
    ),
    [text('结果来了')],
  )
  assert.deepEqual(newAgyBackgroundUpdates(before, [invoke, text('已开始')], invoke.toolCallId), [])
  assert.deepEqual(
    newAgyBackgroundUpdates(before, [invoke, text('其他内容')], invoke.toolCallId),
    [],
  )
  assert.deepEqual(newAgyBackgroundUpdates(before, [text('结果来了')], invoke.toolCallId), [])
  const tool = { sessionUpdate: 'tool_call', toolCallId: 'read-result', status: 'completed' }
  assert.deepEqual(
    newAgyBackgroundUpdates(before, [invoke, text('已开始'), tool], invoke.toolCallId),
    [],
  )
  assert.deepEqual(
    newAgyBackgroundUpdates(
      before,
      [invoke, text('已开始'), tool, text('好了')],
      invoke.toolCallId,
    ),
    [tool, text('好了')],
  )
})

test('agy 历史可包含未完成正文；后续快照只提取新增长的后半句', () => {
  const before = [invoke, text('已开始')]
  const partial = [invoke, text('已开始前半句')]
  const final = [invoke, text('已开始前半句后半句')]
  assert.deepEqual(newAgyBackgroundUpdates(before, partial, invoke.toolCallId), [text('前半句')])
  assert.deepEqual(newAgyBackgroundUpdates(partial, final, invoke.toolCallId), [text('后半句')])
})

function fixture() {
  let reads = 0
  let expired = 0
  let allowed = true
  let replay: () => Promise<any[] | null> = async () => [invoke, text('已开始')]
  const appended: any[][] = []
  const watch = new AgyBackgroundWatch({
    allowed: () => allowed,
    replay: async () => {
      reads++
      return replay()
    },
    append: (_id, updates) => appended.push(updates),
    changed() {},
    expired: () => {
      expired++
    },
  })
  return {
    watch,
    appended,
    get reads() {
      return reads
    },
    get expired() {
      return expired
    },
    allow: (value: boolean) => {
      allowed = value
    },
    replay: (value: () => Promise<any[] | null>) => {
      replay = value
    },
    start() {
      watch.observe('s', invoke)
      watch.observe('s', text('已开始'))
      watch.start('s', 't')
    },
  }
}

test('只观察到派发后才回读，3/5/10/20/30 秒退避；有内容后保持检查且不重复追加', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const f = fixture()
  f.watch.start('s', 't')
  assert.equal(f.watch.tasks('s').length, 0)
  f.start()
  assert.equal(f.watch.tasks('s')[0]?.kind, 'monitor')
  assert.equal(f.watch.tasks('s')[0]?.title, '子智能体可能仍在运行')
  for (const delay of [3000, 5000, 10000, 20000, 30000]) {
    const before = f.reads
    t.mock.timers.tick(delay - 1)
    await setImmediate()
    assert.equal(f.reads, before)
    t.mock.timers.tick(1)
    await setImmediate()
    assert.equal(f.reads, before + 1)
  }
  f.replay(async () => [invoke, text('已开始好了')])
  t.mock.timers.tick(30000)
  await setImmediate()
  assert.deepEqual(f.appended, [[text('好了')]])
  assert.equal(f.watch.tasks('s').length, 1)
  t.mock.timers.tick(30000)
  await setImmediate()
  assert.deepEqual(f.appended, [[text('好了')]])
  t.mock.timers.tick(AGY_BACKGROUND_LIMIT_MS)
  await setImmediate()
  assert.equal(f.watch.tasks('s').length, 0)
  assert.equal(f.expired, 0)
})

for (const received of [false, true])
  test(`十分钟最多检查次数：收到内容=${received}，静默一分钟后降为每60秒`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
    const f = fixture()
    if (received) f.replay(async () => [invoke, text('已开始结果')])
    f.start()
    for (let second = 0; second < 600; second++) {
      t.mock.timers.tick(1000)
      await setImmediate()
    }
    assert.equal(f.reads, received ? 13 : 22)
    assert.equal(f.expired, received ? 0 : 1)
    assert.equal(f.watch.tasks('s').length, 0)
  })

test('回放出现下一条用户消息是明确边界，不把后续会话内容混进来', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const f = fixture()
  f.replay(async () => [
    invoke,
    text('已开始结果'),
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '下一句' } },
    text('别的回答'),
  ])
  f.start()
  t.mock.timers.tick(3000)
  await setImmediate()
  assert.deepEqual(f.appended, [[text('结果')]])
  assert.equal(f.watch.tasks('s').length, 0)
})

test('用户新消息/关闭/归档/断线取消在途结果；超时只撤监视器并提示', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const f = fixture()
  let release: (value: any[]) => void = () => {}
  f.replay(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  f.start()
  t.mock.timers.tick(3000)
  f.watch.stop('s')
  release([invoke, text('已开始迟到')])
  await setImmediate()
  assert.deepEqual(f.appended, [])
  assert.equal(f.watch.tasks('s').length, 0)
  f.start()
  t.mock.timers.tick(AGY_BACKGROUND_LIMIT_MS)
  await setImmediate()
  assert.equal(f.expired, 1)
  assert.equal(f.watch.tasks('s').length, 0)
  release([invoke, text('已开始超时后')])
  await setImmediate()
  assert.deepEqual(f.appended, [])
  f.start()
  f.allow(false)
  t.mock.timers.tick(3000)
  await setImmediate()
  assert.equal(f.watch.tasks('s').length, 0)
  f.watch.close()
})

test('回放超限或不支持 load 时停止，不反复回读大历史', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const f = fixture()
  f.replay(async () => null)
  f.start()
  t.mock.timers.tick(3000)
  await setImmediate()
  assert.equal(f.expired, 1)
  assert.equal(f.watch.tasks('s').length, 0)
})
