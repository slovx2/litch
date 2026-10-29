import assert from 'node:assert/strict'
import test from 'node:test'
import { TurnRecoveryObserver } from '../src/turn-recovery.mjs'

const epoch = 1_800_000_000_000
const tool = (status: string) => ({ id: 'tool', type: 'commandExecution', status })
function rig(seedSnapshot = true) {
  let now = epoch
  let thread: any = {
    id: 't',
    status: { type: 'active', activeFlags: [] },
    turns: [{ id: 'a', status: 'inProgress', items: [] }],
  }
  const reads: boolean[] = []
  const observer = new TurnRecoveryObserver({
    now: () => now,
    announce() {},
    check: async (_h, _t, includeTurns) => {
      reads.push(includeTurns)
      return {
        thread: includeTurns ? structuredClone(thread) : { id: thread.id, status: thread.status },
      }
    },
  })
  if (seedSnapshot) observer.snapshot('codex', structuredClone(thread))
  else
    observer.observe('codex', 'turn/started', { threadId: 't', turn: { id: 'a', startedAt: now } })
  return {
    observer,
    reads,
    advance(ms: number) {
      now += ms
    },
    state: () => thread,
    set(value: any) {
      thread = value
    },
    snapshot() {
      observer.snapshot('codex', structuredClone(thread))
    },
  }
}

test('客户端离线期间出现新条目：只在即将提醒时完整读取，指纹变化续期且重建工具', async () => {
  const r = rig()
  try {
    r.advance(299999)
    await r.observer.tick()
    assert.deepEqual(r.reads, [])
    r.state().turns[0].items.push(tool('inProgress'))
    r.advance(1)
    await r.observer.tick()
    assert.deepEqual(r.reads, [false, true])
    assert.equal(r.observer.list().length, 0)
    // 状态没有变化时不全量读取；客户端再次取得完整快照时补回工具终态。
    r.state().turns[0].items[0].status = 'completed'
    r.advance(59999)
    await r.observer.tick()
    assert.equal(r.reads.length, 2)
    r.advance(1)
    await r.observer.tick()
    assert.deepEqual(r.reads, [false, true, false])
    assert.equal(r.observer.list().length, 0)
    r.snapshot()
    r.advance(299999)
    await r.observer.tick()
    assert.equal(r.observer.list().length, 0)
    r.advance(1)
    await r.observer.tick()
    assert.equal(r.observer.list()[0]?.recovery?.reason, 'idle')
  } finally {
    r.observer.close()
  }
})

test('已知回合的快照更新进展，重复快照不能续期，已有提醒遇到漏收的新进展会撤销', async () => {
  const r = rig()
  try {
    r.advance(300000)
    await r.observer.tick()
    assert.equal(r.observer.list().length, 1)
    r.state().turns[0].items.push({ id: 'answer', type: 'agentMessage' })
    r.advance(60000)
    await r.observer.tick()
    assert.equal(r.observer.list().length, 1, '状态未变的慢复查只读状态')
    r.snapshot()
    assert.equal(r.observer.list().length, 0)
    r.advance(299999)
    r.snapshot()
    await r.observer.tick()
    assert.equal(r.observer.list().length, 0)
    r.advance(1)
    await r.observer.tick()
    assert.equal(r.observer.list().length, 1)
    r.state().turns[0].items.push(tool('inProgress'))
    r.snapshot()
    assert.equal(r.observer.eligible('codex', 't', 'a'), false)
  } finally {
    r.observer.close()
  }
})

test('提醒、等待和长工具首轮轻量复查；空闲或未加载直接清除，不完整读取', async () => {
  for (const mode of ['notice', 'waiting', 'tool'])
    for (const status of ['idle', 'notLoaded']) {
      const r = rig()
      try {
        if (mode === 'notice') {
          r.advance(300000)
          await r.observer.tick()
        }
        if (mode === 'waiting') {
          r.state().status.activeFlags = ['waitingOnApproval']
          r.snapshot()
        }
        if (mode === 'tool') {
          r.state().turns[0].items = [tool('inProgress')]
          r.snapshot()
        }
        const before = r.reads.length
        r.state().status = { type: status }
        r.advance(59999)
        await r.observer.tick()
        assert.equal(r.reads.length, before)
        r.advance(1)
        await r.observer.tick()
        assert.deepEqual(r.reads.slice(before), [false])
        assert.equal(r.observer.list().length, 0)
        r.advance(600000)
        await r.observer.tick()
        assert.equal(r.reads.length, before + 1)
      } finally {
        r.observer.close()
      }
    }
})

