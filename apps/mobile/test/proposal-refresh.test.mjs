// 真核心 → 通道 → 手机会话存储：协议里的 callId 与显示条目键不同，卡片仍应随状态更新。
// 对面使用假设备，不启动桌面端、不访问个人配置或模型。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectChannel, createPortPair, serveChannel } from '@litch/core'
import { deviceWorld, features } from '../../../packages/core/test/device-world.mts'
import { harness } from '../../../packages/core/test/fake-device.mts'
import { thread, turn, userText } from '../../../packages/core/test/fixtures.mts'
import { SessionStore } from '../src/core/session-store.ts'
import { until } from './helpers.mjs'

async function fixture(t, tool = 'wrap_up') {
  const proposal = {
    id: 'pr1',
    threadId: 'p',
    title: '整理',
    prompt: '整理文件',
    background: '',
    harness: null,
    model: null,
    cwd: null,
    kind: 'fresh',
    wakeParent: true,
    status: 'pending',
    createdAt: 1_700_000_000,
    expiresAt: 1_700_003_600,
    startedThreadId: null,
    turnId: 't1',
    callId: 'call1',
  }
  const item = {
    type: 'dynamicToolCall',
    id: 'call1',
    namespace: 'litch_sessions',
    tool,
    arguments:
      tool === 'wrap_up'
        ? { suggestions: [{ title: '整理', prompt: '整理文件' }] }
        : { title: '整理', prompt: '整理文件', initiation: 'propose' },
    status: 'completed',
    success: true,
    durationMs: 1,
    contentItems: [{ type: 'inputText', text: JSON.stringify({ proposal_id: 'pr1' }) }],
  }
  const engine = harness('codex', {
    declaration: { extensions: ['clientTools'], features: features() },
    threads: [
      thread({
        id: 'p',
        turns: [
          turn('t1', [userText('u1', '整理'), item]),
          turn('t2', [userText('u2', '另一个回合')]),
        ],
      }),
    ],
  })
  const world = deviceWorld([engine], {
    prepare: (device) => device.extensions.push('sessionTree'),
    extra: {
      'litch/sessionProposal/list': () => ({ proposals: [proposal] }),
      'litch/sessionProposal/accept': () => {
        engine.threads.push(thread({ id: 'child' }))
        return { threadId: 'child' }
      },
      'litch/sessionProposal/dismiss': () => ({}),
      'litch/sessionProposal/markHere': () => ({ text: '在这里做：整理\n\n整理文件' }),
    },
  })
  const [uiPort, corePort] = createPortPair()
  const clock = {
    now: () => Date.now(),
    setTimer(callback, ms) {
      const timer = setTimeout(callback, ms)
      return () => clearTimeout(timer)
    },
  }
  const unserve = serveChannel(corePort, world.core, { clock })
  const channel = connectChannel(uiPort)
  const store = new SessionStore(channel, 'local', 'p')
  t.after(() => {
    store.stop()
    channel.close()
    unserve()
    world.core.stop()
  })
  world.core.start()
  await until(() => world.device()?.sessionTree, { what: '连接设备服务' })
  store.start()
  const card = () => store.getSnapshot().rows.find((row) => row.type === 'proposal')
  await until(() => card()?.proposal?.status === 'pending', { what: '等待开始的卡片' })
  assert.equal(card().itemId, 't1:call1')
  return { world, channel, store, card, proposal }
}

for (const tool of ['start', 'wrap_up']) {
  for (const [action, status] of [
    ['accept', 'started'],
    ['here', 'here'],
    ['dismiss', 'dismissed'],
  ]) {
    test(`${tool} 卡：${action} 应答后只重画所属回合，不等其他条目刷新`, async (t) => {
      const { world, channel, store, card } = await fixture(t, tool)
      const unchanged = store.getSnapshot().rows.filter((row) => row.turnId === 't2')
      await channel.command(`session.proposal.${action}`, {
        deviceId: 'local',
        sessionId: 'p',
        proposalId: 'pr1',
      })
      // 此夹具不发提案通知，单独检验点击成功后的核心本地结算路径。
      await until(() => store.getProposals()?.[0]?.status === status, { what: '提案状态已结算' })
      assert.equal(card().proposal.status, status, '提案列表变了，对话中的卡片也必须变')
      assert.deepEqual(
        store.getSnapshot().rows.filter((row) => row.turnId === 't2'),
        unchanged,
      )
      for (const row of unchanged) assert.ok(store.getSnapshot().rows.includes(row))
      if (action === 'accept') assert.equal(card().proposal.startedId, 'child')
      if (action === 'here') assert.ok(world.sent('turn/start').length > 0, '消息已发给引擎')
    })
  }
}

test('设备推送：仅有手机连接，收到提案 changed 后更新卡片', async (t) => {
  const { world, store, card, proposal } = await fixture(t)
  world.peer.last().notify('litch/sessionProposal/changed', {
    threadId: 'p',
    proposals: [],
    changed: [
      { ...proposal, status: 'started', startedThreadId: 'child', settledAt: 1_700_000_100 },
    ],
  })
  await until(() => store.getProposals()?.[0]?.status === 'started', { what: '设备推送已到手机' })
  assert.equal(card().proposal.status, 'started')
  assert.equal(card().proposal.startedId, 'child')
})
