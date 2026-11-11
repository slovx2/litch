import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseSystemMessage } from '../../protocol/src/system-messages.mjs'
import type { EngineLink } from '../src/engine-link.mjs'
import { RestartResume } from '../src/restart-resume.mjs'
import { RestartStore } from '../src/restart-store.mjs'
import { openDeviceStore } from '../src/store.mjs'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'restart-'))
  const db = openDeviceStore(dir)
  const store = new RestartStore(db)
  let service = 'old'
  let now = 1000
  let excluded = false
  let unknown = false
  let historyMs = 0
  let beforeSend: (() => void) | null = null
  let afterSend: (() => void) | null = null
  const thread: any = { id: 'thread', status: { type: 'active', activeFlags: [] }, turns: [] }
  const sent: any[] = []
  const reads: string[] = []
  const features = { goals: false, queue: false }
  let goal: unknown = null
  let queue: unknown[] = []
  let background: string[] = []
  let failures = 0
  let opens = 0
  let native = false
  const link: EngineLink = {
    harness: 'claude-code',
    runtime: { features },
    get native() {
      return native
    },
    closed: false,
    async request(method, params: any, options) {
      reads.push(method)
      if (method === 'thread/read') {
        assert.equal(params.includeTurns, false, '原生历史不能整份读回')
        return { thread: { ...structuredClone(thread), turns: [] } }
      }
      if (method === 'thread/turns/list') {
        if (historyMs > 0 && (options?.timeoutMs ?? 0) < historyMs) throw new Error('历史读取超时')
        assert.equal(params.limit, 1)
        return { data: [structuredClone(thread.turns.at(-1))], nextCursor: 'older-history' }
      }
      if (method === 'thread/resume') assert.equal(params.excludeTurns, true)
      if (['thread/read', 'thread/resume'].includes(method) && historyMs > 0) {
        const timeout = options?.timeoutMs ?? 0
        if (timeout < historyMs) throw new Error(`${method} 等了 ${timeout} 毫秒没有应答`)
      }
      if (method === 'thread/goal/get') return { goal }
      if (method === 'thread/queue/list') return { data: queue }
      if (method === 'turn/interrupt') {
        thread.status = { type: 'idle' }
        thread.turns.at(-1).status = 'interrupted'
        return {}
      }
      if (method === 'turn/start') {
        beforeSend?.()
        options?.beforeSend?.()
        sent.push(params)
        const turn = {
          id: 'restored',
          status: 'inProgress',
          items: [{ type: 'userMessage', content: params.input }],
        }
        thread.turns.push(turn)
        afterSend?.()
        if (unknown) throw new Error('发送之后连接断开')
        return { turn }
      }
      return { thread: structuredClone(thread) }
    },
    onNotification: () => () => {},
    onServerRequest: () => () => {},
    claimRequests() {},
    claimed: () => false,
    answer: () => false,
    onClose: () => () => {},
    close() {},
  }
  const make = () =>
    new RestartResume({
      store,
      service: () => service,
      now: () => now,
      open: async () => {
        opens++
        if (failures-- > 0) throw new Error('引擎尚未就绪')
        return link
      },
      background: () => background,
      excluded: () => excluded,
      log() {},
    })
  let resume = make()
  const userTurn = () => {
    const token = resume.input('claude-code', 'thread')
    const turn = {
      id: 'user-turn',
      status: 'inProgress',
      items: [{ type: 'commandExecution', status: 'inProgress', command: 'write external state' }],
    }
    thread.status = { type: 'active', activeFlags: [] }
    thread.turns = [turn]
    resume.accepted('thread', token, { turn })
  }
  return {
    store,
    thread,
    sent,
    reads,
    features,
    userTurn,
    get resume() {
      return resume
    },
    reboot() {
      resume.close()
      service = 'new'
      resume = make()
    },
    setNow(value: number) {
      now = value
    },
    setExcluded() {
      excluded = true
    },
    setUnknown() {
      unknown = true
    },
    setHistoryLatency(ms: number) {
      historyMs = ms
    },
    setBeforeSend(action: () => void) {
      beforeSend = action
    },
    setAfterSend(action: () => void) {
      afterSend = action
    },
    setGoal(value: unknown) {
      goal = value
    },
    setQueue(value: unknown[]) {
      queue = value
    },
    background(value: string[] = ['monitor job-1: watch events']) {
      background = value
    },
    finished() {
      thread.status = { type: 'idle' }
      thread.turns.at(-1).status = 'completed'
      resume.observe('turn/completed', { threadId: 'thread', turn: thread.turns.at(-1) })
    },
    failOpens(count: number) {
      failures = count
      opens = 0
    },
    get opens() {
      return opens
    },
    native() {
      native = true
    },
    close() {
      resume.close()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('原生 Codex 空闲后台恢复只读最近一回合；恢复附着不携带整份历史', async () => {
  const f = fixture()
  try {
    f.native()
    f.userTurn()
    f.background(['litch_background.watch test: command=wait for one event'])
    f.finished()
    assert.deepEqual(await f.resume.prepare(), { prepared: 1 })
    f.reboot()
    await f.resume.recover()
    assert.equal(f.sent.length, 1)
    assert.equal(f.reads.filter((method) => method === 'thread/turns/list').length, 3)
  } finally {
    f.close()
  }
})

test('前台完成、看护仍在：持久化任务、保留完成状态且不重放 interrupt；工作只恢复一次', async () => {
  const f = fixture()
  try {
    f.userTurn()
    f.background()
    f.finished()
    assert.deepEqual(await f.resume.prepare(), { prepared: 1 })
    assert.equal(f.reads.includes('turn/interrupt'), false)
    assert.deepEqual(f.store.rows('ready')[0]?.background, ['monitor job-1: watch events'])
    f.background([])
    f.reboot()
    await f.resume.recover()
    assert.equal(f.sent.length, 1)
    assert.match(f.sent[0].input[0].text, /monitor job-1: watch events/)
    f.finished()
    f.background()
    f.reboot()
    assert.deepEqual(await f.resume.prepare(), { prepared: 0 })
  } finally {
    f.close()
  }
})

for (const mode of [
  'none',
  'stop',
  'plain-stop',
  'waiting',
  'archived',
  'failed',
  'schedule',
  'goal',
  'queue',
  'changed',
  'scope',
  'expired',
] as const) {
  test(`空闲后台恢复排除：${mode}`, async () => {
    const f = fixture()
    try {
      f.userTurn()
      f.background()
      f.finished()
      if (mode === 'none') f.background([])
      if (mode === 'stop') f.resume.cancel('thread')
      if (mode === 'plain-stop') f.resume.stop()
      if (mode === 'waiting') f.thread.status.activeFlags = ['waitingOnUserInput']
      if (mode === 'archived') f.thread.archived = true
      if (mode === 'failed') f.thread.turns[0].status = 'failed'
      if (['schedule', 'goal', 'queue'].includes(mode)) f.thread.turns[0].litchOrigin = mode
      if (mode !== 'plain-stop') await f.resume.prepare(mode === 'scope' ? 'pi' : undefined)
      if (mode === 'changed') f.thread.turns.push({ id: 'new-work', status: 'completed' })
      if (mode === 'expired') f.setNow(1000 + 24 * 3600_000 + 1)
      f.reboot()
      await f.resume.recover()
      assert.equal(f.sent.length, 0)
    } finally {
      f.close()
    }
  })
}

test('后台续做后仍有看护沿用原 token；没有经 Litch 授权的工作不新建恢复资格', async () => {
  const f = fixture()
  try {
    f.background()
    assert.deepEqual(await f.resume.prepare(), { prepared: 0 })
    f.resume.release()
    f.userTurn()
    f.finished()
    f.thread.turns.push({
      id: 'background-turn',
      status: 'completed',
      litchOrigin: 'backgroundTask',
    })
    assert.deepEqual(await f.resume.prepare(), { prepared: 1 })
    assert.equal(f.store.rows('ready')[0]?.turnId, 'background-turn')
    f.reboot()
    await f.resume.recover()
    assert.equal(f.sent.length, 1)
  } finally {
    f.close()
  }
})

test('只读恢复探测退避有上限；成功后只发送一次', async () => {
  for (const failures of [2, 9]) {
    const f = fixture()
    try {
      f.userTurn()
      await f.resume.prepare()
      f.reboot()
      f.failOpens(failures)
      await f.resume.recover()
      assert.equal(f.sent.length, failures === 2 ? 1 : 0)
      assert.equal(f.opens, failures === 2 ? 3 : 4)
      await f.resume.recover()
      assert.equal(f.opens, failures === 2 ? 3 : 4)
    } finally {
      f.close()
    }
  }
})

test('冷启动读取历史超过五秒仍恢复；发送结果不明不重试', async () => {
  const f = fixture()
  try {
    f.userTurn()
    await f.resume.prepare()
    f.reboot()
    f.setHistoryLatency(6000)
    f.setUnknown()
    await f.resume.recover()
    assert.equal(f.sent.length, 1)
    assert.equal(f.store.rows('dispatching').length, 1)
    await f.resume.recover()
    assert.equal(f.sent.length, 1)
  } finally {
    f.close()
  }
})

test('D-16：进行中工具结果未知也准备恢复；原线程只发一次，并告知检查实际副作用', async () => {
  const f = fixture()
  try {
    f.userTurn()
    assert.deepEqual(await f.resume.prepare(), { prepared: 1 })
    await f.resume.recover()
    assert.equal(f.sent.length, 0, '同一服务的 Node 重连不能抢先发送')
    f.reboot()
    await f.resume.recover()
    assert.equal(f.sent.length, 1)
    assert.equal(f.sent[0].threadId, 'thread')
    const text = f.sent[0].input[0].text
    assert.match(text, /files, running processes, and any external side effects/)
    assert.match(text, /Do not blindly repeat/)
    assert.match(text, /grants no new approval/)
    assert.equal(parseSystemMessage(text)?.kind, 'restart')
    await f.resume.recover()
    f.reboot()
    await f.resume.prepare()
    await f.resume.recover()
    assert.equal(f.sent.length, 1, '恢复回合再被打断不生成第二张票')
  } finally {
    f.close()
  }
})

for (const mode of [
  'stop-before',
  'stop-after',
  'stop-at-send',
  'new-input',
  'expired',
  'waiting',
  'excluded',
  'finished',
  'unexpected',
  'plain-stop',
] as const) {
  test(`重启恢复排除：${mode}`, async () => {
    const f = fixture()
    try {
      f.userTurn()
      if (mode === 'stop-before') f.resume.cancel('thread')
      if (mode === 'waiting') f.thread.status.activeFlags = ['waitingOnApproval']
      if (mode === 'excluded') f.setExcluded()
      if (mode === 'finished') f.thread.turns[0].status = 'completed'
      if (mode !== 'unexpected') await f.resume.prepare()
      if (mode === 'stop-after') f.resume.cancel('thread')
      if (mode === 'plain-stop') f.resume.stop()
      if (mode === 'expired') f.setNow(1000 + 24 * 3600_000 + 1)
      f.reboot()
      if (mode === 'new-input') f.userTurn()
      if (mode === 'stop-at-send') f.setBeforeSend(() => f.resume.cancel('thread'))
      await f.resume.recover()
      assert.equal(f.sent.length, 0)
    } finally {
      f.close()
    }
  })
}

test('发送后应答丢失：dispatching 票不会再次发送', async () => {
  const f = fixture()
  try {
    f.userTurn()
    await f.resume.prepare()
    f.setUnknown()
    f.reboot()
    await f.resume.recover()
    assert.equal(f.sent.length, 1)
    assert.equal(f.store.rows('dispatching').length, 1)
    f.reboot()
    await f.resume.recover()
    assert.equal(f.sent.length, 1)
  } finally {
    f.close()
  }
})

test('goal 和设备队列在 resume 前排除，不借附着动作启动自有调度', async () => {
  for (const kind of ['goal', 'queue'] as const) {
    const f = fixture()
    try {
      f.userTurn()
      f.features.goals = true
      f.features.queue = true
      await f.resume.prepare()
      if (kind === 'goal') f.setGoal({ status: 'active' })
      else f.setQueue([{ id: 'queued' }])
      f.reboot()
      await f.resume.recover()
      assert.equal(f.sent.length, 0)
      assert.equal(f.reads.includes('thread/resume'), false)
    } finally {
      f.close()
    }
  }
})

test('停止后迟到的 turn/start 应答不能重新获得恢复资格', async () => {
  const f = fixture()
  try {
    const token = f.resume.input('claude-code', 'thread')
    f.resume.cancel('thread')
    f.resume.accepted('thread', token, { turn: { id: 'late' } })
    assert.equal(f.store.rows('observed').length, 0)
  } finally {
    f.close()
  }
})

test('已经回答过的审批不永久排除普通回合，准备后新出现的待答撤销恢复', async () => {
  for (const duringPreparation of [false, true]) {
    const f = fixture()
    try {
      f.userTurn()
      f.resume.observe('item/commandExecution/requestApproval', { threadId: 'thread' })
      assert.deepEqual(await f.resume.prepare(), { prepared: 1 })
      if (duringPreparation) f.resume.observe('item/tool/requestUserInput', { threadId: 'thread' })
      f.reboot()
      await f.resume.recover()
      assert.equal(f.sent.length, duringPreparation ? 0 : 1)
    } finally {
      f.close()
    }
  }
})

for (const unknown of [false, true]) {
  test(`自动消息发出但编号尚未回显时停止：${unknown ? '应答丢失后核实自己的消息再停' : '应答返回即停新回合'}`, async () => {
    const f = fixture()
    try {
      f.userTurn()
      await f.resume.prepare()
      f.reboot()
      if (unknown) f.setUnknown()
      f.setAfterSend(() => f.resume.cancel('thread'))
      await f.resume.recover()
      assert.equal(f.sent.length, 1)
      assert.equal(f.thread.turns.at(-1).status, 'interrupted')
      f.reboot()
      await f.resume.recover()
      assert.equal(f.sent.length, 1)
    } finally {
      f.close()
    }
  })
}

test('恢复回合中的插话只撤销后续恢复资格，不擅自中断正在执行的回合', async () => {
  const f = fixture()
  try {
    f.userTurn()
    await f.resume.prepare()
    f.reboot()
    await f.resume.recover()
    f.resume.cancel('thread', false)
    assert.equal(f.thread.turns.at(-1).status, 'inProgress')
  } finally {
    f.close()
  }
})

test('新进程启动先为全部 ready 票设屏障，尚未轮到的会话也不能被自动调度抢跑', async () => {
  const f = fixture()
  try {
    f.userTurn()
    await f.resume.prepare()
    f.reboot()
    assert.equal(f.resume.blocked('claude-code', 'thread'), true)
    await f.resume.recover()
    assert.equal(f.resume.blocked('claude-code', 'thread'), false)
  } finally {
    f.close()
  }
})

test('准备阶段崩溃留下的 preparing 票不自动续，也不永久锁住手动订阅', async () => {
  const f = fixture()
  try {
    f.userTurn()
    const row = f.store.rows('observed')[0]
    assert.ok(row)
    f.store.prepare(row, 'old', 1000)
    f.reboot()
    await f.resume.recover()
    assert.equal(f.sent.length, 0)
    assert.equal(f.resume.blocked('claude-code', 'thread'), false)
  } finally {
    f.close()
  }
})
