import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import type { ClaudeRuntime, RpcPeer } from '../src/types.mjs'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('取消停止屏障释放前不能启动另一回合，重复取消共同等待停止完成', {
  timeout: 10_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cancel-state-'))
  const previousHome = process.env.CHA_CLAUDE_HOME
  process.env.CHA_CLAUDE_HOME = directory
  const store = new SessionStore(join(directory, 'state.sqlite'))
  const running = gate()
  const stopping = gate()
  const release = gate()
  const finish = gate()
  const responses = new Map<unknown, any>()
  let runCount = 0
  let interruptCount = 0
  const runtime: ClaudeRuntime = {
    runTurn: async () => {
      if (++runCount === 1) {
        running.resolve()
        await finish.promise
      }
    },
    steer: async () => {},
    interrupt: async () => {
      interruptCount++
      stopping.resolve()
      await release.promise
      finish.resolve()
    },
    stop: async () => {
      finish.resolve()
    },
  }
  const server = new CodexClaudeAppServer(store, runtime)
  const peer: RpcPeer = {
    id: 'cancel-state',
    close: () => {},
    send: (message) => {
      if ('id' in message) responses.set(message.id, message)
    },
  }
  let nextID = 0
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = ++nextID
    await server.handle(peer, { id, method, params })
    assert.ok(responses.has(id))
    return responses.get(id)
  }
  try {
    const created = await request('thread/start', { cwd: directory })
    const threadId = created.result.thread.id
    const startParams = { threadId, input: [{ type: 'text', text: 'test' }] }
    const started = await request('turn/start', startParams)
    await running.promise
    const params = { threadId, turnId: started.result.turn.id }
    const first = request('turn/interrupt', params)
    await stopping.promise
    let duplicateAnswered = false
    const duplicate = request('turn/interrupt', params).then((value) => {
      duplicateAnswered = true
      return value
    })
    const whileStopping = await request('turn/start', startParams)
    assert.equal(whileStopping.error?.code, -32009, '原生停止中不能释放线程执行权')
    assert.equal(duplicateAnswered, false, '重复取消不能提前声称原生执行已停止')
    release.resolve()
    assert.equal((await first).error, undefined)
    assert.equal((await duplicate).error, undefined)
    assert.equal(interruptCount, 1)
    const next = await request('turn/start', startParams)
    assert.equal(next.error, undefined)
  } finally {
    release.resolve()
    finish.resolve()
    await server.stop()
    if (previousHome === undefined) delete process.env.CHA_CLAUDE_HOME
    else process.env.CHA_CLAUDE_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
})
