import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deferred } from './fixtures/deferred.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('DIAGNOSTICS-001：真实进程诊断、人工等待中的活动回合及重启后计数，不额外调用模型', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-diagnostics-'))
  const model = new MockLLM()
  const url = await model.start()
  let client = await ProtocolClient.start(home, url)
  const answer = deferred()
  const snapshot = async (active: number): Promise<number> => {
    const result = await client.request('server/diagnostics')
    assert.equal(result.process.id, client.process.pid)
    assert.ok(Number.isSafeInteger(result.process.residentMemoryBytes))
    assert.ok(result.process.residentMemoryBytes > 0)
    assert.equal(result.process.physicalFootprintBytes, null)
    assert.deepEqual(Object.keys(result).sort(), ['gauges', 'process'])
    const gauges = new Map<string, number>(
      result.gauges.map((g: { name: string; value: number }) => [g.name, g.value]),
    )
    assert.equal(gauges.size, result.gauges.length)
    assert.equal(gauges.get('claude_adapter.active_turns'), active)
    assert.equal(gauges.get('claude_adapter.initialized_connections'), 1)
    assert.doesNotMatch(
      JSON.stringify(result),
      /test-not-a-secret|native-diagnostics-|DIAGNOSTIC_PRIVATE_PROMPT/,
    )
    return result.process.id
  }
  try {
    const originalPID = await snapshot(0)
    assert.equal(model.requests.length, 0)
    client.onServerRequest = async (method, params) => {
      assert.equal(method, 'item/tool/requestUserInput')
      await answer.promise
      return { answers: { [params.questions[0].id]: { answers: ['继续'] } } }
    }
    model.enqueue(() => [
      {
        type: 'tool_use',
        id: 'toolu_diagnostics_question',
        name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: '等待诊断完成',
              header: '诊断',
              multiSelect: false,
              options: [
                { label: '继续', description: '完成回合' },
                { label: '停止', description: '结束' },
              ],
            },
          ],
        },
      },
    ])
    model.enqueue(() => [{ type: 'text', text: 'DIAGNOSTICS_COMPLETED' }])
    const { thread } = await client.request('thread/start', { cwd: home })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'DIAGNOSTIC_PRIVATE_PROMPT' }],
    })
    await client.notification('item/tool/requestUserInput')
    assert.equal(await snapshot(1), originalPID)
    assert.equal(await snapshot(1), originalPID)
    assert.equal(model.requests.length, 1, '诊断不能回答问题或重新执行回合')
    answer.resolve()
    assert.equal((await client.completed(turn.id)).status, 'completed')
    assert.equal(await snapshot(0), originalPID)
    assert.equal(model.requests.length, 2)
    await client.close()
    client = await ProtocolClient.start(home, url)
    assert.notEqual(await snapshot(0), originalPID)
    const history = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    assert.equal(history.thread.turns.length, 1)
    assert.equal(history.thread.turns[0].id, turn.id)
    assert.equal(model.requests.length, 2, '重启后的诊断和历史读取不能启动模型')
    model.assertConsumed()
  } finally {
    answer.resolve()
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})
