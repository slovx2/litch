import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { buildSystemPromptAddendum } from '../src/server-helpers.mjs'
import { SessionStore } from '../src/store.mjs'
import type { ClaudeRuntime, RpcPeer, RuntimeTurnContext } from '../src/types.mjs'

const noInstructions = {
  baseInstructions: null,
  developerInstructions: null,
  personality: null,
}

test('系统提示附加段只含项目、开发者指令和个性，适配器不带任何呈现类指令', () => {
  assert.equal(buildSystemPromptAddendum(noInstructions), null)
  const prompt = buildSystemPromptAddendum({
    baseInstructions: '  Explain in Chinese.  ',
    developerInstructions: '  Use plain text when requested.  ',
    personality: 'pragmatic',
  })
  assert.ok(prompt)
  assert.match(prompt, /^# Project instructions\nExplain in Chinese\./)
  assert.match(prompt, /# Developer instructions\nUse plain text when requested\./)
  assert.match(prompt, /Personality: pragmatic/)
  assert.doesNotMatch(prompt, /Mermaid|Codex desktop|presentation/i)
})

test('普通回合和带 outputSchema 的回合用同一份附加段，分叉保留父会话的前缀', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-desktop-prompt-'))
  const previousHome = process.env.CHA_CLAUDE_HOME
  process.env.CHA_CLAUDE_HOME = directory
  const store = new SessionStore(join(directory, 'state.sqlite'))
  const contexts: RuntimeTurnContext[] = []
  const responses = new Map<unknown, any>()
  let finish: (() => void) | undefined
  let timeout: NodeJS.Timeout | undefined
  const runtime: ClaudeRuntime = {
    runTurn: async (context, handlers) => {
      contexts.push(context)
      await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
    },
    steer: async () => {},
    interrupt: async () => {},
    stop: async () => {},
  }
  const server = new CodexClaudeAppServer(store, runtime)
  const peer: RpcPeer = {
    id: 'desktop-prompt-test',
    close: () => {},
    send: (message) => {
      if ('id' in message) responses.set(message.id, message)
      if ('method' in message && message.method === 'turn/completed') finish?.()
    },
  }
  let nextId = 0
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = ++nextId
    await server.handle(peer, { id, method, params })
    const response = responses.get(id)
    assert.ok(response, `Missing ${method} response`)
    assert.equal(response.error, undefined)
    return response.result
  }
  const turn = async (threadId: string, params: Record<string, unknown> = {}) => {
    const completed = new Promise<void>((resolve) => {
      finish = resolve
    })
    await request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Explain this architecture.' }],
      ...params,
    })
    await Promise.race([
      completed,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Prompt turn timed out')), 5_000)
      }),
    ])
    if (timeout) clearTimeout(timeout)
    const context = contexts.at(-1)
    assert.ok(context)
    return context
  }
  try {
    const instructions = {
      baseInstructions: 'Explain in Chinese.',
      developerInstructions: 'Use plain text when requested.',
      personality: 'pragmatic',
    }
    const { thread } = await request('thread/start', {
      cwd: directory,
      model: 'sonnet',
      ...instructions,
    })
    const normal = await turn(thread.id)
    assert.equal(normal.purpose, 'normal')
    assert.equal(normal.systemPromptAddendum, buildSystemPromptAddendum(instructions))

    const summary = await turn(thread.id, {
      outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
    })
    assert.equal(summary.purpose, 'summary')
    assert.equal(summary.systemPromptAddendum, buildSystemPromptAddendum(instructions))

    const fork = await request('thread/fork', {
      threadId: thread.id,
      developerInstructions: 'Focus on the storage layer.',
    })
    const sidechat = await turn(fork.thread.id)
    assert.equal(sidechat.systemPromptAddendum, normal.systemPromptAddendum)
    assert.match(sidechat.prompt, /^<side-conversation-instructions>\nFocus on the storage layer\./)
  } finally {
    if (timeout) clearTimeout(timeout)
    await server.stop()
    if (previousHome == null) delete process.env.CHA_CLAUDE_HOME
    else process.env.CHA_CLAUDE_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
})
