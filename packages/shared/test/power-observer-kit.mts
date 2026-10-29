import assert from 'node:assert/strict'
import { PowerObserver } from '../src/power-observer.mjs'
import type { RpcPeer, WireMessage } from '../src/types.mjs'

/** 用禁止历史和运行时访问的宿主，验证观察连接从真实 handle/closePeer 提前返回。 */
export async function checkPowerObserver(prototype: object, pi: boolean): Promise<void> {
  const busy = { projection: { status: () => ({ type: 'active' }) }, jobs: { list: () => [] } }
  const quiet = { projection: { status: () => ({ type: 'idle' }) }, jobs: { list: () => [] } }
  const background = {
    projection: quiet.projection,
    jobs: { list: () => [{ status: 'running' }] },
  }
  const state: any = Object.assign(Object.create(prototype), {
    powerObserver: new PowerObserver(),
    active: new Map([['busy', {}]]),
    background: new Map([['background', new Set(['job'])]]),
    live: new Map([
      ['busy', busy],
      ['quiet', quiet],
      ['background', background],
    ]),
    ephemeral: new Map(),
    shells: {
      runningThreadIds: () => ['background'],
      collection: (id: string) => (id === 'background' ? [{ status: 'running' }] : []),
    },
  })
  for (const key of ['store', 'runtime', 'peers', 'sessions', 'requests'])
    Object.defineProperty(state, key, {
      get() {
        throw new Error(`不应访问 ${key}`)
      },
    })
  const replies: any[] = []
  const peer: RpcPeer = { id: 'observer', send: (frame) => replies.push(frame), close() {} }
  const call = async (method: string, params: unknown = {}) => {
    await state.handle(peer, { id: replies.length + 1, method, params } as WireMessage)
    return replies.at(-1)
  }
  assert.equal((await call('litch/internal/power/activity')).error.code, -32601)
  await call('initialize', { clientInfo: { name: 'litch-power-observer' } })
  assert.deepEqual((await call('litch/internal/power/activity')).result.threads, [
    { threadId: 'busy', active: true, background: false },
    { threadId: 'background', active: false, background: true },
  ])
  if (pi) state.active.clear()
  else state.live.set('busy', quiet)
  // 定向查询不得枚举所有 loaded 线程。
  for (const map of [state.active, state.background, state.live, state.ephemeral])
    map.keys = () => {
      throw new Error('定向查询不应枚举线程')
    }
  assert.deepEqual(
    (await call('litch/internal/power/activity', { threadIds: ['busy', 'missing'] })).result
      .threads,
    [
      { threadId: 'busy', active: false, background: false },
      { threadId: 'missing', active: false, background: false },
    ],
  )
  assert.equal((await call('litch/internal/power/activity', { threadIds: [1] })).error.code, -32602)
  assert.equal((await call('thread/resume', { threadId: 'busy' })).error.code, -32601)
  state.closePeer(peer)
}
