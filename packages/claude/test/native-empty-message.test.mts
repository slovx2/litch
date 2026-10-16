import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM, type ModelRequest } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 没有字的回答不出条目（真实 CLI）：上游读历史时跳过空的回答，手动压缩的回合里只有压缩条目。
// 实时的 item/started、item/completed 和 thread/read 读回的都没有空的 agentMessage。

const say = (text: string) => [{ type: 'text', text }]

// 回答条目开始时还没有字、之后由增量补上，所以只看收尾时有没有字。
function emptyAnswers(client: ProtocolClient, threadId: string): any[] {
  return client.trace
    .filter(
      (x) =>
        x.method === 'item/completed' &&
        x.params.threadId === threadId &&
        x.params.item.type === 'agentMessage' &&
        x.params.item.text === '',
    )
    .map((x) => x.params.item)
}

test('EMPTY-001：手动压缩的回合里只有压缩条目，没有空的回答', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-empty-compact-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    model.enqueue(() => say('压缩之前的回答'))
    const { thread } = await client.request('thread/start', { cwd: home })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '压缩之前的话' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    model.enqueue(() => say('压缩出来的摘要'))
    await client.request('thread/compact/start', { threadId: thread.id })
    const started = await client.notification('turn/started', (p) => p.turn.id !== turn.id)
    const compacted = await client.completed(started.turn.id)
    assert.equal(compacted.status, 'completed', JSON.stringify(compacted))
    await client.notification('thread/compacted')
    model.assertConsumed()
    const live = (method: string) =>
      client.trace
        .filter((x) => x.method === method && x.params.turnId === started.turn.id)
        .map((x) => x.params.item.type)
    assert.deepEqual(live('item/started'), ['contextCompaction'])
    assert.deepEqual(live('item/completed'), ['contextCompaction'])
    const read = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    assert.deepEqual(
      read.thread.turns.at(-1).items.map((item: any) => item.type),
      ['contextCompaction'],
    )
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('EMPTY-002：子代理最后什么也没说，子线程里不留空的回答', { timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-empty-subagent-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    // 父子请求可能交错到达，按请求内容路由
    const route = async (request: ModelRequest) => {
      const messages = (request.messages ?? []) as Array<Record<string, any>>
      const first = JSON.stringify(messages[0]?.content ?? '')
      const answered = messages.some((message) => message.role === 'assistant')
      if (first.includes('EMPTY_MAIN'))
        return answered
          ? say('MAIN_DONE')
          : [
              {
                type: 'tool_use',
                id: 'toolu_empty_agent',
                name: 'Agent',
                input: {
                  description: '什么也不说',
                  prompt: 'EMPTY_CHILD 什么也别说',
                  subagent_type: 'general-purpose',
                  run_in_background: false,
                },
              },
            ]
      // 只有空白：CLI 交回的子代理结果里没有字
      if (first.includes('EMPTY_CHILD')) return say(' ')
      throw new Error('收到无法归属的模型请求')
    }
    for (let index = 0; index < 4; index++) model.enqueue(route)
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'EMPTY_MAIN 派个子代理' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    const children = client.trace
      .filter((x) => x.method === 'thread/started' && x.params.thread.id !== thread.id)
      .map((x) => x.params.thread.id)
    assert.equal(children.length, 1)
    const child = (
      await client.request('thread/read', { threadId: children[0], includeTurns: true })
    ).thread
    assert.equal(child.turns.length, 1)
    assert.deepEqual(
      child.turns[0].items.filter((item: any) => item.type === 'agentMessage'),
      [],
    )
    assert.deepEqual(emptyAnswers(client, children[0]), [])
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
