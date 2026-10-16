import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { cliOutputSchema } from '../src/cli-output-schema.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

const DRAFT_2020 = 'https://json-schema.org/draft/2020-12/schema'

async function withClient(
  prefix: string,
  run: (client: ProtocolClient, model: MockLLM, threadId: string) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), prefix))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
    })
    await run(client, model, thread.id)
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const structuredTool = (request: any) =>
  request.tools.find((entry: any) => entry.name === 'StructuredOutput')

async function answerOf(client: ProtocolClient, threadId: string): Promise<unknown> {
  const history = await client.request('thread/read', { threadId, includeTurns: true })
  const answer = history.thread.turns.at(-1).items.find((item: any) => item.type === 'agentMessage')
  return JSON.parse(answer.text)
}

// 桌面给每个新线程起标题时带的就是这种声明了 2020-12 的输出格式。
test('OUTPUT-SCHEMA-001：声明 2020-12 的输出格式能在真实 CLI 上跑完', {
  timeout: 60_000,
}, async () => {
  await withClient('native-output-schema-title-', async (client, model, threadId) => {
    const constraints = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    }
    model.enqueue((request) => {
      assert.deepEqual(structuredTool(request).input_schema, constraints, '约束原样交给模型')
      return [
        {
          type: 'tool_use',
          id: 'toolu_title',
          name: 'StructuredOutput',
          input: { title: '起好了' },
        },
      ]
    })
    const { turn } = await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: '给这段对话起个标题' }],
      outputSchema: { $schema: DRAFT_2020, ...constraints },
    })
    const completed = await client.completed(turn.id)
    assert.equal(completed.status, 'completed', JSON.stringify(completed.error))
    assert.deepEqual(await answerOf(client, threadId), { title: '起好了' })
  })
})

test('OUTPUT-SCHEMA-002：2020-12 的元组与依赖约束换成等价写法后仍由 CLI 强制', {
  timeout: 60_000,
}, async () => {
  await withClient('native-output-schema-tuple-', async (client, model, threadId) => {
    const outputSchema = {
      $schema: DRAFT_2020,
      type: 'object',
      properties: {
        pair: {
          type: 'array',
          prefixItems: [{ type: 'string' }, { type: 'integer' }],
          items: false,
        },
        unit: { type: 'string' },
      },
      required: ['pair'],
      dependentRequired: { unit: ['pair'] },
      dependentSchemas: { unit: { properties: { pair: { minItems: 2 } } } },
      additionalProperties: false,
    }
    // 第一次多给一个元素，违反 items: false；约束若被丢掉，这个结果会直接被接受。
    model.enqueue(() => [
      {
        type: 'tool_use',
        id: 'toolu_tuple_bad',
        name: 'StructuredOutput',
        input: { pair: ['a', 1, 'extra'] },
      },
    ])
    // 第二次带上 unit 却只给一个元素，违反 dependentSchemas。
    model.enqueue((request) => {
      assert.match(JSON.stringify(request.messages.at(-1)), /does not match required schema/)
      return [
        {
          type: 'tool_use',
          id: 'toolu_tuple_dependent',
          name: 'StructuredOutput',
          input: { pair: ['a'], unit: 'kg' },
        },
      ]
    })
    model.enqueue((request) => {
      assert.match(JSON.stringify(request.messages.at(-1)), /does not match required schema/)
      return [
        {
          type: 'tool_use',
          id: 'toolu_tuple_good',
          name: 'StructuredOutput',
          input: { pair: ['a', 1], unit: 'kg' },
        },
      ]
    })
    const { turn } = await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: '返回一对值' }],
      outputSchema,
    })
    const completed = await client.completed(turn.id)
    assert.equal(completed.status, 'completed', JSON.stringify(completed.error))
    assert.deepEqual(await answerOf(client, threadId), { pair: ['a', 1], unit: 'kg' })
  })
})