test('等待仅由状态通知解除时重新计时，旧 wake 不能造成即时提醒', async () => {
  const r = rig()
  try {
    r.observer.resumed({ supported: true, generation: 'g', sequence: 0, resumedAt: 0 })
    r.advance(1000)
    r.observer.resumed({ supported: true, generation: 'g', sequence: 1, resumedAt: epoch + 1000 })
    r.observer.observe('codex', 'thread/status/changed', {
      threadId: 't',
      status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
    })
    r.advance(600000)
    r.observer.observe('codex', 'thread/status/changed', {
      threadId: 't',
      status: { type: 'active', activeFlags: [] },
    })
    await r.observer.tick()
    assert.equal(r.reads.length, 0)
    r.advance(299999)
    await r.observer.tick()
    assert.equal(r.reads.length, 0)
    r.advance(1)
    await r.observer.tick()
    assert.equal(r.observer.list()[0]?.recovery?.reason, 'idle')
  } finally {
    r.observer.close()
  }
})

test('延迟收到的内核唤醒标记从本地接收时刻计30秒，未来标记取较晚值', async () => {
  for (const offset of [-120000, 1000]) {
    const r = rig()
    try {
      r.observer.resumed({ supported: true, generation: 'g', sequence: 0, resumedAt: 0 })
      r.advance(180000)
      r.observer.resumed({
        supported: true,
        generation: 'g',
        sequence: 1,
        resumedAt: epoch + 180000 + offset,
      })
      await r.observer.tick()
      assert.equal(r.reads.length, 0)
      r.advance(29999 + Math.max(0, offset))
      await r.observer.tick()
      assert.equal(r.reads.length, 0)
      r.advance(1)
      await r.observer.tick()
      assert.equal(r.observer.list()[0]?.recovery?.reason, 'wake')
    } finally {
      r.observer.close()
    }
  }
})

test('完整快照之间同条回答增长算进展，重复完整快照不会续期', async () => {
  const r = rig()
  try {
    r.state().turns[0].items.push({ id: 'answer', type: 'agentMessage', text: '开始' })
    r.snapshot()
    r.observer.observe('codex', 'item/agentMessage/delta', {
      threadId: 't',
      turnId: 'a',
      itemId: 'answer',
      delta: '继续',
    })
    r.state().turns[0].items[0].text += '继续'
    r.advance(300000)
    await r.observer.tick()
    assert.equal(r.observer.list().length, 0, '只比较两次完整快照，独立于收到的delta')
    r.advance(300000)
    await r.observer.tick()
    assert.equal(r.observer.list().length, 1)
    r.state().turns[0].items[0].text += '离线期间仍在出字'
    r.advance(60000)
    r.snapshot()
    assert.equal(r.observer.list().length, 0, '漏掉的同条文本进展应撤销旧提醒')
  } finally {
    r.observer.close()
  }
})

test('半截流卡住：首次完整读取与通知条目不同，只建立基线，唤醒30秒仍提示', async () => {
  for (const items of [[], [{ id: 'answer', type: 'agentMessage', text: '半' }]]) {
    const r = rig(false)
    try {
      r.observer.resumed({ supported: true, generation: 'g', sequence: 0, resumedAt: 0 })
      r.observer.observe('codex', 'item/started', {
        threadId: 't',
        turnId: 'a',
        item: { id: 'answer', type: 'agentMessage', text: '' },
      })
      r.observer.observe('codex', 'item/agentMessage/delta', {
        threadId: 't',
        turnId: 'a',
        itemId: 'answer',
        delta: '半截流的内容',
      })
      r.state().turns[0].items = items
      r.advance(1000)
      r.observer.resumed({ supported: true, generation: 'g', sequence: 1, resumedAt: epoch + 1000 })
      r.advance(29999)
      await r.observer.tick()
      assert.equal(r.reads.length, 0)
      r.advance(1)
      await r.observer.tick()
      assert.equal(r.observer.list()[0]?.recovery?.reason, 'wake')
      assert.equal(r.observer.list()[0]?.recovery?.lastProgressAt, epoch)
      assert.deepEqual(r.reads, [false, true])
      r.snapshot()
      assert.equal(r.observer.list()[0]?.recovery?.reason, 'wake', '同一个完整基线不算进展')
    } finally {
      r.observer.close()
    }
  }
})

test('残留状态按1/2/5/10分钟退避，只有登记着工具的十分钟复查追加完整核对', async () => {
  for (const mode of ['notice', 'waiting', 'tool', 'dismissed']) {
    const r = rig()
    try {
      if (mode === 'notice' || mode === 'dismissed') {
        r.advance(300000)
        await r.observer.tick()
      }
      if (mode === 'dismissed') r.observer.dismiss('codex', 't', 'a')
      if (mode === 'waiting') {
        r.state().status.activeFlags = ['waitingOnApproval']
        r.snapshot()
      }
      if (mode === 'tool') {
        r.state().turns[0].items = [tool('inProgress')]
        r.snapshot()
      }
      let count = r.reads.length
      for (const delay of [60000, 120000, 300000, 600000, 600000]) {
        r.advance(delay - 1)
        await r.observer.tick()
        assert.equal(r.reads.length, count, mode)
        r.advance(1)
        await r.observer.tick()
        const expected = mode === 'tool' && delay === 600000 ? [false, true] : [false]
        assert.deepEqual(r.reads.slice(count), expected, mode)
        count += expected.length
      }
    } finally {
      r.observer.close()
    }
  }
})

