import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { JobRoster } from '../src/background.mjs'
import { DshServer } from '../src/server.mjs'
import { client, isolate, violations } from './client.mjs'
import { scripted } from './mock-model.mjs'

// dsh 的后台作业（backgroundTasks 扩展，决 434）：job/list 的名单进集合，后台作业结束后 dsh 叫醒会话开的那一轮
// 记来历 backgroundTask。只给声明了扩展的连接

test('BG-DSH-001 名单：只算自己名下的，子代理不算，状态照搬，消失的记 stopped', () => {
  let clock = 100
  const roster = new JobRoster(() => clock)
  const job = (id: string, more: Record<string, unknown>) => ({
    id,
    kind: 'bash',
    label: `cmd ${id}`,
    owner: 's1',
    status: 'running',
    startedAt: 10,
    output: { total: 0, earliest: 0 },
    ...more,
  })
  assert.equal(
    roster.rows(
      [
        job('j1', {}),
        job('j2', { owner: 's2' }),
        job('j3', { owner: undefined }),
        job('j4', { kind: 'subagent' }),
        job('j5', { kind: 'workflow', status: 'stopping' }),
      ],
      's1',
    ),
    true,
  )
  assert.deepEqual(
    roster.list().map((task) => [task.id, task.kind, task.status]),
    [
      ['j1', 'shell', 'running'],
      ['j5', 'workflow', 'running'],
    ],
  )
  // 同一份名单再来一帧：没变
  assert.equal(
    roster.rows([job('j1', {}), job('j5', { kind: 'workflow', status: 'stopping' })], 's1'),
    false,
  )
  clock = 200
  roster.rows([job('j1', { status: 'killed', finishedAt: 150 })], 's1')
  assert.deepEqual(
    roster.list().map((task) => [task.id, task.status, task.endedAt]),
    [
      ['j5', 'stopped', 200],
      ['j1', 'stopped', 150],
    ],
  )
})

const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }]
const respond = scripted({
  BGJOB: [
    [
      {
        type: 'tool_use',
        name: 'bash',
        input: {
          command: 'sleep 2; echo bg-done',
          description: '后台命令',
          run_in_background: true,
        },
      },
    ],
    [{ type: 'text', chunks: ['在后台跑着。'] }],
  ],
})

test('BG-DSH-002 后台 shell：集合发给声明了的连接，结束后自动开的那一轮带 litchOrigin', {
  timeout: 300000,
}, async () => {
  const env = await isolate((body) =>
    body.tools?.length ? respond(body) : [{ type: 'text', chunks: ['mock 标题'] }],
  )
  const server = new DshServer(join(env.root, 'home'))
  try {
    const declared = client(server)
    await declared.call('initialize', {
      clientInfo: { name: 'test', version: '0' },
      capabilities: { litchExtensions: ['backgroundTasks'] },
    })
    const plain = client(server)
    await plain.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const threadId = (
      await declared.call('thread/start', {
        cwd: env.cwd,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      })
    ).thread.id
    await plain.call('thread/resume', { threadId })
    const { turn } = await declared.call('turn/start', {
      threadId,
      input: text('BGJOB 后台跑一条'),
    })
    await declared.until('turn/completed', (params) => params.turn.id === turn.id)
    const running = await declared.until(
      'litch/thread/background/changed',
      (params) =>
        params.threadId === threadId && params.tasks.some((task: any) => task.status === 'running'),
    )
    assert.equal(running.wakesOnFinish, true)
    assert.equal(running.tasks[0].kind, 'shell')
    assert.match(running.tasks[0].title, /sleep 2/)
    const read = await declared.call('thread/read', { threadId, includeTurns: true })
    assert.equal(read.thread.litchBackground.tasks[0].id, running.tasks[0].id)
    // 结束：记成完成，dsh 自己开的那一轮带来历
    await declared.until(
      'litch/thread/background/changed',
      (params) => params.threadId === threadId && params.tasks[0]?.status === 'completed',
    )
    const woke = await declared.until(
      'turn/completed',
      (params) => params.threadId === threadId && params.turn.id !== turn.id,
    )
    assert.equal(woke.turn.litchOrigin, 'backgroundTask')
    const history = await declared.call('thread/read', { threadId, includeTurns: true })
    assert.equal(history.thread.turns.at(-1).litchOrigin, 'backgroundTask')
    assert.equal(history.thread.turns[0].litchOrigin, undefined)
    const page = await declared.call('thread/turns/list', { threadId })
    assert.ok(page.data.some((one: any) => one.litchOrigin === 'backgroundTask'))
    // 没声明的连接：只有标准的东西
    assert.equal(plain.notifications.filter((entry) => entry.method.startsWith('litch/')).length, 0)
    for (const entry of plain.notifications)
      if (entry.method === 'turn/completed') assert.equal(entry.params.turn.litchOrigin, undefined)
    const plainRead = await plain.call('thread/read', { threadId, includeTurns: true })
    assert.equal(plainRead.thread.litchBackground, undefined)
    assert.ok(plainRead.thread.turns.every((one: any) => one.litchOrigin === undefined))
    assert.deepEqual(
      [...violations].filter((line) => !line.includes('litch')),
      [],
    )
  } finally {
    await server.close()
    await env.restore()
  }
})
