import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import type { ClaudeRuntime, RpcPeer, RuntimeTurnContext } from '../src/types.mjs'

// 分叉出来的会话自己的开发者指令和父会话的不一样时，入口不改系统提示（保住父会话的提示缓存），
// 把这份指令放在用户消息前面交给模型。照上游的语义（开发者指令只在初始上下文里放一次，
// 压缩、回退把它弄没了才再放），这一段在会话里只出现一次：头一个回合带，之后的回合不带；
// 指令变了、带着它的回合被回退了、上下文压缩过了，再带一次。
// 请求的顺序照官方桌面端：分叉时不带指令，接着恢复分叉出来的会话时带上它重新生成的那一份。

const PREFIX = '<side-conversation-instructions>'
const PARENT = 'Desktop instructions for the parent thread.'
const FORKED = 'Desktop instructions regenerated for the forked thread.'
const CHANGED = 'Desktop instructions changed again.'

async function world() {
  const directory = await mkdtemp(join(tmpdir(), 'claude-fork-instructions-'))
  const previousHome = process.env.CHA_CLAUDE_HOME
  process.env.CHA_CLAUDE_HOME = directory
  const store = new SessionStore(join(directory, 'state.sqlite'))
  const contexts: RuntimeTurnContext[] = []
  const responses = new Map<unknown, any>()
  let finish: (() => void) | undefined
  const runtime: ClaudeRuntime = {
    runTurn: async (context, handlers) => {
      contexts.push(context)
      // 压缩回合要报原生的压缩边界，入口才认为上下文真的压缩了
      if (context.purpose === 'compact')
        await handlers.onEvent({ type: 'context_compacted', messageId: randomUUID() })
      await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
    },
    steer: async () => {},
    interrupt: async () => {},
    stop: async () => {},
  }
  const server = new CodexClaudeAppServer(store, runtime)
  const peer: RpcPeer = {
    id: 'fork-instructions-test',
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
  /** 等下一个回合结束（回合是异步跑的） */
  const settled = async (start: () => Promise<unknown>) => {
    const completed = new Promise<void>((resolve) => {
      finish = resolve
    })
    await start()
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      completed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('回合没有结束')), 5_000)
      }),
    ])
    clearTimeout(timer)
  }
  /** 跑一个回合，交回这个回合送给运行时的东西 */
  const turn = async (threadId: string, text = '接着说。') => {
    await settled(() => request('turn/start', { threadId, input: [{ type: 'text', text }] }))
    const context = contexts.at(-1)
    assert.ok(context)
    return context
  }
  const close = async () => {
    await server.stop()
    if (previousHome == null) delete process.env.CHA_CLAUDE_HOME
    else process.env.CHA_CLAUDE_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
  return { directory, request, settled, turn, close }
}

/** 这个回合用户消息前面带的那一段指令；没带就是 null */
const injected = (context: RuntimeTurnContext): string | null => {
  if (!context.prompt.startsWith(PREFIX)) return null
  return (
    context.prompt.slice(PREFIX.length + 1).split('\n</side-conversation-instructions>')[0] ?? ''
  )
}

test('FORK-INSTRUCTIONS-001：桌面端分叉后恢复时带了新指令，只在头一个回合带一次；指令变了再带一次', async () => {
  const w = await world()
  try {
    const { thread } = await w.request('thread/start', {
      cwd: w.directory,
      model: 'sonnet',
      developerInstructions: PARENT,
    })
    const parent = await w.turn(thread.id)
    assert.equal(injected(parent), null)

    // 桌面端：分叉时不带指令，接着恢复分叉出来的会话，带上它重新生成的那一份
    const { thread: fork } = await w.request('thread/fork', { threadId: thread.id })
    await w.request('thread/resume', { threadId: fork.id, developerInstructions: FORKED })
    const turns = [await w.turn(fork.id), await w.turn(fork.id), await w.turn(fork.id)]
    assert.deepEqual(turns.map(injected), [FORKED, null, null])
    // 系统提示一直是父会话的那一份：分叉出来的会话接着用父会话的提示缓存
    for (const context of turns)
      assert.equal(context.systemPromptAddendum, parent.systemPromptAddendum)
    // 用户说的话原样跟在后面
    assert.ok(turns[0]?.prompt.endsWith('\n\n接着说。'))
    assert.equal(turns[1]?.prompt, '接着说。')

    // 再恢复一次、指令没变：不再带
    await w.request('thread/resume', { threadId: fork.id, developerInstructions: FORKED })
    assert.equal(injected(await w.turn(fork.id)), null)
    // 指令变了：带一次新的
    await w.request('thread/resume', { threadId: fork.id, developerInstructions: CHANGED })
    assert.deepEqual(
      [injected(await w.turn(fork.id)), injected(await w.turn(fork.id))],
      [CHANGED, null],
    )
    // 父会话自己不受影响
    assert.equal(injected(await w.turn(thread.id)), null)
  } finally {
    await w.close()
  }
})

test('FORK-INSTRUCTIONS-002：带着指令的回合被回退、上下文压缩过之后，下一个回合再带一次', async () => {
  const w = await world()
  try {
    const { thread } = await w.request('thread/start', {
      cwd: w.directory,
      model: 'sonnet',
      developerInstructions: PARENT,
    })
    await w.turn(thread.id)
    // 侧聊的做法：分叉时直接带上自己的指令
    const { thread: fork } = await w.request('thread/fork', {
      threadId: thread.id,
      developerInstructions: FORKED,
    })
    assert.deepEqual(
      [injected(await w.turn(fork.id)), injected(await w.turn(fork.id))],
      [FORKED, null],
    )

    // 回退两个回合，带着指令的那个回合没了：再带一次
    await w.request('thread/rollback', { threadId: fork.id, numTurns: 2 })
    assert.deepEqual(
      [injected(await w.turn(fork.id)), injected(await w.turn(fork.id))],
      [FORKED, null],
    )
    // 只回退后面那个不带指令的回合：不用再带
    await w.request('thread/rollback', { threadId: fork.id, numTurns: 1 })
    assert.equal(injected(await w.turn(fork.id)), null)

    // 压缩之后，之前带过的那一段已经压进摘要里了：再带一次
    await w.settled(() => w.request('thread/compact/start', { threadId: fork.id }))
    assert.deepEqual(
      [injected(await w.turn(fork.id)), injected(await w.turn(fork.id))],
      [FORKED, null],
    )

    // 从分叉出来的会话再分叉：新会话的指令正好是原来那个会话上次带过的那一份，也还是要带一次
    // （带过的那个回合在原来的会话里，新会话的模型没见过）
    await w.request('thread/resume', { threadId: fork.id, developerInstructions: CHANGED })
    const { thread: again } = await w.request('thread/fork', {
      threadId: fork.id,
      developerInstructions: FORKED,
    })
    assert.deepEqual(
      [injected(await w.turn(again.id)), injected(await w.turn(again.id))],
      [FORKED, null],
    )
  } finally {
    await w.close()
  }
})
