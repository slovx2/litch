import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM, type ModelRequest } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 真实 CLI 跑的命令里有 LITCH_THREAD_ID，值就是这个入口的会话号（native-runtime.mts 的 buildOptions）：
// 命令里调 litch-machine 时，它按这个把确认卡片放进这个会话。

const toolResult = (request: ModelRequest, id: string): any =>
  (request.messages ?? [])
    .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
    .find((block: any) => block.type === 'tool_result' && block.tool_use_id === id)

test('THREAD-ENV-001：Bash 工具的命令里 LITCH_THREAD_ID 是这个会话的号', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-thread-env-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start(), false, 'api-key')
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      permissions: ':workspace',
    })
    client.onServerRequest = async () => ({ decision: 'accept' })
    let result: any
    model.enqueue(() => [
      {
        type: 'tool_use',
        id: 'toolu_env',
        name: 'Bash',
        input: { command: 'printf "[%s]" "$LITCH_THREAD_ID"', description: 'print the thread' },
      },
    ])
    model.enqueue((request) => {
      result = toolResult(request, 'toolu_env')
      return [{ type: 'text', text: '好了' }]
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '打印会话号' }],
    })
    await client.completed(turn.id)
    model.assertConsumed()
    assert.match(JSON.stringify(result?.content ?? result), new RegExp(`\\[${thread.id}\\]`))
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})
