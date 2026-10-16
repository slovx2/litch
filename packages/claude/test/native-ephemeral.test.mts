import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 临时会话在真实 CLI 上：官方桌面端（26.1007）改名之后起描述的那一套（参数照解包代码里的形状）。
// 进程内的那份（不起 CLI）在 ephemeral-threads.test.mts。

const text = (value: string) => [{ type: 'text', text: value }]

const DESCRIBE_SCHEMA = {
  type: 'object',
  properties: { description: { type: 'string', minLength: 1 } },
  required: ['description'],
  additionalProperties: false,
}

async function withClient(
  prefix: string,
  run: (client: ProtocolClient, model: MockLLM, home: string) => Promise<void>,
  env: Record<string, string> = {},
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), prefix))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start(), false, 'api-key', env)
  try {
    await run(client, model, home)
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const finalAnswer = (client: ProtocolClient, threadId: string): string | undefined =>
  client.trace
    .filter(
      (message) =>
        message.method === 'item/completed' &&
        message.params.threadId === threadId &&
        message.params.item.type === 'agentMessage',
    )
    .at(-1)?.params.item.text

test('NATIVE-EPH-001：改名后起描述：带 gpt 模型的临时分叉沿用源会话的模型，在真实 CLI 上交回结构化的描述', {
  timeout: 120_000,
}, async () => {
  await withClient('native-ephemeral-describe-', async (client, model, home) => {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'never',
      sandbox: 'read-only',
    })
    model.enqueue(() => [{ type: 'text', text: '先拆成三步' }])
    const first = await client.request('turn/start', {
      threadId: thread.id,
      input: text('出个计划'),
    })
    assert.equal((await client.completed(first.turn.id)).status, 'completed')
    const forked = await client.request('thread/fork', {
      threadId: thread.id,
      path: null,
      model: 'gpt-6-luna',
      modelProvider: null,
      serviceTier: null,
      cwd: home,
      approvalPolicy: 'never',
      permissions: ':read-only',
      runtimeWorkspaceRoots: [],
      config: { 'features.hooks': false, web_search: 'disabled', model_reasoning_effort: 'low' },
      ephemeral: true,
      excludeTurns: true,
      threadSource: 'thread_description',
    })
    const describeId: string = forked.thread.id
    assert.equal(forked.thread.ephemeral, true)
    assert.equal(forked.model, 'claude-sonnet-4-6', '沿用源会话的模型')

    model.enqueue((request) => {
      assert.equal(request.model, 'claude-sonnet-4-6', '模型请求用的是源会话的模型')
      assert.match(JSON.stringify(request.messages), /出个计划/, '分叉带着源会话的历史')
      const tool = request.tools.find((entry: any) => entry.name === 'StructuredOutput')
      assert.deepEqual(tool?.input_schema, DESCRIBE_SCHEMA, '输出格式原样交给模型')
      return [
        {
          type: 'tool_use',
          id: 'toolu_describe',
          name: 'StructuredOutput',
          input: { description: '出计划 拆三步' },
        },
      ]
    })
    const described = await client.request('turn/start', {
      threadId: describeId,
      clientUserMessageId: 'describe-1',
      input: text('给这个会话写一句描述'),
      cwd: null,
      approvalPolicy: null,
      permissions: ':read-only',
      runtimeWorkspaceRoots: [],
      model: null,
      effort: null,
      serviceTier: null,
      summary: 'none',
      personality: null,
      collaborationMode: null,
      outputSchema: DESCRIBE_SCHEMA,
    })
    const completed = await client.completed(described.turn.id)
    assert.equal(completed.status, 'completed', JSON.stringify(completed.error))
    // 桌面端拿最后一条回答当 JSON 读
    assert.deepEqual(JSON.parse(finalAnswer(client, describeId) ?? 'null'), {
      description: '出计划 拆三步',
    })
    assert.equal(
      (await client.request('thread/unsubscribe', { threadId: describeId })).status,
      'unsubscribed',
    )
    const listed = (await client.request('thread/list', {})).data.map((entry: any) => entry.id)
    assert.deepEqual(listed, [thread.id], '列表里只有源会话')
  })
})

// CLI 写下的会话记录：<CLAUDE_CONFIG_DIR>/projects/<按目录起的名字>/<会话号>.jsonl
async function transcripts(home: string): Promise<string[]> {
  const root = join(home, 'claude', 'projects')
  const found: string[] = []
  for (const project of await readdir(root).catch(() => [] as string[]))
    for (const name of await readdir(join(root, project)).catch(() => [] as string[]))
      if (name.endsWith('.jsonl')) found.push(name)
  return found.sort()
}

async function unloaded(client: ProtocolClient, threadId: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const reply = await client.raw('thread/read', { threadId })
    if (reply.error) {
      assert.equal(reply.error.message, `thread not found: ${threadId}`)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`临时会话 ${threadId} 一直没卸载`)
}

test('NATIVE-EPH-002：起标题的临时会话、侧聊退订之后卸载，CLI 写下的会话记录一起删掉，源会话的不动', {
  timeout: 120_000,
}, async () => {
  await withClient(
    'native-ephemeral-unload-',
    async (client, model, home) => {
      const { thread } = await client.request('thread/start', {
        cwd: home,
        approvalPolicy: 'never',
        sandbox: 'read-only',
      })
      model.enqueue(() => [{ type: 'text', text: '先拆成三步' }])
      const first = await client.request('turn/start', {
        threadId: thread.id,
        input: text('出个计划'),
      })
      assert.equal((await client.completed(first.turn.id)).status, 'completed')
      const kept = await transcripts(home)
      assert.equal(kept.length, 1, '源会话的记录')

      const { thread: title } = await client.request('thread/start', {
        cwd: home,
        model: 'gpt-6-luna',
        allowProviderModelFallback: true,
        ephemeral: true,
        approvalPolicy: 'never',
        permissions: ':read-only',
      })
      model.enqueue(() => [
        {
          type: 'tool_use',
          id: 'toolu_title',
          name: 'StructuredOutput',
          input: { title: '出个计划' },
        },
      ])
      const titled = await client.request('turn/start', {
        threadId: title.id,
        input: text('给这段对话起个标题'),
        outputSchema: {
          type: 'object',
          properties: { title: { type: 'string' } },
          required: ['title'],
          additionalProperties: false,
        },
      })
      assert.equal((await client.completed(titled.turn.id)).status, 'completed')

      const side = await client.request('thread/fork', {
        threadId: thread.id,
        cwd: home,
        excludeTurns: true,
        ephemeral: true,
      })
      model.enqueue(() => [{ type: 'text', text: '侧聊里答一句' }])
      const said = await client.request('turn/start', {
        threadId: side.thread.id,
        input: text('顺便问一句'),
      })
      assert.equal((await client.completed(said.turn.id)).status, 'completed')
      assert.equal((await transcripts(home)).length, 3, '标题、侧聊各有一份记录')

      await client.request('thread/unsubscribe', { threadId: title.id })
      await client.request('thread/unsubscribe', { threadId: side.thread.id })
      await unloaded(client, title.id)
      await unloaded(client, side.thread.id)
      const deadline = Date.now() + 15_000
      while ((await transcripts(home)).length > 1 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50))
      assert.deepEqual(await transcripts(home), kept, '只剩源会话的记录')
      assert.equal(
        (await client.request('thread/read', { threadId: thread.id })).thread.id,
        thread.id,
      )
    },
    { CHA_CLAUDE_EPHEMERAL_UNLOAD_MS: '0' },
  )
})
