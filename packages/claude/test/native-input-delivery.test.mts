import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 只裁掉本用例声明的扩展字段，其余数据仍走官方协议校验。
function standard(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, entry: unknown) =>
      key === 'litchInputDelivery' ? undefined : entry,
    ),
  )
}

async function entered(path: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      await access(path)
      return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('隔离同步工具未启动')
}

for (const background of [false, true]) {
  test(`INPUT-DELIVERY：${background ? '保留后台进程' : '关闭进程'}取消插话后保留明确待发回执`, {
    timeout: 60_000,
  }, async () => {
    const home = await mkdtemp('/tmp/litch-input-')
    const model = new MockLLM()
    const client = await ProtocolClient.start(
      home,
      await model.start(),
      false,
      'api-key',
      {
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: background ? '0' : '1',
      },
      { litchExtensions: ['inputDelivery'] },
    )
    client.standardView = (_method, _kind, payload) => standard(payload)
    try {
      const { thread } = await client.request('thread/start', {
        cwd: home,
        model: 'sonnet',
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      })
      if (background)
        model.enqueue(() => [
          {
            type: 'tool_use',
            id: 'background',
            name: 'Bash',
            input: {
              command: '/bin/sleep 60',
              timeout: 90000,
              run_in_background: true,
              description: '隔离后台任务',
            },
          },
        ])
      model.enqueue(() => [
        {
          type: 'tool_use',
          id: 'sync',
          name: 'Bash',
          input: {
            command: `/usr/bin/touch ${home}/entered; /bin/sleep 20`,
            timeout: 30000,
            description: '隔离同步等待',
          },
        },
      ])
      model.fallback = () => [{ type: 'text', text: '完成' }]
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: 'INITIAL' }],
      })
      await entered(`${home}/entered`)
      for (const text of ['ALPHA', 'BETA'])
        await client.request('turn/steer', {
          threadId: thread.id,
          expectedTurnId: turn.id,
          clientUserMessageId: `client-${text}`,
          input: [{ type: 'text', text }],
        })
      const inputEvents = () =>
        client.trace.filter(
          (event: any) =>
            event.method === 'item/completed' && event.params.item.clientId?.startsWith('client-'),
        )
      assert.ok(inputEvents().length >= 2)
      assert.ok(
        inputEvents().every((event: any) => event.params.item.litchInputDelivery === 'queued'),
      )
      assert.equal(model.requests.length, background ? 2 : 1)
      await client.request('turn/interrupt', { threadId: thread.id, turnId: turn.id })
      assert.equal((await client.completed(turn.id)).status, 'interrupted')
      const read = await client.raw('thread/read', { threadId: thread.id, includeTurns: true })
      const messages = read.result.thread.turns[0].items.filter((item: any) =>
        item.clientId?.startsWith('client-'),
      )
      assert.deepEqual(
        messages.map((item: any) => item.litchInputDelivery),
        ['held', 'held'],
      )
      // 停止不偷偷继续处理；内容由待发副本保留，明确重发时才进入后续模型请求。
      assert.ok(
        model.requests.every((request) => !JSON.stringify(request.messages).includes('ALPHA')),
      )
      const resumed = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: 'ALPHA\nBETA\n继续' }],
      })
      assert.equal((await client.completed(resumed.turn.id)).status, 'completed')
      assert.match(JSON.stringify(model.requests.at(-1)?.messages), /ALPHA\\nBETA/)
    } finally {
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true })
    }
  })
}

test('INPUT-DELIVERY：自然消费后回显 sent，停止不能把已接纳输入退回待发', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp('/tmp/litch-input-')
  const model = new MockLLM()
  const client = await ProtocolClient.start(
    home,
    await model.start(),
    false,
    'api-key',
    {
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    },
    { litchExtensions: ['inputDelivery'] },
  )
  client.standardView = (_method, _kind, payload) => standard(payload)
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      model: 'sonnet',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    model.enqueue(() => [
      {
        type: 'tool_use',
        id: 'sync',
        name: 'Bash',
        input: {
          command: `/usr/bin/touch ${home}/entered; /bin/sleep 1`,
          timeout: 3000,
          description: '隔离同步等待',
        },
      },
    ])
    model.enqueue((request) => {
      assert.match(JSON.stringify(request.messages), /DELIVERED/)
      return [{ type: 'text', text: '完成' }]
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'INITIAL' }],
    })
    await entered(`${home}/entered`)
    await client.request('turn/steer', {
      threadId: thread.id,
      expectedTurnId: turn.id,
      clientUserMessageId: 'consumed',
      input: [{ type: 'text', text: 'DELIVERED' }],
    })
    await client.notification(
      'item/completed',
      (params) => params.item.clientId === 'consumed' && params.item.litchInputDelivery === 'sent',
    )
    assert.equal((await client.completed(turn.id)).status, 'completed')
    const read = await client.raw('thread/read', { threadId: thread.id, includeTurns: true })
    assert.equal(
      read.result.thread.turns[0].items.find((item: any) => item.clientId === 'consumed')
        .litchInputDelivery,
      'sent',
    )
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})
