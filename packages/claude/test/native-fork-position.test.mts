import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  backgroundBash,
  cliProcesses,
  commandAlive,
  disposeScene,
  listTerminals,
  readTurns,
  runTurn,
  say,
  startScene,
  uniqueSleep,
  until,
} from './fixtures/background-scene.mjs'
import { deferred } from './fixtures/deferred.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { isAlive } from './fixtures/process-tree.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 各回合里用户说的话，按回合顺序。
function userTexts(turns: any[]): string[] {
  return turns.map((turn) =>
    turn.items
      .filter((item: any) => item.type === 'userMessage')
      .flatMap((item: any) => item.content.map((part: any) => part.text))
      .join('|'),
  )
}

// 分叉里的回合是新 ID，其余内容与源回合逐字段相同。
const withoutId = (turns: any[]) => turns.map(({ id: _id, ...rest }) => rest)

const readThread = async (client: ProtocolClient, threadId: string) =>
  (await client.request('thread/read', { threadId, includeTurns: true })).thread

// 一个线程落库的全部内容：线程行、回合、原生消息边界和用量。
function stored(db: DatabaseSync, threadId: string) {
  return {
    thread: db.prepare('SELECT * FROM threads WHERE id=?').get(threadId),
    turns: db.prepare('SELECT * FROM turns WHERE thread_id=? ORDER BY rowid').all(threadId),
    boundaries: db
      .prepare(
        `SELECT b.turn_id, b.message_id FROM native_turn_boundaries b
         JOIN turns t ON t.id = b.turn_id WHERE t.thread_id=? ORDER BY t.rowid`,
      )
      .all(threadId),
    usage: db.prepare('SELECT * FROM thread_usage WHERE thread_id=?').get(threadId) ?? null,
  }
}

