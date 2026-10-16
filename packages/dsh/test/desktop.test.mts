import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { DshServer } from '../src/server.mjs'
import { client, isolate, violations } from './client.mjs'

// 桌面端生成标题时附带的输出结构：title 1–36 个字符，description 至少 1 个字符。
const TITLE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 36 },
    description: { type: 'string', minLength: 1 },
  },
  required: ['title', 'description'],
  additionalProperties: false,
}

// 复现桌面端新建线程时的调用顺序：真实线程 → 临时线程上的标题回合 → 写回首条消息原文 → 首个回合。
test('dsh：标题用的临时线程不落盘不进列表，标题由 dsh 生成后推给桌面', {
  timeout: 120000,
}, async () => {
  const env = await isolate((body) =>
    body.tools?.length
      ? [{ type: 'text', chunks: ['好的。'] }]
      : [{ type: 'text', chunks: ['模型起的标题'] }],
  )
  const server = new DshServer(join(env.root, 'home'))
  try {
    const desktop = client(server)
    await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const sessions = async (): Promise<any[]> =>
      (await (await server.remote()).rpc('session/list', { _request: {} })).items
    const { thread } = await desktop.call('thread/start', {
      cwd: env.cwd,
      permissions: ':workspace',
    })

    const helper = await desktop.call('thread/start', {
      cwd: env.cwd,
      ephemeral: true,
      model: 'gpt-6-luna',
      allowProviderModelFallback: true,
      approvalPolicy: 'never',
      permissions: ':read-only',
    })
    assert.equal(helper.thread.ephemeral, true, '回包如实带 ephemeral')
    assert.notEqual(helper.thread.id, thread.id)
    assert.equal(helper.permissions, ':read-only')
    const announced = await desktop.until(
      'thread/started',
      (params) => params.thread.id === helper.thread.id,
    )
    assert.equal(announced.thread.ephemeral, true)
    assert.deepEqual(
      (await sessions()).map((item) => item.sessionId),
      [thread.id],
      '临时线程不在 dsh 里建会话',
    )

    const titled = await desktop.call('turn/start', {
      threadId: helper.thread.id,
      turnTrigger: 'thread_title',
      input: [{ type: 'text', text: '为下面的请求起一个标题。\n\nUser prompt:\n帮我看看这个文件' }],
      outputSchema: TITLE_SCHEMA,
    })
    const finished = await desktop.until(
      'turn/completed',
      (params) => params.threadId === helper.thread.id,
    )
    assert.equal(finished.turn.id, titled.turn.id)
    assert.equal(finished.turn.status, 'completed', '结构化回合以空结果正常结束，不报错')
    assert.equal(
      finished.turn.items.some((item: any) => item.type === 'agentMessage'),
      false,
      '没有模型可用时不伪造结果',
    )
    assert.equal(env.model.requests.length, 0, '临时线程的回合不调用模型')
    await assert.rejects(
      desktop.call('turn/start', {
        threadId: helper.thread.id,
        input: [{ type: 'text', text: '普通回合' }],
      }),
      (error: any) => error.code === -32602 && /临时线程/.test(error.message),
    )
    assert.equal(
      (await desktop.call('thread/read', { threadId: helper.thread.id })).thread.ephemeral,
      true,
    )
    assert.equal(
      (await desktop.call('thread/unsubscribe', { threadId: helper.thread.id })).status,
      'unsubscribed',
    )
    assert.equal(
      (await desktop.call('thread/unsubscribe', { threadId: helper.thread.id })).status,
      'notLoaded',
      '无人订阅的临时线程随即卸载',
    )
    await assert.rejects(
      desktop.call('thread/read', { threadId: helper.thread.id }),
      (error: any) =>
        error.code === -32602 &&
        error.message === `thread/read: thread not found: ${helper.thread.id}`,
      '卸载了的临时线程照上游答“没有这个会话”',
    )

    // 标题回合没有结果时桌面端把首条消息原文写回；此时 dsh 还没起过标题，只当临时名，不钉住。
    await desktop.call('thread/name/set', { threadId: thread.id, name: '帮我看看这个文件' })
    assert.equal(
      (await desktop.call('thread/read', { threadId: thread.id })).thread.name,
      '帮我看看这个文件',
    )
    await desktop.call('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '帮我看看这个文件' }],
    })
    await desktop.until('turn/completed', (params) => params.threadId === thread.id)
    await desktop.until(
      'thread/name/updated',
      (params) => params.threadId === thread.id && params.threadName === '模型起的标题',
    )
    assert.equal(
      (await desktop.call('thread/read', { threadId: thread.id })).thread.name,
      '模型起的标题',
    )

    const listed = await desktop.call('thread/list', {})
    assert.deepEqual(
      listed.data.map((entry: any) => [entry.id, entry.name, entry.ephemeral]),
      [[thread.id, '模型起的标题', false]],
      '线程列表里只有真实线程',
    )
    assert.deepEqual(
      (await sessions()).map((item) => item.sessionId),
      [thread.id],
      'dsh 里没有多出会话',
    )

    // dsh 起过标题之后的改名是用户的选择：写进 dsh 并钉住。
    await desktop.call('thread/name/set', { threadId: thread.id, name: '模型起的标题' })
    await desktop.call('thread/name/set', { threadId: thread.id, name: '用户改的名字' })
    await desktop.until(
      'thread/name/updated',
      (params) => params.threadId === thread.id && params.threadName === '用户改的名字',
    )
    assert.equal((await sessions())[0].projections.values.title, '用户改的名字')
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await server.close()
    await env.restore()
  }
})

test('dsh：桌面会调用而 dsh 没有对应能力的方法给出明确应答', { timeout: 60000 }, async () => {
  const env = await isolate([])
  const server = new DshServer(join(env.root, 'home'))
  try {
    const desktop = client(server)
    await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const { thread } = await desktop.call('thread/start', { cwd: env.cwd })

    assert.deepEqual(await desktop.call('thread/goal/get', { threadId: thread.id }), { goal: null })
    await assert.rejects(desktop.call('thread/goal/get', { threadId: 'session-not-exist' }))

    assert.deepEqual(await desktop.call('experimentalFeature/enablement/set', { enablement: {} }), {
      enablement: {},
    })
    await assert.rejects(
      desktop.call('experimentalFeature/enablement/set', { enablement: { apps: true } }),
      (error: any) => error.code === -32004,
      '没有已实现的实验开关，不能回显成已应用',
    )
    await assert.rejects(
      desktop.call('experimentalFeature/enablement/set', { enablement: { apps: 'yes' } }),
      (error: any) => error.code === -32602,
    )

    for (const method of [
      'mcpServerStatus/list',
      'app/installed',
      'plugin/installed',
      'marketplace/add',
    ])
      await assert.rejects(
        desktop.call(method, {}),
        (error: any) => error.code === -32004 && /不适用/.test(error.message),
        `${method} 应明确答复不适用`,
      )
    await assert.rejects(
      desktop.call('no/such/method', {}),
      (error: any) => error.code === -32601,
      '真正未知的方法仍是方法不存在',
    )
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await server.close()
    await env.restore()
  }
})