test('OUTPUT-SCHEMA-003：没有等价写法的关键字给出明确错误，不让 CLI 启动后以 1 退出', {
  timeout: 60_000,
}, async () => {
  await withClient('native-output-schema-reject-', async (client, model, threadId) => {
    const { turn } = await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: '返回任意对象' }],
      outputSchema: {
        $schema: DRAFT_2020,
        type: 'object',
        allOf: [{ properties: { title: { type: 'string' } } }],
        unevaluatedProperties: false,
      },
    })
    const completed = await client.completed(turn.id)
    assert.equal(completed.status, 'failed')
    assert.match(completed.error.message, /unevaluatedProperties/)
    assert.doesNotMatch(completed.error.message, /exited with code/)
    assert.equal(model.requests.length, 0, '不应发出模型请求')
  })
})

test('OUTPUT-SCHEMA-004：未声明草案或声明 draft-07 的模式原样交给 CLI', () => {
  const constraints = {
    type: 'object',
    properties: { tags: { type: 'array', items: [{ type: 'string' }], additionalItems: false } },
    dependencies: { tags: ['title'] },
  }
  assert.equal(cliOutputSchema(constraints), constraints)
  const declared = { $schema: 'http://json-schema.org/draft-07/schema#', ...constraints }
  assert.equal(cliOutputSchema(declared), declared)
})

test('OUTPUT-SCHEMA-005：换成等价写法时不改约束，也不动不是模式的值', () => {
  const converted = cliOutputSchema({
    $schema: 'https://json-schema.org/draft/2019-09/schema',
    type: 'object',
    properties: {
      // 名字恰好叫 prefixItems 的属性、枚举和默认值里的同名字段都不是关键字。
      prefixItems: { enum: [{ dependentRequired: 1 }], default: { items: false } },
      nested: {
        $ref: '#/$defs/point',
      },
    },
    $defs: { point: { type: 'object', dependentRequired: { x: ['y'] } } },
    dependencies: { a: ['b'] },
    dependentRequired: { a: ['c'] },
    dependentSchemas: { a: { minProperties: 2 } },
  })
  assert.deepEqual(converted, {
    type: 'object',
    properties: {
      prefixItems: { enum: [{ dependentRequired: 1 }], default: { items: false } },
      nested: { $ref: '#/$defs/point' },
    },
    $defs: { point: { type: 'object', dependencies: { x: ['y'] } } },
    dependencies: {
      a: { allOf: [{ required: ['b'] }, { required: ['c'] }, { minProperties: 2 }] },
    },
  })
})

test('OUTPUT-SCHEMA-006：交不了的模式逐类给出原因', () => {
  const draft2020 = (extra: Record<string, unknown>) => ({ $schema: DRAFT_2020, ...extra })
  assert.throws(() => cliOutputSchema('title'), /必须是 JSON 对象/)
  assert.throws(
    () => cliOutputSchema({ $schema: 'http://json-schema.org/draft-04/schema#', type: 'object' }),
    /不支持的 \$schema/,
  )
  assert.throws(() => cliOutputSchema({ type: 'object', $async: true }), /\$async/)
  assert.throws(() => cliOutputSchema(draft2020({ type: 'objekt' })), /不是合法的 JSON Schema/)
  // 2019-09 起才有、draft-07 无法表达的约束。
  for (const [keyword, value] of [
    ['unevaluatedItems', false],
    ['maxContains', 2],
    ['minContains', 2],
  ] as const)
    assert.throws(
      () => cliOutputSchema(draft2020({ type: 'array', contains: {}, [keyword]: value })),
      new RegExp(`不接受这个 outputSchema.*${keyword}`),
    )
  // 没声明草案时按 draft-07 处理，新草案的关键字同样不能悄悄丢掉。
  assert.throws(
    () => cliOutputSchema({ type: 'object', dependentRequired: { a: ['b'] } }),
    /不接受这个 outputSchema.*dependentRequired/,
  )
  assert.throws(
    () => cliOutputSchema(draft2020({ type: 'array', additionalItems: false })),
    /additionalItems/,
  )
  assert.throws(
    () => cliOutputSchema(draft2020({ properties: { a: draft2020({ type: 'string' }) } })),
    /另行声明了 \$schema/,
  )
})
