import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { cutBeforeSteer } from '../src/steer-cut.mjs'
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
