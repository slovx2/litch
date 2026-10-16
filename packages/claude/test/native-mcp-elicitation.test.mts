import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

for (const mode of ['form', 'url'] as const) {
  for (const action of [
    'accept',
    'decline',
    'cancel',
    ...(mode === 'form' ? (['invalid'] as const) : []),
    ...(mode === 'form' ? (['invalid-meta'] as const) : []),
  ] as const) {
    for (const metadata of action === 'invalid-meta' ? ['invalid'] : ['object', 'null']) {
      test(`MCP-004：真实 SDK stdio elicitation ${mode} ${action} metadata=${metadata} 控制文件副作用`, {
        timeout: 60_000,
      }, async () => {
        const home = await mkdtemp(join(tmpdir(), 'native-elicitation-'))
        const file = join(home, 'effect.txt')
        const model = new MockLLM()
        const client = await ProtocolClient.start(home, await model.start())
        try {
          let callbacks = 0
          let threadId = ''
          client.onServerRequest = async (method, params) => {
            assert.equal(method, 'mcpServer/elicitation/request')
            assert.equal(params.threadId, threadId)
            assert.equal(params.serverName, 'fixture')
            assert.equal(params.mode, mode)
            assert.equal(params.message, mode === 'form' ? 'MCP_FORM_FIXTURE' : 'MCP_URL_FIXTURE')
            if (mode === 'form') assert.deepEqual(params.requestedSchema.required, ['value'])
            else {
              assert.equal(params.url, 'http://127.0.0.1/fixture')
              assert.equal(params.elicitationId, 'fixture-browser-flow')
            }
            callbacks++
            if (action === 'invalid-meta')
              return { action: 'accept', content: { value: 'MUST_NOT_WRITE' }, _meta: 42 }
            if (action === 'invalid')
              return {
                action: 'accept',
                content: { value: 42 },
                _meta: metadata === 'null' ? null : {},
              }
            return {
              action,
              content: action === 'accept' && mode === 'form' ? { value: 'USER_CONFIRMED' } : null,
              _meta: metadata === 'null' ? null : { fixture: 'META_CONFIRMED' },
            }
          }
          model.enqueue((request) => {
            const name = 'mcp__fixture__confirm_fixture'
            assert.ok(request.tools.some((tool: any) => tool.name === name))
            return [{ type: 'tool_use', id: 'toolu_elicitation', name, input: {} }]
          })
          model.enqueue((request) => {
            const results = request.messages
              .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
              .filter((block: any) => block.type === 'tool_result')
            if (action === 'invalid' || action === 'invalid-meta')
              assert.ok(results.some((result: any) => result.is_error === true))
            else {
              assert.match(JSON.stringify(results), new RegExp('MCP_ACTION_' + action))
              if (metadata === 'object') assert.match(JSON.stringify(results), /META_CONFIRMED/)
              else assert.doesNotMatch(JSON.stringify(results), /META_CONFIRMED/)
            }
            return [{ type: 'text', text: 'MCP_INTERACTION_DONE' }]
          })
          const { thread } = await client.request('thread/start', {
            cwd: home,
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
            config: {
              mcp_servers: {
                fixture: {
                  command: process.execPath,
                  args: [resolve('packages/claude/test/fixtures/mcp-interactive-server.mjs')],
                  env: { FIXTURE_EFFECT_PATH: file, FIXTURE_ELICITATION_MODE: mode },
                },
              },
            },
          })
          threadId = thread.id
          const { turn } = await client.request('turn/start', {
            threadId,
            input: [{ type: 'text', text: 'Ask the MCP fixture before writing' }],
          })
          const completed = await client.completed(turn.id)
          assert.equal(completed.status, 'completed', JSON.stringify(completed))
          assert.equal(callbacks, 1, '必须收到真实 SDK 发出的表单请求')
          if (action === 'accept')
            assert.equal(
              await readFile(file, 'utf8'),
              mode === 'form' ? 'USER_CONFIRMED\n' : 'URL_CONFIRMED\n',
            )
          else await assert.rejects(readFile(file), { code: 'ENOENT' })
          const request = client.trace.find(
            (entry) => entry.method === 'mcpServer/elicitation/request',
          )
          assert.equal(request.params.turnId, turn.id)
          const resolved = client.trace.filter(
            (entry) =>
              entry.method === 'serverRequest/resolved' && entry.params.requestId === request.id,
          )
          assert.equal(resolved.length, 1)
          assert.equal(resolved[0].params.threadId, threadId)
          model.assertConsumed()
        } finally {
          await client.close()
          await model.close()
          await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        }
      })
    }
  }
}

test('MCP-004：中断真实 MCP 表单后迟到接受不能产生文件或模型副作用', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-elicitation-cancel-'))
  const file = join(home, 'effect.txt')
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  let entered!: () => void, release!: () => void, answered!: () => void
  const requested = new Promise<void>((resolve) => {
    entered = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const replied = new Promise<void>((resolve) => {
    answered = resolve
  })
  try {
    client.onServerRequest = async (method) => {
      assert.equal(method, 'mcpServer/elicitation/request')
      entered()
      await waiting
      answered()
      return { action: 'accept', content: { value: 'LATE_WRITE' } }
    }
    model.enqueue(() => [
      { type: 'tool_use', id: 'toolu_pending', name: 'mcp__fixture__confirm_fixture', input: {} },
    ])
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      config: {
        mcp_servers: {
          fixture: {
            command: process.execPath,
            args: [resolve('packages/claude/test/fixtures/mcp-interactive-server.mjs')],
            env: { FIXTURE_EFFECT_PATH: file },
          },
        },
      },
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'Cancel before accepting' }],
    })
    await requested
    await client.request('turn/interrupt', { threadId: thread.id, turnId: turn.id })
    assert.equal((await client.completed(turn.id)).status, 'interrupted')
    release()
    await replied
    const history = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    assert.equal(history.thread.turns[0].status, 'interrupted')
    assert.ok(history.thread.turns[0].items.every((item: any) => item.status !== 'inProgress'))
    await assert.rejects(readFile(file), { code: 'ENOENT' })
    assert.equal(client.trace.filter((item) => item.method === 'serverRequest/resolved').length, 1)
    assert.ok(
      client.trace.findIndex((item) => item.method === 'serverRequest/resolved') <
        client.trace.findIndex((item) => item.method === 'turn/completed'),
      '取消请求必须先于回合终态解决',
    )
    assert.equal(model.requests.length, 1)
    model.assertConsumed()
  } finally {
    release()
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
