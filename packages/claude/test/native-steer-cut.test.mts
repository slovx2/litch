import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { cutBeforeSteer, readCutBeforeSteer } from '../src/steer-cut.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// 插话在原生记录里是一行 queued_command 附件，source_uuid 是交给 CLI 时的消息标识；
// 切口是它前面第一条主线上的用户或助手消息（跳过附件、系统提醒、子代理的行）
test('STEER-CUT-001：从插话那一行往前找切口', () => {
  const lines = [
    { type: 'user', uuid: 'u1', parentUuid: null },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1' },
    { type: 'user', uuid: 'r1', parentUuid: 'a1' },
    { type: 'assistant', uuid: 'side', parentUuid: 'r1', isSidechain: true },
    { type: 'user', uuid: 'meta', parentUuid: 'r1', isMeta: true },
    { type: 'attachment', uuid: 'env', parentUuid: 'meta', attachment: { type: 'environment' } },
    {
      type: 'attachment',
      uuid: 'q1',
      parentUuid: 'env',
      attachment: { type: 'queued_command', source_uuid: 'STEER' },
    },
    { type: 'assistant', uuid: 'a2', parentUuid: 'q1' },
    { type: 'user', uuid: 'LATE', parentUuid: 'a2' },
  ]
  const content = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n{broken`
  assert.equal(cutBeforeSteer(content, 'STEER'), 'r1')
  // 回合正在收尾时 CLI 把它当成一句普通的话收下：那一行的标识就是它
  assert.equal(cutBeforeSteer(content, 'LATE'), 'a2')
  assert.equal(cutBeforeSteer(content, 'MISSING'), null)

  // 复制过的记录：普通用户消息那一行换了标识，按 forkedFrom 到来源里找了再对回来，复制几次找几层
  type Line = { uuid: string; parentUuid: string | null } & Record<string, unknown>
  const copy = (from: string, rows: Line[], rename: (id: string) => string): Line[] =>
    rows.map((line) => ({
      ...line,
      uuid: rename(line.uuid),
      parentUuid: line.parentUuid === null ? null : rename(line.parentUuid),
      forkedFrom: { sessionId: from, messageUuid: line.uuid },
    }))
  const once = copy('S0', lines, (id) => `${id}-1`)
  const twice = copy('S1', once, (id) => id.replace(/-1$/, '-2'))
  const records: Record<string, string> = {
    S0: lines.map((line) => JSON.stringify(line)).join('\n'),
    S1: once.map((line) => JSON.stringify(line)).join('\n'),
  }
  const load = (sessionId: string) => records[sessionId] ?? null
  const latest = twice.map((line) => JSON.stringify(line)).join('\n')
  assert.equal(cutBeforeSteer(latest, 'LATE'), null, '不给来源就认不出')
  assert.equal(cutBeforeSteer(latest, 'LATE', load), 'a2-2')
  // 附件里的 source_uuid 复制时照旧，直接认得
  assert.equal(cutBeforeSteer(latest, 'STEER'), 'r1-2')
  assert.equal(cutBeforeSteer(latest, 'MISSING', load), null)
  assert.equal(
    cutBeforeSteer(latest, 'LATE', () => null),
    null,
    '来源读不到不猜',
  )
})

// linux-test 上那次（CLI 2.1.287）：插话前 CLI 停了一下，插话记成一行普通的用户消息，标识是条目自己的。
// 原生会话用真的 SDK 复制两次（分叉、回退都这样复制）之后，照样找得到切口
test('STEER-CUT-003：记成普通用户消息的插话，原生会话复制过之后照样找得到切口', async () => {
  const root = await mkdtemp(join(tmpdir(), 'steer-cut-fork-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
  try {
    const cwd = '/steer-cut-fixture'
    const dir = join(root, 'claude', 'projects', '-steer-cut-fixture')
    await mkdir(dir, { recursive: true })
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`
    const base = {
      sessionId,
      cwd,
      version: '2.1.287',
      timestamp: '2026-10-24T16:30:00.000Z',
      isSidechain: false,
      userType: 'external',
    }
    const user = (n: number, parent: number | null, content: string) => ({
      ...base,
      type: 'user',
      uuid: id(n),
      parentUuid: parent === null ? null : id(parent),
      message: { role: 'user', content },
    })
    const answer = (n: number, parent: number, text: string) => ({
      ...base,
      type: 'assistant',
      uuid: id(n),
      parentUuid: id(parent),
      message: { role: 'assistant', id: `msg_${n}`, content: [{ type: 'text', text }] },
    })
    const steer = id(4)
    const rows = [
      user(1, null, 'TURN_INPUT'),
      answer(2, 1, 'BEFORE_STEER'),
      user(3, 2, '[Request interrupted by user]'),
      user(4, 3, 'STEER_INPUT'),
      answer(5, 4, 'AFTER_STEER'),
    ]
    await writeFile(
      join(dir, `${sessionId}.jsonl`),
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    )
    assert.equal(readCutBeforeSteer(sessionId, steer), id(3))
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    const once = await sdk.forkSession(sessionId, { dir: cwd })
    const twice = await sdk.forkSession(once.sessionId, { dir: cwd })
    const cut = readCutBeforeSteer(twice.sessionId, steer)
    assert.ok(cut && cut !== id(3), '切口是复制后那一行的标识')
    // 从这个切口再复制一份：留到插话前停下的那一行，插话和它后面的都不在
    const kept = await sdk.getSessionMessages(
      (await sdk.forkSession(twice.sessionId, { dir: cwd, upToMessageId: cut })).sessionId,
      { dir: cwd },
    )
    const said = JSON.stringify(kept)
    assert.match(said, /BEFORE_STEER/)
    assert.doesNotMatch(said, /STEER_INPUT|AFTER_STEER/)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('STEER-CUT-002：真实 CLI 里分叉、回退切在插话之前，模型只看到插话前的内容', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-steer-cut-'))
  const model = new MockLLM()
  const url = await model.start()
  const client = await ProtocolClient.start(home, url)
  const entered = gate()
  const release = gate()
  try {
    client.onTool = async () => {
      entered.resolve()
      await release.promise
      return { success: true, contentItems: [{ type: 'inputText', text: 'CUT_TOOL_RESULT' }] }
    }
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      dynamicTools: [
        {
          type: 'function',
          name: 'wait_fixture',
          description: '等待测试信号',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    })
    const read = async (threadId: string) =>
      (await client.request('thread/read', { threadId, includeTurns: true })).thread
    model.enqueue(() => [{ type: 'text', text: 'KEEP_ANSWER' }])
    const first = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'KEEP_INPUT' }],
    })
    assert.equal((await client.completed(first.turn.id)).status, 'completed')

    // 第二个回合等在工具上时插一句话，工具放行后模型在同一回合里回它
    model.enqueue((request) => [
      {
        type: 'tool_use',
        id: 'toolu_cut_wait',
        name: request.tools.find((entry: any) =>
          entry.name.startsWith('mcp__codex_harness_adapter__'),
        ).name,
        input: {},
      },
    ])
    model.enqueue((request) => {
      assert.match(JSON.stringify(request.messages), /CUT_STEER_INPUT/)
      return [{ type: 'text', text: 'AFTER_STEER_ANSWER' }]
    })
    const second = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'CUT_TURN_INPUT' }],
    })
    await entered.promise
    await client.request('turn/steer', {
      threadId: thread.id,
      expectedTurnId: second.turn.id,
      clientUserMessageId: 'cut-steer',
      input: [{ type: 'text', text: 'CUT_STEER_INPUT' }],
    })
    release.resolve()
    assert.equal((await client.completed(second.turn.id)).status, 'completed')
    const before = await read(thread.id)
    const turn = before.turns[1]
    const users = turn.items.filter((item: any) => item.type === 'userMessage')
    assert.equal(users.length, 2)
    const steer = users[1]
    const at = turn.items.indexOf(steer)
    const kept = turn.items.slice(0, at)
    assert.ok(kept.some((item: any) => item.type === 'dynamicToolCall'))

    // 只能切在用户消息上，回合要已经结束
    await client.raw(
      'thread/revert',
      { threadId: thread.id, beforeTurnId: second.turn.id, beforeItemId: kept.at(-1).id },
      -32602,
    )
    await client.raw('thread/fork', { threadId: thread.id, beforeItemId: steer.id }, -32602)

    // 分叉：新会话里这一回合只到插话之前，模型看得到工具结果，看不到插话和回它的话
    const branch = (
      await client.request('thread/fork', {
        threadId: thread.id,
        beforeTurnId: second.turn.id,
        beforeItemId: steer.id,
      })
    ).thread
    const forked = await read(branch.id)
    assert.equal(forked.turns.length, 2)
    assert.deepEqual(
      forked.turns[1].items.map((item: any) => item.id),
      kept.map((item: any) => item.id),
    )
    model.enqueue((request) => {
      const history = JSON.stringify(request.messages)
      assert.match(history, /KEEP_ANSWER/)
      assert.match(history, /CUT_TURN_INPUT/)
      assert.match(history, /CUT_TOOL_RESULT/)
      assert.doesNotMatch(history, /CUT_STEER_INPUT|AFTER_STEER_ANSWER/)
      return [{ type: 'text', text: 'FORK_NEXT_ANSWER' }]
    })
    const branchTurn = await client.request('turn/start', {
      threadId: branch.id,
      input: [{ type: 'text', text: 'FORK_NEXT_INPUT' }],
    })
    assert.equal((await client.completed(branchTurn.turn.id)).status, 'completed')
    assert.deepEqual((await read(thread.id)).turns, before.turns, '分叉不能改父会话')

    // 回退：原会话这一回合只留前半段，之后的回合都不要；同一个消息号可以再插一次
    await client.request('thread/revert', {
      threadId: thread.id,
      beforeTurnId: second.turn.id,
      beforeItemId: steer.id,
    })
    await client.notification('thread/reverted', (params) => params.threadId === thread.id)
    const after = await read(thread.id)
    assert.equal(after.turns.length, 2)
    assert.deepEqual(after.turns[0], before.turns[0])
    assert.deepEqual(
      after.turns[1].items.map((item: any) => item.id),
      kept.map((item: any) => item.id),
    )
    model.enqueue((request) => {
      const history = JSON.stringify(request.messages)
      assert.match(history, /KEEP_ANSWER/)
      assert.match(history, /CUT_TOOL_RESULT/)
      assert.doesNotMatch(history, /CUT_STEER_INPUT|AFTER_STEER_ANSWER|FORK_NEXT_/)
      return [{ type: 'text', text: 'REVERT_NEXT_ANSWER' }]
    })
    const next = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'REVERT_NEXT_INPUT' }],
    })
    assert.equal((await client.completed(next.turn.id)).status, 'completed')
    model.assertConsumed()
  } finally {
    release.resolve()
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('STEER-CUT-004：真实 CLI 里分叉后再插话、再回退，分叉前的插话在分叉里也切得开', {
  timeout: 180_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-steer-cut-fork-'))
  const model = new MockLLM()
  const url = await model.start()
  const client = await ProtocolClient.start(home, url)
  let waiting = gate()
  let release = gate()
  try {
    client.onTool = async () => {
      waiting.resolve()
      await release.promise
      return { success: true, contentItems: [{ type: 'inputText', text: 'TOOL_RESULT' }] }
    }
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      dynamicTools: [
        {
          type: 'function',
          name: 'wait_fixture',
          description: '等待测试信号',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    })
    const read = async (threadId: string) =>
      (await client.request('thread/read', { threadId, includeTurns: true })).thread
    /** 一个回合：等在工具上时插一句 steerText，工具放行后模型在同一回合里回它。返回插话的条目 */
    const steered = async (threadId: string, text: string, steerText: string) => {
      waiting = gate()
      release = gate()
      model.enqueue((request) => [
        {
          type: 'tool_use',
          id: `toolu_${text}`,
          name: request.tools.find((entry: any) =>
            entry.name.startsWith('mcp__codex_harness_adapter__'),
          ).name,
          input: {},
        },
      ])
      model.enqueue((request) => {
        assert.match(JSON.stringify(request.messages), new RegExp(steerText))
        return [{ type: 'text', text: `${steerText}_ANSWER` }]
      })
      const { turn } = await client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text }],
      })
      await waiting.promise
      await client.request('turn/steer', {
        threadId,
        expectedTurnId: turn.id,
        clientUserMessageId: `steer-${steerText}`,
        input: [{ type: 'text', text: steerText }],
      })
      release.resolve()
      assert.equal((await client.completed(turn.id)).status, 'completed')
      const items = (await read(threadId)).turns.find((each: any) => each.id === turn.id).items
      const users = items.filter((item: any) => item.type === 'userMessage')
      assert.equal(users.length, 2)
      return { turnId: turn.id, steer: users[1], kept: items.slice(0, items.indexOf(users[1])) }
    }
    const revert = async (threadId: string, turnId: string, itemId: string) => {
      await client.request('thread/revert', {
        threadId,
        beforeTurnId: turnId,
        beforeItemId: itemId,
      })
      await client.notification('thread/reverted', (params) => params.threadId === threadId)
      return read(threadId)
    }
    const ids = (items: any[]) => items.map((item: any) => item.id)

    model.enqueue(() => [{ type: 'text', text: 'KEEP_ANSWER' }])
    const first = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'KEEP_INPUT' }],
    })
    assert.equal((await client.completed(first.turn.id)).status, 'completed')
    const early = await steered(thread.id, 'EARLY_TURN', 'EARLY_STEER')
    const before = await read(thread.id)

    // 整个会话分叉出去（原生会话复制一份），分叉里接着开一个回合并插话
    const branch = (await client.request('thread/fork', { threadId: thread.id })).thread
    // 分叉里的回合有自己的标识，条目的标识照旧
    const copied = (await read(branch.id)).turns[1]
    assert.deepEqual(ids(copied.items), ids(before.turns[1].items))
    const late = await steered(branch.id, 'LATE_TURN', 'LATE_STEER')

    // 分叉里回退到它后来插的那句话之前
    let after = await revert(branch.id, late.turnId, late.steer.id)
    assert.equal(after.turns.length, 3)
    assert.deepEqual(ids(after.turns[2].items), ids(late.kept))
    // 再回退到分叉之前就有的那句插话之前（原生会话这时已经复制过两次）
    after = await revert(branch.id, copied.id, early.steer.id)
    assert.equal(after.turns.length, 2)
    assert.deepEqual(ids(after.turns[1].items), ids(early.kept))
    model.enqueue((request) => {
      const history = JSON.stringify(request.messages)
      assert.match(history, /KEEP_ANSWER/)
      assert.match(history, /EARLY_TURN/)
      assert.match(history, /TOOL_RESULT/)
      assert.doesNotMatch(history, /EARLY_STEER|LATE_/)
      return [{ type: 'text', text: 'BRANCH_NEXT_ANSWER' }]
    })
    const next = await client.request('turn/start', {
      threadId: branch.id,
      input: [{ type: 'text', text: 'BRANCH_NEXT_INPUT' }],
    })
    assert.equal((await client.completed(next.turn.id)).status, 'completed')
    assert.deepEqual((await read(thread.id)).turns, before.turns, '分叉里回退不能改父会话')
    model.assertConsumed()
  } finally {
    release.resolve()
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// 停止会取消 CLI 中未消费的插话，不再让它偷偷续跑；没有原生消费边界时也不能误切整个回合。
test('STEER-CUT-005：停止保留未消费插话，拒绝虚构切口，显式发送后只消费一次', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-steer-cut-stop-'))
  const model = new MockLLM()
  const url = await model.start()
  const client = await ProtocolClient.start(
    home,
    url,
    false,
    'api-key',
    {},
    {
      litchExtensions: ['inputDelivery'],
    },
  )
  client.standardView = (_method, _kind, payload) =>
    JSON.parse(
      JSON.stringify(payload, (key, value: unknown) =>
        key === 'litchInputDelivery' ? undefined : value,
      ),
    )
  const entered = gate()
  const release = gate()
  try {
    client.onTool = async () => {
      entered.resolve()
      await release.promise
      return { success: true, contentItems: [{ type: 'inputText', text: 'STOP_TOOL_RESULT' }] }
    }
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      dynamicTools: [
        {
          type: 'function',
          name: 'wait_fixture',
          description: '等待测试信号',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    })
    const read = async (threadId: string) =>
      (await client.raw('thread/read', { threadId, includeTurns: true })).result.thread
    model.enqueue(() => [{ type: 'text', text: 'KEEP_ANSWER' }])
    const first = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'KEEP_INPUT' }],
    })
    assert.equal((await client.completed(first.turn.id)).status, 'completed')
    model.enqueue((request) => [
      {
        type: 'tool_use',
        id: 'toolu_stop_wait',
        name: request.tools.find((entry: any) =>
          entry.name.startsWith('mcp__codex_harness_adapter__'),
        ).name,
        input: {},
      },
    ])
    const second = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'STOP_TURN_INPUT' }],
    })
    await Promise.race([
      entered.promise,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('等待工具未进入')), 30_000)
        timer.unref()
      }),
    ])
    await client.request('turn/steer', {
      threadId: thread.id,
      expectedTurnId: second.turn.id,
      clientUserMessageId: 'stop-steer',
      input: [{ type: 'text', text: 'STOP_STEER_INPUT' }],
    })
    await client.request('turn/interrupt', { threadId: thread.id, turnId: second.turn.id })
    release.resolve()
    assert.equal((await client.completed(second.turn.id)).status, 'interrupted')
    model.assertConsumed()
    const before = await read(thread.id)
    const turn = before.turns[1]
    const users = turn.items.filter((item: any) => item.type === 'userMessage')
    assert.equal(users.length, 2)
    const steer = users[1]
    assert.equal(steer.clientId, 'stop-steer')
    assert.equal(steer.litchInputDelivery, 'held')
    assert.equal(
      steer.content.map((part: { text?: string }) => part.text ?? '').join(''),
      'STOP_STEER_INPUT',
      '取消回执仍保留完整原文供用户恢复',
    )
    assert.equal(model.requests.length, 2, '停止之后不能自动续发')
    assert.ok(
      model.requests.every(
        (request) => !JSON.stringify(request.messages).includes('STOP_STEER_INPUT'),
      ),
      '尚未消费的插话只保留在待发副本里',
    )

    // 未消费的插话没有原生切口：拒绝回退、分叉，会话和原生记录都不动。
    const projects = join(home, 'claude', 'projects')
    let native = ''
    for (const dir of await readdir(projects))
      for (const file of await readdir(join(projects, dir)))
        if (
          file.endsWith('.jsonl') &&
          (await readFile(join(projects, dir, file), 'utf8')).includes('STOP_TURN_INPUT')
        )
          native = join(projects, dir, file)
    const record = await readFile(native, 'utf8')
    assert.equal(cutBeforeSteer(record, steer.id), null)
    await client.raw(
      'thread/revert',
      { threadId: thread.id, beforeTurnId: second.turn.id, beforeItemId: steer.id },
      -32000,
    )
    await client.raw(
      'thread/fork',
      { threadId: thread.id, beforeTurnId: second.turn.id, beforeItemId: steer.id },
      -32000,
    )
    assert.deepEqual((await read(thread.id)).turns, before.turns)
    assert.equal(await readFile(native, 'utf8'), record)

    // 用户明确恢复才会送入模型，原待发副本仍然可查，不能被重复注入模型上下文。
    model.enqueue((request) => {
      const history = JSON.stringify(request.messages)
      assert.match(history, /KEEP_ANSWER/)
      assert.match(history, /STOP_TURN_INPUT/)
      assert.equal(history.split('STOP_STEER_INPUT').length - 1, 1)
      return [{ type: 'text', text: 'STOP_STEER_ANSWER' }]
    })
    const next = await client.request('turn/start', {
      threadId: thread.id,
      input: steer.content,
    })
    assert.equal((await client.completed(next.turn.id)).status, 'completed')
    assert.equal(model.requests.length, 3, '显式恢复只新增一次模型请求')
    const after = await read(thread.id)
    assert.equal(after.turns.length, 3)
    assert.deepEqual(after.turns[1], before.turns[1], '保留原待发凭据，不伪装成已经消费')
    assert.equal(after.turns[2].items.filter((item: any) => item.type === 'userMessage').length, 1)
    model.assertConsumed()
  } finally {
    release.resolve()
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