test('FORK-001：分叉位置决定带走的回合、原生历史和按回合存放的数据，源线程不变', {
  timeout: 240_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-fork-pos-'))
  const model = new MockLLM()
  const url = await model.start()
  let client = await ProtocolClient.start(home, url)
  const db = new DatabaseSync(join(home, 'adapter', 'state.sqlite'))
  const entered = deferred()
  const release = deferred()
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    const other = (await client.request('thread/start', { cwd: home })).thread
    const run = async (threadId: string, input: string) => {
      const { turn } = await client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: input }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
      return turn.id as string
    }
    // 分叉后第一次模型请求里带的历史：留下的回合都在，切掉的一个字都不能出现。
    const expectHistory = (kept: number[], answer: string) =>
      model.enqueue((request) => {
        const history = JSON.stringify(request.messages)
        for (const round of [1, 2, 3]) {
          const marks = new RegExp(`FORK_R${round}_INPUT|FORK_R${round}_ANSWER`)
          if (kept.includes(round)) {
            assert.match(history, new RegExp(`FORK_R${round}_INPUT`))
            assert.match(history, new RegExp(`FORK_R${round}_ANSWER`))
          } else assert.doesNotMatch(history, marks)
        }
        return [{ type: 'text', text: answer }]
      })

    model.enqueue(() => [{ type: 'text', text: 'FORK_R1_ANSWER' }])
    const first = await run(thread.id, 'FORK_R1_INPUT')
    model.enqueue(() => [{ type: 'text', text: 'FORK_R2_ANSWER' }])
    const second = await run(thread.id, 'FORK_R2_INPUT')
    // 第三轮进行中：活动会话不能分叉，带不带位置都一样。
    model.enqueue(async () => {
      entered.resolve()
      await release.promise
      return [{ type: 'text', text: 'FORK_R3_ANSWER' }]
    })
    const running = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'FORK_R3_INPUT' }],
    })
    const third = running.turn.id as string
    await entered.promise
    await client.raw('thread/fork', { threadId: thread.id, lastTurnId: first }, -32009)
    await client.raw('thread/fork', { threadId: thread.id, beforeTurnId: third }, -32009)
    release.resolve()
    assert.equal((await client.completed(third)).status, 'completed')

    const original = await readThread(client, thread.id)
    assert.deepEqual(userTexts(original.turns), ['FORK_R1_INPUT', 'FORK_R2_INPUT', 'FORK_R3_INPUT'])
    const before = stored(db, thread.id)
    assert.equal(before.boundaries.length, 3)
    assert.equal((before.usage as any)?.turn_id, third, '用量记在最后一轮上')

    // 校验：两个位置同时给、类型不对、回合不在这个线程的当前历史里，都不能建出分叉。
    const rejected: Array<Record<string, unknown>> = [
      { threadId: thread.id, lastTurnId: first, beforeTurnId: second },
      { threadId: thread.id, lastTurnId: 'missing' },
      { threadId: thread.id, beforeTurnId: 'missing' },
      { threadId: thread.id, lastTurnId: '' },
      { threadId: thread.id, beforeTurnId: 7 },
      { threadId: other.id, lastTurnId: first },
      { threadId: other.id, beforeTurnId: second },
    ]
    for (const params of rejected) await client.raw('thread/fork', params, -32602)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM threads').get() as any).n, 2)
    assert.equal(model.requests.length, 3, '分叉及其校验不能请求模型')

    // 桌面端走的路径：只发一条带位置和 excludeTurns:true 的 thread/fork，回包不带回合，
    // 再用 thread/turns/list 读；请求里其余字段照桌面端实际发的带上。
    const desktop = await client.request('thread/fork', {
      threadId: thread.id,
      beforeTurnId: second,
      path: null,
      cwd: home,
      runtimeWorkspaceRoots: [home],
      threadSource: 'user',
      model: 'claude-sonnet-4-6',
      config: {},
      developerInstructions: null,
      excludeTurns: true,
    })
    const desktopId = desktop.thread.id as string
    assert.equal(desktop.thread.forkedFromId, thread.id)
    assert.equal(desktop.thread.preview, original.preview)
    assert.deepEqual(desktop.thread.turns, [])
    const listed = await client.request('thread/turns/list', {
      threadId: desktopId,
      itemsView: 'full',
      sortDirection: 'desc',
    })
    assert.deepEqual(withoutId(listed.data), withoutId(original.turns.slice(0, 1)))
    assert.notEqual(listed.data[0].id, first, '分叉里的回合是新 ID')
    assert.equal(listed.nextCursor, null)
    const fromCursor = await client.request('thread/turns/list', {
      threadId: desktopId,
      cursor: desktop.turnsBackwardsCursor,
      sortDirection: 'desc',
      itemsView: 'full',
    })
    assert.deepEqual(fromCursor.data, listed.data, '回包里的头部游标指向保留的最后一轮')
    const items = await client.request('thread/items/list', { threadId: desktopId })
    assert.deepEqual(
      items.data.map((entry: any) => entry.item),
      original.turns[0].items,
    )
    assert.deepEqual((await readThread(client, desktopId)).turns, listed.data)
    const resumed = await client.request('thread/resume', { threadId: desktopId })
    assert.deepEqual(resumed.thread.turns, listed.data)
    const desktopStored = stored(db, desktopId)
    assert.equal(desktopStored.usage, null, '用量记在被切掉的回合上，不能带过来')
    assert.deepEqual(
      desktopStored.boundaries.map((row: any) => row.turn_id),
      [listed.data[0].id],
      '只有带过来的回合有消息边界',
    )
    const nativeSession = (row: any): string | null => row.thread.claude_session_id
    assert.ok(nativeSession(desktopStored))
    assert.notEqual(nativeSession(desktopStored), nativeSession(before))

    // lastTurnId 含这一轮；指向最后一轮时与整份复制一样，用量也跟着过来。
    const throughFirst = await client.request('thread/fork', {
      threadId: thread.id,
      lastTurnId: first,
    })
    assert.deepEqual(withoutId(throughFirst.thread.turns), withoutId(original.turns.slice(0, 1)))
    const throughSecond = await client.request('thread/fork', {
      threadId: thread.id,
      lastTurnId: second,
    })
    const throughSecondId = throughSecond.thread.id as string
    assert.deepEqual(withoutId(throughSecond.thread.turns), withoutId(original.turns.slice(0, 2)))
    assert.equal(stored(db, throughSecondId).usage, null)
    assert.equal(stored(db, throughSecondId).boundaries.length, 2)
    const throughThird = await client.request('thread/fork', {
      threadId: thread.id,
      lastTurnId: third,
    })
    assert.deepEqual(withoutId(throughThird.thread.turns), withoutId(original.turns))
    const whole = stored(db, throughThird.thread.id)
    assert.equal((whole.usage as any).turn_id, throughThird.thread.turns[2].id)
    assert.equal((whole.usage as any).usage_json, (before.usage as any).usage_json)
    assert.equal(whole.boundaries.length, 3)

    // 切在第一轮之前：空分叉，没有原生会话，预览留给它自己的第一条消息。
    const empty = await client.request('thread/fork', { threadId: thread.id, beforeTurnId: first })
    const emptyId = empty.thread.id as string
    assert.deepEqual(empty.thread.turns, [])
    assert.equal(empty.thread.preview, '')
    assert.equal(empty.turnsBackwardsCursor, null)
    const emptyStored = stored(db, emptyId)
    assert.equal(nativeSession(emptyStored), null)
    assert.deepEqual([emptyStored.turns, emptyStored.boundaries, emptyStored.usage], [[], [], null])
    assert.equal(model.requests.length, 3, '分叉本身不请求模型')

    expectHistory([1], 'FORK_DESKTOP_ANSWER')
    await run(desktopId, 'FORK_DESKTOP_INPUT')
    expectHistory([1, 2], 'FORK_THROUGH_SECOND_ANSWER')
    await run(throughSecondId, 'FORK_THROUGH_SECOND_INPUT')
    expectHistory([], 'FORK_EMPTY_ANSWER')
    await run(emptyId, 'FORK_EMPTY_INPUT')
    assert.equal((await readThread(client, emptyId)).preview, 'FORK_EMPTY_INPUT')

    // 分叉里的回合和消息边界都是新的：位置只认它自己的回合 ID，再按位置分叉同样切得干净。
    const desktopTurns = (await readThread(client, desktopId)).turns
    assert.deepEqual(userTexts(desktopTurns), ['FORK_R1_INPUT', 'FORK_DESKTOP_INPUT'])
    await client.raw('thread/fork', { threadId: desktopId, lastTurnId: first }, -32602)
    const nested = await client.request('thread/fork', {
      threadId: desktopId,
      lastTurnId: desktopTurns[0].id,
      excludeTurns: true,
    })
    const nestedId = nested.thread.id as string
    model.enqueue((request) => {
      const history = JSON.stringify(request.messages)
      assert.match(history, /FORK_R1_ANSWER/)
      assert.doesNotMatch(history, /FORK_R2_|FORK_R3_|FORK_DESKTOP_/)
      return [{ type: 'text', text: 'FORK_NESTED_ANSWER' }]
    })
    await run(nestedId, 'FORK_NESTED_INPUT')
    assert.deepEqual(userTexts((await readThread(client, nestedId)).turns), [
      'FORK_R1_INPUT',
      'FORK_NESTED_INPUT',
    ])

    // 源线程：回合、原生会话、消息边界和用量都没动，接着聊时三轮都还在。
    assert.deepEqual(await readThread(client, thread.id), original)
    assert.deepEqual(stored(db, thread.id), before)
    expectHistory([1, 2, 3], 'FORK_SOURCE_ANSWER')
    await run(thread.id, 'FORK_SOURCE_INPUT')

    // 适配器重启后重新读取，各分叉的历史与重启前一致。
    const forkIds = [desktopId, throughFirst.thread.id, throughSecondId, emptyId, nestedId]
    const turnsBefore = new Map<string, any[]>()
    for (const id of forkIds) turnsBefore.set(id, (await readThread(client, id)).turns)
    await client.close()
    client = await ProtocolClient.start(home, url)
    for (const id of forkIds)
      assert.deepEqual((await readThread(client, id)).turns, turnsBefore.get(id))
    const relisted = await client.request('thread/turns/list', {
      threadId: desktopId,
      itemsView: 'full',
      sortDirection: 'asc',
    })
    assert.deepEqual(relisted.data, turnsBefore.get(desktopId))
    const reopened = await client.request('thread/resume', { threadId: desktopId })
    assert.deepEqual(reopened.thread.turns, turnsBefore.get(desktopId))
    model.enqueue((request) => {
      const history = JSON.stringify(request.messages)
      assert.match(history, /FORK_R1_ANSWER/)
      assert.match(history, /FORK_DESKTOP_ANSWER/)
      assert.doesNotMatch(history, /FORK_R2_|FORK_R3_/)
      return [{ type: 'text', text: 'FORK_RESTART_ANSWER' }]
    })
    await run(desktopId, 'FORK_RESTART_INPUT')
    assert.equal(model.requests.length, 9)
    model.assertConsumed()
  } finally {
    release.resolve()
    db.close()
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('FORK-002：失败、被打断的回合作为分叉位置；保留到的回合没有消息边界时拒绝', {
  timeout: 180_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-fork-edge-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  const db = new DatabaseSync(join(home, 'adapter', 'state.sqlite'))
  const held = deferred()
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    const start = async (threadId: string, input: string) =>
      (await client.request('turn/start', { threadId, input: [{ type: 'text', text: input }] }))
        .turn.id as string
    const finish = async (turnId: string, status: string) =>
      assert.equal((await client.completed(turnId)).status, status)

    model.enqueue(() => [{ type: 'text', text: 'EDGE_R1_ANSWER' }])
    const first = await start(thread.id, 'EDGE_R1_INPUT')
    await finish(first, 'completed')
    // 第二轮：模型还没有任何输出就被打断，这一轮没有留下原生消息边界。
    model.enqueue(async () => {
      await held.promise
      return [{ type: 'text', text: 'EDGE_R2_NEVER' }]
    })
    const second = await start(thread.id, 'EDGE_R2_INPUT')
    await until('第二轮的模型请求到达', () => model.requests.length === 2)
    await client.request('turn/interrupt', { threadId: thread.id, turnId: second })
    await finish(second, 'interrupted')
    held.resolve()
    // 第三轮：模型报错，回合失败。
    model.enqueue(() => ({ status: 401, message: 'EDGE_R3_FAILURE' }))
    const third = await start(thread.id, 'EDGE_R3_INPUT')
    await finish(third, 'failed')
    model.enqueue(() => [{ type: 'text', text: 'EDGE_R4_ANSWER' }])
    const fourth = await start(thread.id, 'EDGE_R4_INPUT')
    await finish(fourth, 'completed')

    const before = stored(db, thread.id)
    assert.deepEqual(
      before.boundaries.map((row: any) => row.turn_id),
      [first, third, fourth],
      '没有输出就被打断的回合没有消息边界',
    )
    // 保留到的最后一轮没有消息边界：原生历史切不准，拒绝，不带着错位的上下文分叉。
    for (const position of [{ lastTurnId: second }, { beforeTurnId: third }]) {
      const failure = await client.raw('thread/fork', { threadId: thread.id, ...position }, -32000)
      assert.match(failure.error.message, /缺少原生消息边界，不能安全分叉/)
    }
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM threads').get() as any).n, 1)

    // 失败的回合可以作为终点；它后面的回合不带过去。
    const throughFailed = await client.request('thread/fork', {
      threadId: thread.id,
      lastTurnId: third,
    })
    assert.deepEqual(
      throughFailed.thread.turns.map((turn: any) => turn.status),
      ['completed', 'interrupted', 'failed'],
    )
    assert.deepEqual(userTexts(throughFailed.thread.turns), [
      'EDGE_R1_INPUT',
      'EDGE_R2_INPUT',
      'EDGE_R3_INPUT',
    ])
    model.enqueue((request) => {
      const history = JSON.stringify(request.messages)
      assert.match(history, /EDGE_R1_ANSWER/)
      assert.doesNotMatch(history, /EDGE_R4_/)
      return [{ type: 'text', text: 'EDGE_THROUGH_FAILED_ANSWER' }]
    })
    await finish(await start(throughFailed.thread.id, 'EDGE_THROUGH_FAILED_INPUT'), 'completed')

    // 切在被打断的回合之前：保留到的是正常结束的第一轮。
    const beforeInterrupted = await client.request('thread/fork', {
      threadId: thread.id,
      beforeTurnId: second,
      excludeTurns: true,
    })
    const kept = await client.request('thread/turns/list', {
      threadId: beforeInterrupted.thread.id,
      itemsView: 'full',
    })
    assert.deepEqual(userTexts(kept.data), ['EDGE_R1_INPUT'])
    model.enqueue((request) => {
      const history = JSON.stringify(request.messages)
      assert.match(history, /EDGE_R1_ANSWER/)
      assert.doesNotMatch(history, /EDGE_R2_|EDGE_R3_|EDGE_R4_/)
      return [{ type: 'text', text: 'EDGE_BEFORE_INTERRUPTED_ANSWER' }]
    })
    await finish(
      await start(beforeInterrupted.thread.id, 'EDGE_BEFORE_INTERRUPTED_INPUT'),
      'completed',
    )

    // 保留到最后一轮等于整份复制，不需要逐回合的消息边界。
    const whole = await client.request('thread/fork', { threadId: thread.id, lastTurnId: fourth })
    assert.equal(whole.thread.turns.length, 4)
    assert.deepEqual(stored(db, thread.id), before, '分叉与被拒绝的分叉都不能改动源线程')
    assert.equal(model.requests.length, 6)
    model.assertConsumed()
  } finally {
    held.resolve()
    db.close()
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('FORK-003：源线程留着进程和后台命令时按位置分叉，进程、后台命令和原生会话都不受影响', {
  timeout: 180_000,
}, async () => {
  const scene = await startScene('native-fork-live')
  const command = uniqueSleep(600)
  try {
    scene.model.enqueue(say('LIVE_R1_ANSWER'))
    assert.equal((await runTurn(scene, 'LIVE_R1_INPUT')).status, 'completed')
    scene.model.enqueue(backgroundBash('toolu_fork_live', command))
    scene.model.enqueue(say('LIVE_R2_ANSWER'))
    const second = await runTurn(scene, 'LIVE_R2_INPUT')
    assert.equal(second.status, 'completed')
    const [cli] = cliProcesses(scene)
    assert.ok(cli, '回合结束后进程应留下')
    assert.equal(commandAlive(command), true)
    const terminals = (await listTerminals(scene)).map((terminal) => terminal.processId)
    assert.equal(terminals.length, 1)
    const sourceTurns = await readTurns(scene)

    const fork = await scene.client.request('thread/fork', {
      threadId: scene.threadId,
      beforeTurnId: second.id,
      excludeTurns: true,
    })
    const forkId = fork.thread.id as string
    const sourceUntouched = async () => {
      assert.equal(isAlive(cli.pid), true, '源线程的进程还在')
      assert.equal(commandAlive(command), true, '后台命令照常运行')
      assert.deepEqual(
        (await listTerminals(scene)).map((terminal) => terminal.processId),
        terminals,
      )
    }
    await sourceUntouched()
    assert.deepEqual(
      cliProcesses(scene).map((row) => row.pid),
      [cli.pid],
      '分叉本身不起进程',
    )
    const listed = await scene.client.request('thread/turns/list', {
      threadId: forkId,
      itemsView: 'full',
    })
    assert.deepEqual(userTexts(listed.data), ['LIVE_R1_INPUT'])
    assert.deepEqual(
      (await scene.client.request('thread/backgroundTerminals/list', { threadId: forkId })).data,
      [],
      '后台命令属于被切掉的回合，不在分叉名下',
    )

    // 分叉接着聊：历史里只有第一轮，源线程的进程不被占用也不被结束。
    scene.model.enqueue((request) => {
      const history = JSON.stringify(request.messages)
      assert.match(history, /LIVE_R1_ANSWER/)
      assert.doesNotMatch(history, /LIVE_R2_|toolu_fork_live/)
      return [{ type: 'text', text: 'LIVE_FORK_ANSWER' }]
    })
    const { turn } = await scene.client.request('turn/start', {
      threadId: forkId,
      input: [{ type: 'text', text: 'LIVE_FORK_INPUT' }],
    })
    assert.equal((await scene.client.completed(turn.id)).status, 'completed')
    await sourceUntouched()

    // 源线程接着用原来的进程，两轮都还在。
    scene.model.enqueue((request) => {
      const history = JSON.stringify(request.messages)
      assert.match(history, /LIVE_R1_ANSWER/)
      assert.match(history, /LIVE_R2_ANSWER/)
      assert.doesNotMatch(history, /LIVE_FORK_/)
      return [{ type: 'text', text: 'LIVE_R3_ANSWER' }]
    })
    assert.equal((await runTurn(scene, 'LIVE_R3_INPUT')).status, 'completed')
    await sourceUntouched()
    assert.deepEqual((await readTurns(scene)).slice(0, 2), sourceTurns)
    scene.model.assertConsumed()
  } finally {
    await disposeScene(scene)
  }
})
