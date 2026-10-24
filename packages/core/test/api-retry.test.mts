// 模型请求在重试（扩展 apiRetry）：回合上记着第几次、最多几次和原因，重试结束、回合结束时去掉；
// 失败那次流出来的半截回答（对面已经删了）从对话里撤掉。对着假对端跑，不连任何真的东西。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Thread } from '../../protocol/src/index.mjs'
import { createCore } from '../src/index.mjs'
import { fakeOpener, type Handler, RpcFailure } from './fake-server.mjs'
import { agentText, thread, turn, userText } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'
import { watchSession } from './wire.mjs'

function setup(threads: Thread[]) {
  const handlers: Record<string, Handler> = {
    'runtime/info': () => ({
      engine: 'claude-code',
      protocolVersion: '0.163.0',
      cliBuild: '2.1.282',
      capabilities: [],
      releaseReady: true,
    }),
    'project/list': () => ({ data: [], nextCursor: null }),
    'thread/list': () => ({
      data: threads.map((entry) => ({ ...entry, turns: [] })),
      nextCursor: null,
      backwardsCursor: null,
    }),
    'thread/resume': (params) => {
      const found = threads.find((entry) => entry.id === (params as { threadId: string }).threadId)
      if (!found) throw new RpcFailure(-32600, 'thread not found')
      return {
        thread: found,
        model: 'opus',
        reasoningEffort: 'high',
        sandbox: { type: 'dangerFullAccess' },
      }
    },
    'model/list': () => ({ data: [], nextCursor: null }),
    'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
  }
  const time = fakeClock()
  const peer = fakeOpener(handlers)
  const core = createCore({
    clock: time.clock,
    version: '9.9.9',
    log: () => {},
    devices: [
      {
        id: 'local',
        name: '本机',
        host: 'dev@mac',
        kind: 'local',
        target: null,
        wire: 'green',
        open: peer.open,
      },
    ],
  })
  return { core, peer }
}

const running = () =>
  thread({
    id: 'a',
    status: { type: 'active', activeFlags: [] },
    turns: [
      turn('t1', [userText('t1:user', '说一段话'), agentText('half', '半截回答')], {
        status: 'inProgress',
        completedAt: null,
        durationMs: null,
      }),
    ],
  })

test('API-RETRY-001：握手声明 apiRetry；重试中记在回合上，半截回答撤掉，重试结束去掉', async () => {
  const { core, peer } = setup([running()])
  core.start()
  await settle()
  const declared = peer.last().seen.find((entry) => entry.method === 'initialize')?.params as {
    capabilities: { litchExtensions: string[] }
  }
  assert.ok(declared.capabilities.litchExtensions.includes('apiRetry'))

  const session = watchSession(core)
  await settle()
  const view = () => session.seen.view
  const texts = () =>
    view()?.turns[0]?.itemIds.map((id) => {
      const item = view()?.items[id]
      return item && 'text' in item ? item.text : item?.kind
    })
  assert.deepEqual(texts(), ['说一段话', '半截回答'])

  const server = peer.last()
  server.notify('litch/turn/apiRetry/updated', {
    threadId: 'a',
    turnId: 't1',
    retry: {
      attempt: 1,
      maxRetries: 10,
      retryDelayMs: 600,
      httpStatus: null,
      reason: 'connection',
    },
    discardedItemIds: ['half'],
  })
  await settle()
  assert.deepEqual(view()?.turns[0]?.retry, {
    attempt: 1,
    maxRetries: 10,
    reason: 'connection',
    httpStatus: null,
  })
  assert.deepEqual(texts(), ['说一段话'], '半截回答撤掉了')

  server.notify('litch/turn/apiRetry/updated', {
    threadId: 'a',
    turnId: 't1',
    retry: {
      attempt: 2,
      maxRetries: 10,
      retryDelayMs: 1200,
      httpStatus: 529,
      reason: 'overloaded',
    },
  })
  await settle()
  assert.equal(view()?.turns[0]?.retry?.attempt, 2)
  assert.equal(view()?.turns[0]?.retry?.reason, 'overloaded')

  server.notify('litch/turn/apiRetry/updated', { threadId: 'a', turnId: 't1', retry: null })
  await settle()
  assert.equal(view()?.turns[0]?.retry, null)
})

test('API-RETRY-002：回合结束时还记着重试中的，一并去掉', async () => {
  const { core, peer } = setup([running()])
  core.start()
  await settle()
  const session = watchSession(core)
  await settle()
  const server = peer.last()
  server.notify('litch/turn/apiRetry/updated', {
    threadId: 'a',
    turnId: 't1',
    retry: { attempt: 2, maxRetries: null, retryDelayMs: null, httpStatus: 500, reason: 'server' },
  })
  await settle()
  assert.equal(session.seen.view?.turns[0]?.retry?.maxRetries, null)
  server.notify('turn/completed', {
    threadId: 'a',
    turn: turn('t1', [userText('t1:user', '说一段话')], {
      status: 'failed',
      error: {
        message: 'API Error: 500',
        codexErrorInfo: 'internalServerError',
        additionalDetails: null,
        misalignment: null,
      },
    }),
  })
  await settle()
  assert.equal(session.seen.view?.turns[0]?.status, 'failed')
  assert.equal(session.seen.view?.turns[0]?.retry, null)
})
