import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  PRESENTATION_RULES,
  PRESENTATION_SPEC,
} from '../../protocol/src/client-tools-presentation.mjs'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import type { ClaudeRuntime, RpcPeer, RuntimeTurnContext } from '../src/types.mjs'

// Litch 的呈现风格（litch_presentation：不带工具、只带 instructions 的命名空间）经命名空间 instructions
// 进系统提示：Litch 建的会话的普通回合都有、只有一份，同一会话里不变；带 outputSchema 的回合没有；
// 没带它建的会话（官方桌面端直连这个入口）没有。

const USER = 'USER-DEVELOPER-INSTRUCTIONS'
const SESSIONS = {
  type: 'namespace',
  name: 'litch_sessions',
  description: 'Litch sessions on this device.',
  instructions: 'RULES-FOR-SESSIONS: propose cards for follow-up work.',
  tools: [
    {
      type: 'function',
      name: 'list',
      description: 'List sessions.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}
const SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' } },
  required: ['title'],
  additionalProperties: false,
}

async function world() {
  const directory = await mkdtemp(join(tmpdir(), 'claude-presentation-'))
  const previousHome = process.env.CHA_CLAUDE_HOME
  process.env.CHA_CLAUDE_HOME = directory
  const store = new SessionStore(join(directory, 'state.sqlite'))
  const contexts: RuntimeTurnContext[] = []
  const responses = new Map<unknown, any>()
  let finish: (() => void) | undefined
  const runtime: ClaudeRuntime = {
    runTurn: async (context, handlers) => {
      contexts.push(context)
      await handlers.onEvent({
        type: 'completed',
        success: true,
        result: context.purpose === 'normal' ? 'done' : '{"title":"标题"}',
      })
    },
    steer: async () => {},
    interrupt: async () => {},
    stop: async () => {},
  }
  const server = new CodexClaudeAppServer(store, runtime)
  const peer: RpcPeer = {
    id: 'presentation-test',
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
    assert.ok(response, `没有 ${method} 的应答`)
    assert.equal(response.error, undefined, JSON.stringify(response.error))
    return response.result
  }
  /** 跑一个回合，交回这个回合交给运行时的系统提示（没有是空字符串） */
  const turn = async (threadId: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const completed = new Promise<void>((resolve) => {
      finish = resolve
    })
    await request('turn/start', {
      threadId,
      input: [{ type: 'text', text: '接着说。' }],
      ...extra,
    })
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      completed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('回合没有结束')), 5_000)
      }),
    ])
    clearTimeout(timer)
    return contexts.at(-1)?.systemPromptAddendum ?? ''
  }
  const close = async () => {
    await server.stop()
    if (previousHome == null) delete process.env.CHA_CLAUDE_HOME
    else process.env.CHA_CLAUDE_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
  return { directory, request, turn, close }
}

const count = (text: string, needle: string) => text.split(needle).length - 1

test('LITCH-PRESENTATION-001：Litch 建的会话，普通回合带呈现风格（一份、在用户指令之后、每回合不变），恢复、分叉也带', async () => {
  const w = await world()
  try {
    const { thread } = await w.request('thread/start', {
      cwd: w.directory,
      model: 'sonnet',
      developerInstructions: USER,
      dynamicTools: [SESSIONS, PRESENTATION_SPEC],
    })
    const first = await w.turn(thread.id)
    assert.equal(count(first, PRESENTATION_RULES), 1, first)
    assert.equal(count(first, '# Tool instructions: litch_presentation'), 1, first)
    assert.ok(first.indexOf(USER) < first.indexOf(PRESENTATION_RULES), '在用户的指令之后')
    // 后面的回合系统提示一字不差（前缀缓存）
    assert.equal(await w.turn(thread.id), first)

    await w.request('thread/resume', { threadId: thread.id, developerInstructions: USER })
    assert.equal(await w.turn(thread.id), first)

    const { thread: fork } = await w.request('thread/fork', { threadId: thread.id })
    assert.equal(count(await w.turn(fork.id), PRESENTATION_RULES), 1)
  } finally {
    await w.close()
  }
})

test('LITCH-PRESENTATION-002：带 outputSchema 的回合不带呈现风格，之后的普通回合照旧带', async () => {
  const w = await world()
  try {
    const { thread } = await w.request('thread/start', {
      cwd: w.directory,
      model: 'sonnet',
      dynamicTools: [SESSIONS, PRESENTATION_SPEC],
    })
    const normal = await w.turn(thread.id)
    assert.equal(count(normal, PRESENTATION_RULES), 1, normal)
    const structured = await w.turn(thread.id, { outputSchema: SCHEMA })
    assert.equal(count(structured, PRESENTATION_RULES), 0, structured)
    assert.equal(count(structured, 'Litch'), 0, structured)
    assert.equal(await w.turn(thread.id), normal)
  } finally {
    await w.close()
  }
})

test('LITCH-PRESENTATION-003：没带它建的会话（官方桌面端直连这个入口）系统提示里没有 Litch 的呈现风格', async () => {
  const w = await world()
  try {
    const { thread } = await w.request('thread/start', {
      cwd: w.directory,
      model: 'sonnet',
      developerInstructions: USER,
    })
    const prompt = await w.turn(thread.id)
    assert.equal(count(prompt, PRESENTATION_RULES), 0, prompt)
    assert.equal(count(prompt, 'litch_presentation'), 0, prompt)
    assert.equal(count(prompt, 'appear in Litch'), 0, prompt)
  } finally {
    await w.close()
  }
})
