import assert from 'node:assert/strict'
import test from 'node:test'
import { client, isolate, skip, text, violations } from './client.mjs'
import { scripted } from './mock-model.mjs'

// OpenCode 的提问工具（question）转成 item/tool/requestUserInput，一次几道题；
// 回合打断时挂着的审批和提问由适配器收拾：撤回请求、发 serverRequest/resolved，OpenCode 那边也拒掉。
test('OpenCode：提问（多道题、选项加自由回答）转给用户，答案交回模型', {
  skip,
  timeout: 120000,
}, async () => {
  const env = await isolate(
    scripted({
      ASK: [
        [
          {
            type: 'tool',
            name: 'question',
            input: {
              questions: [
                {
                  question: '用哪种颜色？',
                  header: '颜色',
                  options: [
                    { label: '红', description: '暖色' },
                    { label: '蓝', description: '冷色' },
                  ],
                },
                { question: '叫什么名字？', header: '名字', options: [] },
              ],
            },
          },
        ],
        [{ type: 'text', chunks: ['谢谢回答。'] }],
      ],
    }),
  )
  try {
    const desktop = client(env.server)
    await desktop.initialize()
    desktop.onRequest(() => undefined)
    const { thread } = await desktop.call('thread/start', { cwd: env.cwd })
    const { turn } = await desktop.call('turn/start', {
      threadId: thread.id,
      input: text('ASK 问我'),
    })
    // 有选项的题和没选项的题分两张卡问（见 questions.mts 的 cards），一张答完才问下一张
    const reply = (request: any, answer: string) => ({
      answers: { [request.params.questions[0].id]: { answers: [answer] } },
    })
    const first = await desktop.request('item/tool/requestUserInput')
    assert.deepEqual(
      first.params.questions.map((q: any) => [
        q.header,
        q.question,
        q.isOther,
        q.options.map((o: any) => o.label),
      ]),
      [['颜色', '用哪种颜色？', true, ['红', '蓝']]],
    )
    await desktop.respond(first, reply(first, '蓝'))
    for (let waited = 0; waited < 20000 && desktop.requests.length < 2; waited += 20)
      await new Promise((resolve) => setTimeout(resolve, 20))
    const second = desktop.requests[1]
    assert.equal(second.method, 'item/tool/requestUserInput')
    assert.equal(second.params.itemId, first.params.itemId)
    assert.deepEqual(
      second.params.questions.map((q: any) => [q.header, q.isOther, q.options]),
      [['名字', true, null]],
    )
    await desktop.respond(second, reply(second, '小明'))
    const done = (await desktop.until('turn/completed', (p) => p.turn.id === turn.id)).turn
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    const call = done.items.find((item: any) => item.type === 'dynamicToolCall')
    assert.equal(call.status, 'completed')
    assert.equal(call.tool, 'question')
    const result = JSON.stringify(env.model.requests.at(-1).messages)
    assert.ok(result.includes('蓝') && result.includes('小明'), '答案交回了模型')
    assert.equal(done.items.at(-1).text, '谢谢回答。')
    assert.ok(desktop.of('serverRequest/resolved', thread.id).length >= 1)
  } finally {
    await env.restore()
  }
  assert.deepEqual([...violations], [])
})

test('OpenCode：打断时挂着的审批被撤回（serverRequest/resolved），回合以 interrupted 收场', {
  skip,
  timeout: 120000,
}, async () => {
  const env = await isolate(
    scripted({
      RUN: [
        [{ type: 'tool', name: 'bash', input: { command: 'printf hi', description: '要审批' } }],
      ],
      AFTER: [[{ type: 'text', chunks: ['接着来。'] }]],
    }),
    { permission: { bash: 'ask' } },
  )
  try {
    const desktop = client(env.server)
    await desktop.initialize()
    desktop.onRequest(() => undefined)
    const { thread } = await desktop.call('thread/start', { cwd: env.cwd })
    const { turn } = await desktop.call('turn/start', {
      threadId: thread.id,
      input: text('RUN 跑'),
    })
    const approval = await desktop.request('item/commandExecution/requestApproval')
    assert.deepEqual(approval.params.availableDecisions, [
      'accept',
      'acceptForSession',
      'decline',
      'cancel',
    ])
    await desktop.call('turn/interrupt', { threadId: thread.id, turnId: turn.id })
    const stopped = (await desktop.until('turn/completed', (p) => p.turn.id === turn.id)).turn
    assert.equal(stopped.status, 'interrupted')
    const resolved = desktop.of('serverRequest/resolved', thread.id)
    assert.deepEqual(
      resolved.map((p) => p.requestId),
      [approval.id],
    )
    const command = stopped.items.find((item: any) => item.type === 'commandExecution')
    assert.notEqual(command?.status, 'inProgress')
    // 之后照常能发下一轮，OpenCode 那边没有挂着的权限请求
    const next = await desktop.call('turn/start', {
      threadId: thread.id,
      input: text('AFTER 继续'),
    })
    const done = (await desktop.until('turn/completed', (p) => p.turn.id === next.turn.id)).turn
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(desktop.requests.length, 1)
  } finally {
    await env.restore()
  }
  assert.deepEqual([...violations], [])
})
