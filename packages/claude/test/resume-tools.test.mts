import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { clientToolSpecs } from '../../protocol/src/client-tools-specs.mjs'
import { RESUME_TOOLS_READ } from '../../protocol/src/resume-tools.mjs'
import { MockRuntime } from '../src/mock-runtime.mjs'
import { sessionFingerprint } from '../src/native-session.mjs'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import type { RpcPeer, RuntimeHandlers, RuntimeTurnContext } from '../src/types.mjs'

test('Claude 恢复替换工具：活动回合延后、下回合可调用、关闭后不再提供、指纹失效', {
  timeout: 15000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-resume-tools-'))
  const store = new SessionStore(join(home, 'state.sqlite'))
  let enter!: () => void
  const entered = {
    promise: new Promise<void>((resolve) => {
      enter = resolve
    }),
    resolve: () => enter(),
  }
  let unblock!: () => void
  const release = {
    promise: new Promise<void>((resolve) => {
      unblock = resolve
    }),
    resolve: () => unblock(),
  }
  const contexts: RuntimeTurnContext[] = []
  const results: unknown[] = []
  class Runtime extends MockRuntime {
    override async runTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void> {
      contexts.push(context)
      if (contexts.length === 1) {
        entered.resolve()
        await release.promise
      }
      if (context.dynamicTools?.some((tool: any) => tool.name === 'litch_machine'))
        results.push(
          await handlers.onDynamicToolCall!(
            { namespace: 'litch_machine', name: 'machines' },
            {},
            `call-${contexts.length}`,
          ),
        )
      await handlers.onEvent({ type: 'completed', success: true })
    }
  }
  const server = new CodexClaudeAppServer(store, new Runtime())
  const messages: any[] = []
  let seq = 0
  const peer: RpcPeer = {
    id: 'tools-test',
    close() {},
    send(message: any) {
      messages.push(message)
      if (message.method === 'item/tool/call')
        void server.handle(peer, {
          jsonrpc: '2.0',
          id: message.id,
          result: { success: true, contentItems: [{ type: 'inputText', text: '已调用' }] },
        })
    },
  }
  const call = async (method: string, params: unknown): Promise<any> => {
    const id = ++seq
    await server.handle(peer, { id, method, params })
    const reply = messages.find((message) => message.id === id && !message.method)
    assert.equal(reply?.error, undefined, JSON.stringify(reply?.error))
    return reply.result
  }
  const done = async (turnId: string) => {
    while (
      !messages.some(
        (message) => message.method === 'turn/completed' && message.params.turn.id === turnId,
      )
    )
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  try {
    await call('initialize', {
      clientInfo: { name: 'test', version: '0' },
      capabilities: {
        litchExtensions: ['clientTools'],
        litchClientTools: { namespaces: ['litch_machine'] },
      },
    })
    const { thread } = await call('thread/start', {
      cwd: home,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
    const first = await call('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '等待' }],
    })
    await entered.promise
    const tools = clientToolSpecs(['litch_machine'])
    await call('thread/resume', { threadId: thread.id, dynamicTools: tools })
    assert.deepEqual((await call(RESUME_TOOLS_READ, { threadId: thread.id })).dynamicTools, [])
    release.resolve()
    await done(first.turn.id)
    assert.deepEqual(store.threadSettings(thread.id).dynamicTools, tools)
    const second = await call('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '调用' }],
    })
    await done(second.turn.id)
    assert.equal(results.length, 1)
    assert.equal(messages.filter((message) => message.method === 'item/tool/call').length, 1)
    assert.equal((results[0] as { success: boolean }).success, true)
    assert.notEqual(sessionFingerprint(contexts[0]!), sessionFingerprint(contexts[1]!))
    await call('thread/resume', { threadId: thread.id, dynamicTools: [] })
    const third = await call('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '已关闭' }],
    })
    await done(third.turn.id)
    assert.deepEqual(contexts[2]!.dynamicTools, [])
    assert.equal(results.length, 1)
    for (const options of [{ ephemeral: true }, { sandbox: 'read-only' }]) {
      const created = await call('thread/start', { cwd: home, ...options })
      await call('thread/resume', { threadId: created.thread.id, dynamicTools: tools })
      assert.deepEqual(store.threadSettings(created.thread.id).dynamicTools ?? [], [])
    }
    const downgrade = await call('thread/start', { cwd: home, sandbox: 'workspace-write' })
    await call('thread/resume', {
      threadId: downgrade.thread.id,
      permissions: ':read-only',
      dynamicTools: tools,
    })
    assert.deepEqual(store.threadSettings(downgrade.thread.id).dynamicTools ?? [], [])
  } finally {
    release.resolve()
    await server.stop()
    await rm(home, { recursive: true, force: true })
  }
})
