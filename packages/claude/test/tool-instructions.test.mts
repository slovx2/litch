import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { dynamicToolInstructions } from '../src/dynamic-tools.mjs'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import type { ClaudeRuntime, RpcPeer, RuntimeTurnContext } from '../src/types.mjs'

// 命名空间带的 instructions（clientTools 扩展）拼进会话的系统提示末尾：在用户自己的开发者指令之后，
// 新建、恢复、分叉出来的会话每个回合都在，只出现一次；用户的指令照旧在。

const USER = 'USER-DEVELOPER-INSTRUCTIONS'
const RULES = 'RULES-FOR-SESSIONS: propose cards for follow-up work.'
const TOOLS = [
  {
    type: 'namespace',
    name: 'litch_sessions',
    description: 'Litch sessions on this device.',
    instructions: `  ${RULES}\n`,
    tools: [
      {
        type: 'function',
        name: 'list',
        description: 'List sessions.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  },
  {
    type: 'namespace',
    name: 'litch_echo',
    description: '原样回参数',
    tools: [
      {
        type: 'function',
        name: 'echo',
        description: '原样回参数',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  },
]

async function world() {
  const directory = await mkdtemp(join(tmpdir(), 'claude-tool-instructions-'))
  const previousHome = process.env.CHA_CLAUDE_HOME
  process.env.CHA_CLAUDE_HOME = directory
  const store = new SessionStore(join(directory, 'state.sqlite'))
  const contexts: RuntimeTurnContext[] = []
  const responses = new Map<unknown, any>()
  let finish: (() => void) | undefined
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
    id: 'tool-instructions-test',
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
  /** 跑一个回合，交回这个回合交给运行时的系统提示 */
  const turn = async (threadId: string): Promise<string> => {
    const completed = new Promise<void>((resolve) => {
      finish = resolve
    })
    await request('turn/start', { threadId, input: [{ type: 'text', text: '接着说。' }] })
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

/** 规则在、只有一份、排在用户的指令后面 */
function assertRules(prompt: string, user = true) {
  assert.equal(count(prompt, RULES), 1, prompt)
  assert.equal(count(prompt, '# Tool instructions: litch_sessions'), 1, prompt)
  if (!user) return
  assert.equal(count(prompt, USER), 1, prompt)
  assert.ok(prompt.indexOf(USER) < prompt.indexOf(RULES), '规则在用户指令之后')
}

test('TOOL-INSTRUCTIONS-001：新建、恢复、分叉出来的会话，系统提示末尾都带命名空间的 instructions，各一份', async () => {
  const w = await world()
  try {
    const { thread } = await w.request('thread/start', {
      cwd: w.directory,
      model: 'sonnet',
      developerInstructions: USER,
      dynamicTools: TOOLS,
    })
    const first = await w.turn(thread.id)
    assertRules(first)
    // 后面的回合照样在，提示不变（命中提示缓存）
    assert.equal(await w.turn(thread.id), first)

    // 恢复时客户端又带了一遍开发者指令：不叠加
    await w.request('thread/resume', { threadId: thread.id, developerInstructions: USER })
    assert.equal(await w.turn(thread.id), first)

    // 分叉出来的会话带着原会话的工具，也带着规则
    const { thread: fork } = await w.request('thread/fork', { threadId: thread.id })
    assertRules(await w.turn(fork.id))
  } finally {
    await w.close()
  }
})

test('TOOL-INSTRUCTIONS-002：没有 instructions 的工具、没有工具的会话，系统提示照旧', async () => {
  const w = await world()
  try {
    const { thread } = await w.request('thread/start', {
      cwd: w.directory,
      model: 'sonnet',
      developerInstructions: USER,
      dynamicTools: [TOOLS[1]],
    })
    const plain = await w.turn(thread.id)
    assert.equal(count(plain, '# Tool instructions'), 0, plain)
    assert.equal(count(plain, USER), 1)
    const { thread: bare } = await w.request('thread/start', { cwd: w.directory, model: 'sonnet' })
    assert.equal(count(await w.turn(bare.id), '# Tool instructions'), 0)
  } finally {
    await w.close()
  }
})

test('TOOL-INSTRUCTIONS-003：同一段 instructions 只放一次，空的不放', () => {
  const again = { ...TOOLS[0], name: 'litch_other' }
  const blank = { ...TOOLS[1], instructions: '   ' }
  const joined = dynamicToolInstructions([TOOLS[0], again, blank, TOOLS[1]])
  assert.equal(joined, `# Tool instructions: litch_sessions\n${RULES}`)
  assert.equal(dynamicToolInstructions([]), null)
  assert.equal(dynamicToolInstructions(undefined), null)
})
