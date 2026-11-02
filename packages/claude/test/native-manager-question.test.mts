import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MANAGER_TOOLS } from '../../protocol/src/client-tools-manager.mjs'
import { SESSION_TOOLS } from '../../protocol/src/client-tools-sessions.mjs'
import { managerQuestionTools } from '../../protocol/src/manager-question.mjs'
import { DYNAMIC_TOOL_SERVER, dynamicToolName } from '../src/dynamic-tools.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('真实 Claude 临时分叉：list/read 和 Git run 到执行器，Bash 在 PreToolUse 拒绝', {
  timeout: 100_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'question-cli-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(
    home,
    await model.start(),
    false,
    'api-key',
    {},
    {
      litchExtensions: ['clientTools'],
      litchClientTools: { namespaces: ['litch_sessions', 'litch_manager', 'litch_repository'] },
    },
  )
  try {
    const calls: string[] = []
    client.onServerRequest = async (method, params) => {
      assert.equal(method, 'item/tool/call', '旁问不请求权限')
      calls.push(`${params.namespace}.${params.tool}`)
      return { success: true, contentItems: [{ type: 'inputText', text: 'authorized snapshot' }] }
    }
    const { thread } = await client.request('thread/start', {
      cwd: home,
      dynamicTools: [MANAGER_TOOLS, SESSION_TOOLS],
      approvalPolicy: 'never',
      sandbox: 'read-only',
    })
    model.enqueue(() => [{ type: 'text', text: '经理原始背景' }])
    const first = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '背景' }],
    })
    await client.completed(first.turn.id)
    const { thread: fork } = await client.request('thread/fork', {
      threadId: thread.id,
      ephemeral: true,
      dynamicTools: managerQuestionTools('D-1', thread.id),
      approvalPolicy: 'never',
      sandbox: 'read-only',
    })
    const name = (tool: string) =>
      `mcp__${DYNAMIC_TOOL_SERVER}__${dynamicToolName('litch_sessions', tool)}`
    const call = (tool: string, input: unknown) => [
      { type: 'tool_use' as const, id: `toolu_${tool}`, name: name(tool), input },
    ]
    model.enqueue((request) => {
      assert.ok(request.tools.some((tool: { name: string }) => tool.name === name('list')))
      assert.ok(request.tools.some((tool: { name: string }) => tool.name === name('read')))
      assert.ok(!request.tools.some((tool: { name: string }) => tool.name === name('start')))
      return call('list', {})
    })
    model.enqueue((request) => {
      assert.match(JSON.stringify(request.messages.at(-1)), /authorized snapshot/)
      return call('read', { thread_id: thread.id })
    })
    model.enqueue((request) => {
      assert.match(JSON.stringify(request.messages.at(-1)), /authorized snapshot/)
      return [
        {
          type: 'tool_use',
          id: 'toolu_git',
          name: `mcp__${DYNAMIC_TOOL_SERVER}__${dynamicToolName('litch_repository', 'run')}`,
          input: { directory: home, argv: ['status'] },
        },
      ]
    })
    model.enqueue((request) => {
      assert.match(JSON.stringify(request.messages.at(-1)), /authorized snapshot/)
      return [
        {
          type: 'tool_use',
          id: 'toolu_bash',
          name: 'Bash',
          input: { command: 'echo must-not-run' },
        },
      ]
    })
    model.enqueue((request) => {
      assert.match(JSON.stringify(request.messages.at(-1)), /只允许/)
      return [
        {
          type: 'tool_use',
          id: 'toolu_raw',
          name: 'Read',
          input: { file_path: join(home, 'claude', 'private.jsonl') },
        },
      ]
    })
    model.enqueue((request) => {
      assert.match(JSON.stringify(request.messages.at(-1)), /会话存储/)
      assert.doesNotMatch(JSON.stringify(request.messages.at(-1)), /private-session-secret/)
      return [{ type: 'text', text: '背景已核对' }]
    })
    await writeFile(join(home, 'claude', 'private.jsonl'), 'private-session-secret')
    const { turn } = await client.request('turn/start', {
      threadId: fork.id,
      input: [{ type: 'text', text: '查经理和工作线背景' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    assert.deepEqual(calls, ['litch_sessions.list', 'litch_sessions.read', 'litch_repository.run'])
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})
