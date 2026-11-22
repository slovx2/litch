import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import {
  IDLE_COMPACT_READ,
  MANAGER_IDLE_COMPACT_EXTENSION,
} from '../../protocol/src/manager-idle-compact.mjs'
import { DYNAMIC_TOOL_SERVER, dynamicToolName } from '../src/dynamic-tools.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('空闲压缩通过原生边界，下一轮模型请求仍带经理说明和外部工具', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-idle-compact-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(
    home,
    await model.start(),
    false,
    'api-key',
    { CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS: '0', CHA_CLAUDE_TOOL_LOADING: 'off' },
    {
      litchExtensions: ['clientTools', MANAGER_IDLE_COMPACT_EXTENSION],
      litchClientTools: { namespaces: ['litch_manager'] },
    },
  )
  try {
    let calls = 0
    const tool = `mcp__${DYNAMIC_TOOL_SERVER}__${dynamicToolName('litch_manager', 'external_read')}`
    client.onServerRequest = async (method, params) => {
      assert.equal(method, 'item/tool/call')
      assert.equal(params.namespace, 'litch_manager')
      assert.equal(params.tool, 'external_read')
      calls++
      return {
        success: true,
        contentItems: [{ type: 'inputText', text: 'fixture external result' }],
      }
    }
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'never',
      developerInstructions: 'FIXED_MANAGER_DEVELOPER_RULE',
      dynamicTools: [
        {
          type: 'namespace',
          name: 'litch_manager',
          description: 'Manager fixture',
          instructions: 'FIXED_MANAGER_NAMESPACE_RULE',
          tools: [
            {
              type: 'function',
              name: 'external_read',
              description: 'Read the loopback fixture',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            },
          ],
        },
      ],
    })
    const read = async () => {
      const response = await client.raw(IDLE_COMPACT_READ, { threadId: thread.id })
      assert.ok(response.result, JSON.stringify(response.error))
      return response.result
    }
    const turn = async (text: string) => {
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
      return turn.id
    }
    model.enqueue(() => [{ type: 'text', text: 'Original manager context' }])
    const original = await turn('ORIGINAL_INPUT_BEFORE_COMPACT')
    const snapshot = await read()
    assert.equal(snapshot.idle, true)
    assert.equal(snapshot.lastTurnId, original)
    assert.ok(snapshot.usedTokens > 0)
    const projectDir = join(home, 'claude', 'projects')
    let nativeId: string | undefined
    for (const file of await readdir(projectDir, { recursive: true, withFileTypes: true })) {
      if (
        file.isFile() &&
        file.name.endsWith('.jsonl') &&
        (await readFile(join(file.parentPath, file.name), 'utf8')).includes(
          'ORIGINAL_INPUT_BEFORE_COMPACT',
        )
      ) {
        nativeId = basename(file.name, '.jsonl')
        break
      }
    }
    assert.ok(nativeId, '隔离 CLI 持久化了经理原生会话')
    const registry = join(home, 'claude', 'sessions')
    const registration = join(registry, `${process.pid}.json`)
    await mkdir(registry, { recursive: true })
    await writeFile(
      registration,
      JSON.stringify({ pid: process.pid, sessionId: nativeId, status: 'idle' }),
    )
    assert.equal((await read()).idle, false, '别的进程即使没在跑也占着这个会话')
    await client.raw(
      'thread/compact/start',
      { threadId: thread.id, litchIdleCompact: snapshot },
      -32009,
    )
    await writeFile(registration, '{')
    assert.equal((await read()).idle, false, '进程登记未读全时不宣称空闲')
    await unlink(registration)
    assert.equal((await read()).idle, true)
    await client.raw(
      'thread/compact/start',
      {
        threadId: thread.id,
        litchIdleCompact: { ...snapshot, usageTurnId: 'stale' },
      },
      -32009,
    )
    model.enqueue(() => [{ type: 'text', text: '<summary>COMPACTED_MANAGER_CONTEXT</summary>' }])
    const { result } = await client.raw('thread/compact/start', {
      threadId: thread.id,
      litchIdleCompact: snapshot,
    })
    assert.equal(typeof result?.turnId, 'string')
    assert.equal((await client.completed(result.turnId)).status, 'completed')
    await client.notification('thread/compacted', (params) => params.turnId === result.turnId)
    assert.equal((await read()).lastTurnId, original)
    model.enqueue((request) => {
      const system = JSON.stringify(request.system)
      assert.match(system, /FIXED_MANAGER_DEVELOPER_RULE/)
      assert.match(system, /FIXED_MANAGER_NAMESPACE_RULE/)
      assert.match(JSON.stringify(request.messages), /COMPACTED_MANAGER_CONTEXT/)
      assert.ok(
        request.tools.some((one: { name: string }) => one.name === tool),
        tool,
      )
      return [{ type: 'tool_use', name: tool, id: 'toolu_external_after_compact', input: {} }]
    })
    model.enqueue((request) => {
      assert.match(JSON.stringify(request.messages), /fixture external result/)
      return [{ type: 'text', text: 'Done' }]
    })
    await turn('EXTERNAL_EVENT_AFTER_COMPACT')
    assert.equal(calls, 1)
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
