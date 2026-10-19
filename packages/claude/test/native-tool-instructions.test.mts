import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 命名空间带的 instructions 在真实 CLI 上确实到了模型的系统提示里：在用户的开发者指令之后、只有一份；
// CLI 进程不留（每个回合重起、按会话号恢复）、分叉出来的会话也一样。

const USER = 'USER-DEVELOPER-INSTRUCTIONS-NATIVE'
const RULES = 'RULES-FOR-SESSIONS-NATIVE: propose cards for follow-up work.'
const TOOLS = [
  {
    type: 'namespace',
    name: 'litch_echo',
    description: 'Litch 测试工具',
    instructions: RULES,
    tools: [
      {
        type: 'function',
        name: 'echo',
        description: '原样回参数',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
      },
    ],
  },
]

const count = (text: string, needle: string) => text.split(needle).length - 1

test('TOOL-INSTRUCTIONS-CC-001：真实 CLI 的系统提示里有规则和用户指令，恢复、分叉之后也只有一份', {
  timeout: 150_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-tool-instructions-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start(), false, 'api-key', {
    CHA_CLAUDE_KEEP_ALIVE_SESSIONS: '0',
  })
  try {
    const systems: string[] = []
    const answer = (text: string) => (request: any) => {
      systems.push(JSON.stringify(request.system ?? ''))
      return [{ type: 'text', text }]
    }
    const run = async (threadId: string, text: string) => {
      const { turn } = await client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
    }
    const { thread } = await client.request('thread/start', {
      cwd: home,
      developerInstructions: USER,
      dynamicTools: TOOLS,
    })
    model.enqueue(answer('ONE'))
    await run(thread.id, '第一句')
    model.enqueue(answer('TWO'))
    await run(thread.id, '第二句')
    const { thread: fork } = await client.request('thread/fork', { threadId: thread.id })
    model.enqueue(answer('THREE'))
    await run(fork.id, '分叉之后')
    model.assertConsumed()

    assert.equal(systems.length, 3)
    for (const system of systems) {
      assert.equal(count(system, RULES), 1, system)
      assert.equal(count(system, USER), 1, system)
      assert.ok(system.indexOf(USER) < system.indexOf(RULES), '规则在用户指令之后')
    }
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
