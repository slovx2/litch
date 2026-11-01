import assert from 'node:assert/strict'
import test from 'node:test'
import { MANAGER_TOOLS } from '../../protocol/src/client-tools-manager.mjs'
import { managerQuestionRules } from '../../protocol/src/manager-question.mjs'
import { serverName } from '../src/client-tools.mjs'
import { client, isolate, skip, text, violations } from './client.mjs'
import { scripted } from './mock-model.mjs'

test('旁问轻会话可连续回答，工具全拒绝后仅开放读文件和看板，不进列表且退订删除', {
  skip,
  timeout: 120000,
}, async () => {
  const env = await isolate(
    scripted({
      FIRST: [[{ type: 'text', chunks: ['第一轮背景'] }]],
      SECOND: [[{ type: 'text', chunks: ['第二轮背景'] }]],
    }),
    { server: { backgroundShell: true } },
  )
  try {
    const connection = client(env.server, ['clientTools'])
    const observer = client(env.server)
    await connection.initialize()
    await observer.initialize()
    const { thread } = await connection.call('thread/start', {
      cwd: env.cwd,
      ephemeral: true,
      sandbox: 'read-only',
      dynamicTools: [
        {
          ...MANAGER_TOOLS,
          instructions: managerQuestionRules('D-1'),
          tools: MANAGER_TOOLS.tools.filter((tool) => ['summary', 'get'].includes(tool.name)),
        },
      ],
    })
    assert.equal(thread.ephemeral, true)
    const rules = env.server.clientTools.rules(thread.id)
    assert.equal(rules['*'], false)
    assert.equal(rules[`${serverName(thread.id)}_manager_summary`], true)
    assert.equal(rules[`${serverName(thread.id)}_manager_get`], true)
    assert.equal(
      Object.keys(rules).some((key) => /shell|bash|write/.test(key)),
      false,
    )
    for (const prompt of ['FIRST 背景', 'SECOND 追问']) {
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