test('慢复查发现等待状态变化才完整核对，并从解除等待时重新计时', async () => {
  const r = rig()
  try {
    r.state().status.activeFlags = ['waitingOnApproval']
    r.snapshot()
    r.advance(60000)
    await r.observer.tick()
    assert.deepEqual(r.reads, [false])
    r.state().status.activeFlags = []
    r.advance(120000)
    await r.observer.tick()
    assert.deepEqual(r.reads, [false, false, true])
    assert.equal(r.observer.list().length, 0)
    r.advance(299999)
    await r.observer.tick()
    assert.equal(r.reads.length, 3)
    r.advance(1)
    await r.observer.tick()
    assert.equal(r.observer.list()[0]?.recovery?.reason, 'idle')
  } finally {
    r.observer.close()
  }
})

test('通知登记的工具在完整快照中缺席或状态未知时保留，重新打开会话不误报长工具', async () => {
  const r = rig(false)
  try {
    r.observer.observe('codex', 'item/started', {
      threadId: 't',
      turnId: 'a',
      item: tool('inProgress'),
    })
    r.snapshot() // Codex 的完整读取可能暂时只有用户消息，不含正在执行的工具。
    r.advance(300000)
    await r.observer.tick()
    assert.equal(r.observer.list().length, 0)
    assert.deepEqual(r.reads, [false], '仍按工具阶段轻量复查，不把缺席当完成')
    r.state().turns[0].items = [tool('unknown')]
    r.snapshot()
    r.advance(300000)
    await r.observer.tick()
    assert.equal(r.observer.list().length, 0)
    // 只有明确终态才可解除；首次工具终态证据也重新开始模型等待计时。
    r.state().turns[0].items = [tool('completed')]
    r.snapshot()
    r.advance(299999)
    await r.observer.tick()
    assert.equal(r.observer.list().length, 0)
    r.advance(1)
    await r.observer.tick()
    assert.equal(r.observer.list()[0]?.recovery?.reason, 'idle')
  } finally {
    r.observer.close()
  }
})

test('离线漏收工具结束且状态指纹不变：十分钟兜底确认终态，再卡住仍会提示', async () => {
  const r = rig()
  try {
    r.state().turns[0].items = [
      tool('inProgress'),
      { id: 'answer', type: 'agentMessage', text: '继续执行' },
    ]
    r.snapshot()
    // 完成的不是最后一条，数量、末条ID/状态/长度都没变，只能凭明确工具终态解除。
    r.state().turns[0].items[0].status = 'completed'
    for (const delay of [60000, 120000, 300000]) {
      r.advance(delay)
      await r.observer.tick()
    }
    assert.deepEqual(r.reads, [false, false, false])
    r.advance(599999)
    await r.observer.tick()
    assert.equal(r.reads.length, 3)
    r.advance(1)
    await r.observer.tick()
    assert.deepEqual(r.reads, [false, false, false, false, true])
    assert.equal(r.observer.list().length, 0)
    r.advance(299999)
    await r.observer.tick()
    assert.equal(r.observer.list().length, 0)
    r.advance(1)
    await r.observer.tick()
    assert.equal(r.observer.list()[0]?.recovery?.reason, 'idle')
  } finally {
    r.observer.close()
  }
})

test('十分钟完整核对仍没看到工具条目时不删除，其他未报告的工具也不受影响', async () => {
  const r = rig(false)
  try {
    for (const id of ['tool', 'other'])
      r.observer.observe('codex', 'item/started', {
        threadId: 't',
        turnId: 'a',
        item: { ...tool('inProgress'), id },
      })
    for (const delay of [60000, 120000, 300000, 600000]) {
      r.advance(delay)
      await r.observer.tick()
    }
    assert.deepEqual(r.reads, [false, false, false, false, true])
    assert.equal(r.observer.list().length, 0)
    r.state().turns[0].items = [tool('failed')]
    r.snapshot()
    r.advance(300000)
    await r.observer.tick()
    assert.equal(r.observer.list().length, 0, 'other 缺席但未终结，仍抑制模型停流提示')
    r.state().turns[0].items.push({ ...tool('completed'), id: 'other' })
    r.snapshot()
    r.advance(300000)
    await r.observer.tick()
    assert.equal(r.observer.list().length, 1)
  } finally {
    r.observer.close()
  }
})
