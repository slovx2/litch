// 账号额度（accountLimits 主题）在核心这一头：主题开着才读、聚合面上带 harness、
// 主额度的窗口短的在前、别的额度跟在后面带名字、更新通知按 harness 并进去（没给的窗口沿用）、
// 三十秒内重开不再读、对面不认识这个方法时就是没有额度。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GetAccountRateLimitsResponse } from '../../protocol/src/index.mjs'
import { type AccountLimitsOp, type AccountLimitsView, createCore } from '../src/index.mjs'
import { fakeDevice, harness } from './fake-device.mjs'
import { fakeOpener, RpcFailure } from './fake-server.mjs'
import { fakeClock, settle } from './helpers.mjs'

const RESET = 1_800_000_000

const snapshot = (
  limitId: string,
  limitName: string | null,
  primary: [number, number] | null,
  secondary: [number, number] | null = null,
) => ({
  limitId,
  limitName,
  normalModelSlug: null,
  primary: primary && { usedPercent: primary[0], windowDurationMins: primary[1], resetsAt: RESET },
  secondary: secondary && {
    usedPercent: secondary[0],
    windowDurationMins: secondary[1],
    resetsAt: RESET,
  },
  credits: null,
  individualLimit: null,
  spendControlReached: null,
  planType: null,
  rateLimitReachedType: null,
})

const CLAUDE = {
  ordinaryUsageAllowed: null,
  // 故意把每周放在 primary：界面按窗口长短排，不按字段
  rateLimits: snapshot('claude-code', 'Claude Code', [18, 10080], [45, 300]),
  rateLimitsByLimitId: {
    'claude-code': snapshot('claude-code', 'Claude Code', [18, 10080], [45, 300]),
    'claude-code:seven_day_sonnet': snapshot('claude-code:seven_day_sonnet', 'Sonnet', [3, 10080]),
  },
  rateLimitResetCredits: null,
  accountId: null,
  rateLimitUpsell: null,
} as unknown as GetAccountRateLimitsResponse

function world() {
  const fake = fakeDevice([harness('claude-code'), harness('codex'), harness('pi')])
  const peer = fakeOpener({
    ...fake.handlers,
    'account/rateLimits/read': (params) => {
      const which = (params as { harness?: string }).harness
      if (which === 'claude-code') return CLAUDE
      throw new RpcFailure(-32601, 'Method not found')
    },
  })
  const time = fakeClock()
  const core = createCore({
    clock: time.clock,
    version: '9.9.9',
    log: () => {},
    devices: [
      {
        id: 'dev',
        name: 'build-01',
        host: 'dev@build-01',
        kind: 'ssh',
        target: { kind: 'alias', alias: 'build-01' },
        wire: 'green',
        open: peer.open,
      },
    ],
  })
  const reads = () =>
    peer.servers
      .flatMap((server) => server.seen)
      .filter((entry) => entry.method === 'account/rateLimits/read')
      .map((entry) => entry.params)
  const broadcast = (method: string, params: unknown) => {
    for (const server of peer.servers) server.notify(method, params)
  }
  const watch = (which: string) => {
    const seen = { view: null as AccountLimitsView | null }
    const close = core.subscribe(
      { kind: 'accountLimits', deviceId: 'dev', harness: which },
      {
        snapshot: (data) => {
          seen.view = data as AccountLimitsView
        },
        delta: (ops) => {
          for (const op of ops as AccountLimitsOp[]) seen.view = op.view
        },
        error() {},
      },
    )
    return { seen, close }
  }
  return { core, time, reads, broadcast, watch }
}

const brief = (view: AccountLimitsView | null) =>
  view?.rows.map((row) => [row.name, row.window.windowMins, row.window.usedPercent])

test('主题开着才读，聚合面上带 harness；主额度短的窗口在前，别的额度带名字跟在后面', async () => {
  const w = world()
  w.core.start()
  await settle()
  await settle()
  assert.deepEqual(w.reads(), [], '没人看着不读')
  const claude = w.watch('claude-code')
  assert.equal(claude.seen.view?.rows.length, 0, '先给空的快照')
  await settle()
  await settle()
  assert.deepEqual(w.reads(), [{ harness: 'claude-code' }])
  assert.deepEqual(brief(claude.seen.view), [
    [null, 300, 45],
    [null, 10080, 18],
    ['Sonnet', 10080, 3],
  ])
  assert.equal(claude.seen.view?.rows[0]?.window.resetsAt, RESET * 1000, '重置时间换成毫秒')

  // 更新只带变了的窗口：没给的沿用；别的 harness 的更新不并进来
  w.broadcast('account/rateLimits/updated', {
    harness: 'claude-code',
    rateLimits: snapshot('claude-code', 'Claude Code', null, [52, 300]),
  })
  w.broadcast('account/rateLimits/updated', {
    harness: 'codex',
    rateLimits: snapshot('codex', null, [99, 300]),
  })
  await settle()
  assert.deepEqual(brief(claude.seen.view), [
    [null, 300, 52],
    [null, 10080, 18],
    ['Sonnet', 10080, 3],
  ])

  // 三十秒内关了再开先给上次的、不再读；过了再开重新读
  claude.close()
  const again = w.watch('claude-code')
  assert.equal(again.seen.view?.rows.length, 3)
  await settle()
  assert.equal(w.reads().length, 1)
  again.close()
  w.time.advance(31_000)
  w.watch('claude-code')
  await settle()
  assert.equal(w.reads().length, 2)
})

test('对面不认识这个方法（Pi 之类）就是没有额度，订阅照样成立', async () => {
  const w = world()
  w.core.start()
  await settle()
  await settle()
  const pi = w.watch('pi')
  await settle()
  await settle()
  assert.deepEqual(w.reads(), [{ harness: 'pi' }])
  assert.deepEqual(pi.seen.view, { deviceId: 'dev', harness: 'pi', rows: [] })
})
