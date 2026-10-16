import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { saveArtifact } from './fixtures/artifacts.mjs'
import { deferred } from './fixtures/deferred.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

async function verifyLongWait(mode: 'form' | 'url', interrupt: boolean): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'native-mcp-wait-'))
  const file = join(home, 'effect.txt')
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  const answer = deferred()
  const replied = deferred()
  let requestedAt = 0
  try {
    client.onServerRequest = async (method, params) => {
      assert.equal(method, 'mcpServer/elicitation/request')
      assert.equal(params.mode, mode)
      requestedAt = Date.now()
      await answer.promise
      replied.resolve()
      return {
        action: 'accept',
        content: mode === 'form' ? { value: 'DELAYED_CONFIRMATION' } : null,
      }
    }
    model.enqueue(() => [
      {
        type: 'tool_use',
        id: 'toolu_mcp_wait',
        name: 'mcp__fixture__confirm_fixture',
        input: {},
      },
    ])
    if (!interrupt)
      model.enqueue((request) => {
        const results = request.messages
          .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
          .filter(
            (block: any) => block.type === 'tool_result' && block.tool_use_id === 'toolu_mcp_wait',
          )
        assert.equal(results.length, 1)
        assert.notEqual(results[0].is_error, true)
        assert.match(JSON.stringify(results[0]), /MCP_ACTION_accept/)
        return [{ type: 'text', text: 'DELAYED_MCP_DONE' }]
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
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '等待真实确认，不得提前执行' }],
    })
    await client.notification('mcpServer/elicitation/request')
    await new Promise((resolve) => setTimeout(resolve, 125_000))
    const elapsedMs = Date.now() - requestedAt
    // 要守的是“等过 120 秒”：定时器按事件循环缓存的单调时间算，这里比的是墙上的钟，机器忙时
    // 事件循环卡过一阵，定时器就比 Date.now() 算的早几十毫秒到点。多睡的 5 秒是给这个留的余量
    assert.ok(requestedAt > 0 && elapsedMs >= 120_000, `只等了 ${elapsedMs} ms`)
    assert.equal(
      client.trace.filter((event) => event.method === 'serverRequest/resolved').length,
      0,
    )
    assert.equal(client.trace.filter((event) => event.method === 'turn/completed').length, 0)
    assert.equal(model.requests.length, 1)
    await assert.rejects(readFile(file), { code: 'ENOENT' })
    if (interrupt) {
      await client.request('turn/interrupt', { threadId: thread.id, turnId: turn.id })
      assert.equal((await client.completed(turn.id)).status, 'interrupted')
    }
    answer.resolve()
    await replied.promise
    const completed = await client.completed(turn.id)
    assert.equal(completed.status, interrupt ? 'interrupted' : 'completed')
    const history = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    assert.ok(history.thread.turns[0].items.every((item: any) => item.status !== 'inProgress'))
    const resolved = client.trace.filter((event) => event.method === 'serverRequest/resolved')
    const terminal = client.trace.filter((event) => event.method === 'turn/completed')
    assert.equal(resolved.length, 1)
    assert.equal(terminal.length, 1)
    assert.ok(client.trace.indexOf(resolved[0]) < client.trace.indexOf(terminal[0]))
    if (interrupt) await assert.rejects(readFile(file), { code: 'ENOENT' })
    else
      assert.equal(
        await readFile(file, 'utf8'),
        mode === 'form' ? 'DELAYED_CONFIRMATION\n' : 'URL_CONFIRMED\n',
      )
    assert.equal(model.requests.length, interrupt ? 1 : 2)
    model.assertConsumed()
    await saveArtifact('native-mcp-long-wait', {
      mode,
      interrupt,
      elapsedMs,
      threadId: thread.id,
      turnId: turn.id,
      status: completed.status,
      modelRequests: model.requests.length,
      resolved: resolved.length,
      terminal: terminal.length,
    })
  } finally {
    answer.resolve()
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

test('MCP-004 / APPROVAL-007 / EVENTS-006：真实 MCP 表单与 URL 等待超过120秒可接受，中断后迟到接受无副作用', {
  timeout: 210_000,
}, async () => {
  const results = await Promise.allSettled([
    verifyLongWait('form', false),
    verifyLongWait('url', false),
    verifyLongWait('form', true),
  ])
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  )
  if (failures.length) throw new AggregateError(failures, '真实 MCP 长等待验收失败')
})
