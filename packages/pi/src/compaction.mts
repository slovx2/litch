import { randomUUID } from 'node:crypto'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import type { RpcPeer } from '../../shared/src/types.mjs'
import { watchNativeSession } from './native-watch.mjs'
import type { ActiveTurn, PiServer } from './server.mjs'
import type { PiThread } from './store.mjs'
import { finishTurn } from './turn.mjs'

/**
 * 手动压缩（thread/compact/start）。上游每次都真的压，压缩是单独的一个回合，出错时这个回合失败。
 * Pi 自己定压不压：会话太小（Nothing to compact）、刚压过（Already compacted）就不压，当场报错，
 * 这不是压缩出了错，只是没什么可做。所以先让 Pi 去压，它定了要压（压缩之前的扩展事件来了，见 runtime.mts）
 * 才开回合；它不压的话不开回合，它的原话作为这个请求的错误回给客户端，历史里什么都不留。
 * 开了回合之后再出错（模型请求失败之类）是这个回合失败，和上游一样。
 */
export async function startCompaction(
  server: PiServer,
  peer: RpcPeer,
  thread: PiThread,
): Promise<void> {
  server.ensureIdle(thread.id)
  const live = await server.load(thread, peer, true)
  server.ensureIdle(thread.id)
  const session = live.session
  let active: ActiveTurn | undefined
  const opened = new Promise<void>((resolve) => {
    // Pi 等这个处理函数跑完才动手，回合的标记条目因此排在压缩条目前面
    live.compacting = () => {
      const started = server.admit(peer, thread, { input: [] })
      const { turn } = started
      started.live = live
      session.sessionManager.appendCustomEntry('codex-harness-adapter-turn', {
        id: turn.id,
        startedAt: turn.startedAt,
        clientId: null,
      })
      server.notify(thread.id, 'turn/started', { turn })
      server.notify(thread.id, 'thread/status/changed', {
        status: { type: 'active', activeFlags: [] },
      })
      // Pi 发“开始压缩”时这个回合还没开：压缩条目的开始在这里补，完成照常由 turn.mts 发
      started.compacting = { type: 'contextCompaction', id: `compact:${randomUUID()}` }
      turn.items.push(started.compacting)
      server.store.saveTurn(thread.id, turn)
      server.notify(thread.id, 'item/started', { turnId: turn.id, item: started.compacting })
      active = started
      resolve()
    }
  })
  const running = session.compact()
  try {
    await Promise.race([opened, running])
  } catch (error) {
    throw new ProtocolError(-32600, error instanceof Error ? error.message : String(error))
  } finally {
    delete live.compacting
  }
  if (active) void follow(server, active, running)
}

// 回合开了之后跟着压缩做完；和发消息的回合一样，执行期间原生会话被别的实例改了就停下
async function follow(server: PiServer, active: ActiveTurn, running: Promise<unknown>) {
  const { thread, turn } = active
  const session = active.live!.session
  let externalChange = false
  const unwatch = watchNativeSession(session, () => {
    externalChange = true
    turn.error = {
      message: '原生会话在执行期间被其他实例修改，请重新加载后继续',
      codexErrorInfo: null,
      additionalDetails: null,
    }
    server.store.setMeta('queue', thread.id, { paused: true })
    session.clearQueue()
    void session.abort()
  })
  try {
    await running
  } catch (error) {
    if (!active.stopped && !turn.error)
      turn.error = {
        message: error instanceof Error ? error.message : String(error),
        codexErrorInfo: null,
        additionalDetails: null,
      }
  } finally {
    unwatch()
    await finishTurn(server, active, externalChange)
  }
}
