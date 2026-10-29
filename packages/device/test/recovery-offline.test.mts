import assert from 'node:assert/strict'
import test from 'node:test'
import { TurnRecoveryObserver } from '../src/turn-recovery.mjs'

const epoch = 1_800_000_000_000
const tool = (status: string) => ({ id: 'tool', type: 'commandExecution', status })
function rig() {
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
  observer.snapshot('codex', structuredClone(thread))
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
    // 没有收到工具结束通知，一分钟后的复查也能解除工具状态。
    r.state().turns[0].items[0].status = 'completed'
    r.advance(59999)
    await r.observer.tick()
    assert.equal(r.reads.length, 2)
    r.advance(1)
    await r.observer.tick()
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

test('已知回合的快照更新进展，重复快照不能续期，已有提醒遇到漏收的新进展会撤销', async () => {
  const r = rig()
  try {
    r.advance(300000)
    await r.observer.tick()
    assert.equal(r.observer.list().length, 1)
    r.state().turns[0].items.push({ id: 'answer', type: 'agentMessage' })
    r.advance(60000)
    await r.observer.tick()
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

test('提醒、等待和长工具残留每分钟轻量复查；空闲或未加载直接清除，不完整读取', async () => {
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

test('离线时同一回答仅增加文字也算进展；已收到的delta与相同完整快照不会重复续期', async () => {
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
    assert.equal(r.observer.list().length, 1, '已经收到的流不因补读重复续期')
    r.state().turns[0].items[0].text += '离线期间仍在出字'
    r.advance(60000)
    await r.observer.tick()
    assert.equal(r.observer.list().length, 0, '漏掉的同条文本进展应撤销旧提醒')
  } finally {
    r.observer.close()
  }
})
