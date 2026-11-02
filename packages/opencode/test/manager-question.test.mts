import assert from 'node:assert/strict'
import test from 'node:test'
import { managerQuestionTools } from '../../protocol/src/manager-question.mjs'
import { serverName } from '../src/client-tools.mjs'
import { client, isolate, skip, text, violations } from './client.mjs'
import { scripted } from './mock-model.mjs'

test('旁问轻会话可连续回答，工具全拒绝后仅开放读文件和看板，不进列表且退订删除', {
  skip,
  timeout: 120000,
}, async () => {
  let toolPrefix = ''
  const env = await isolate(
    scripted({
      FIRST: [
        [
          {
            type: 'tool',
            get name() {
              return `${toolPrefix}_sessions_list`
            },
            input: {},
          },
        ],
        [{ type: 'text', chunks: ['第一轮背景'] }],
      ],
      SECOND: [
        [
          {
            type: 'tool',
            get name() {
              return `${toolPrefix}_sessions_read`
            },
            input: { thread_id: 'manager' },
          },
        ],
        [{ type: 'text', chunks: ['第二轮背景'] }],
      ],
      GIT: [
        [
          {
            type: 'tool',
            get name() {
              return `${toolPrefix}_repository_status`
            },
            input: { directory: '/work' },
          },
        ],
        [{ type: 'text', chunks: ['Git 背景'] }],
      ],
    }),
    { server: { backgroundShell: true } },
  )
  try {
    const connection = client(env.server, ['clientTools'])
    const observer = client(env.server)
    await connection.initialize()
    await observer.initialize()
    const calls: string[] = []
    connection.onRequest((request) => {
      if (request.method !== 'item/tool/call') return undefined
      calls.push(`${request.params.namespace}.${request.params.tool}`)
      return { success: true, contentItems: [{ type: 'inputText', text: 'authorized snapshot' }] }
    })
    // 执行器声明；真实设备层的范围拒绝由 manager-question-reads 用例覆盖。
    await connection.call('initialize', {
      clientInfo: { name: 'question', version: '0' },
      capabilities: {
        litchExtensions: ['clientTools'],
        litchClientTools: { namespaces: ['litch_sessions', 'litch_repository'] },
      },
    })
    const { thread } = await connection.call('thread/start', {
      cwd: env.cwd,
      ephemeral: true,
      sandbox: 'read-only',
      dynamicTools: managerQuestionTools('D-1', 'manager'),
    })
    toolPrefix = serverName(thread.id)
    assert.equal(thread.ephemeral, true)
    const rules = env.server.clientTools.rules(thread.id)
    assert.equal(rules['*'], false)
    assert.equal(rules[`${serverName(thread.id)}_manager_summary`], true)
    assert.equal(rules[`${serverName(thread.id)}_manager_get`], true)
    assert.equal(rules[`${serverName(thread.id)}_sessions_list`], true)
    assert.equal(rules[`${serverName(thread.id)}_sessions_read`], true)
    assert.equal(
      Object.keys(rules).some((key) => /shell|bash|write/.test(key)),
      false,
    )
    for (const prompt of ['FIRST 背景', 'SECOND 追问', 'GIT 查询']) {
      const { turn } = await connection.call('turn/start', {
        threadId: thread.id,
        input: text(prompt),
      })
      assert.equal(
        (await connection.until('turn/completed', (p) => p.turn.id === turn.id, 60000)).turn.status,
        'completed',
      )
    }
    const names = env.model.requests.flatMap(
      (body) => body.tools?.map((tool: any) => tool.function?.name ?? tool.name) ?? [],
    )
    assert.deepEqual(calls, [
      'litch_sessions.list',
      'litch_sessions.read',
      'litch_repository.status',
    ])
    assert.ok(
      env.model.requests.some((body) =>
        JSON.stringify(body.messages).includes('authorized snapshot'),
      ),
    )
    assert.equal(
      names.some((name) => ['bash', 'edit', 'write', 'task', 'webfetch'].includes(name)),
      false,
    )
    assert.ok(
      env.model.requests.some((body) => JSON.stringify(body.messages).includes('第一轮背景')),
    )
    assert.equal(
      (await connection.call('thread/list', {})).data.some(
        (row: { id: string }) => row.id === thread.id,
      ),
      false,
    )
    assert.equal(observer.of('thread/started', thread.id).length, 0)
    await connection.call('thread/unsubscribe', { threadId: thread.id })
    assert.equal(env.server.live.has(thread.id), false)
    assert.equal(violations.size, 0, [...violations].join('\n'))
  } finally {
    await env.restore()
  }
})
