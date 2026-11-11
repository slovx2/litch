import assert from 'node:assert/strict'
import { test } from 'node:test'
import { modelLimitFailure } from '../../protocol/src/model-ranking.mjs'
import { connectChannel } from '../src/channel/client.mjs'
import { createPortPair } from '../src/channel/memory-port.mjs'
import { ChannelError } from '../src/channel/protocol.mjs'
import { serveChannel } from '../src/channel/server.mjs'
import { RpcError } from '../src/connection/rpc.mjs'
import { channelFailure } from '../src/device/faults.mjs'
import { createMockCore } from '../src/mock/mock-core.mjs'
import { sampleModelRanking } from '../src/mock/sample-data.mjs'
import type { SessionView } from '../src/model.mjs'
import { modelLimitPreview, modelLimitSettings, rankedModelSelection } from '../src/model-limit.mjs'
import { deviceWorld, features } from './device-world.mjs'
import { harness } from './fake-device.mjs'
import { RpcFailure } from './fake-server.mjs'
import { thread } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'

test('经理默认模型预检提供父子身份、可选型号、Phrase 和两条设置目标', () => {
  const config = sampleModelRanking('custom-cross')
  const parent = rankedModelSelection(config, 'claude-code', 'anthropic/claude-sonnet-5-5')
  const child = rankedModelSelection(config, 'codex', 'gpt-6-astra')
  const result = modelLimitPreview(config, parent, child, {
    deviceId: 'local',
    sessionId: 'manager',
  })
  assert.equal(result.allowed, false)
  assert.equal(result.failure?.reason.kind, 'exceeded')
  assert.equal(result.failure?.text.key, 'modelRanking.limitExceeded')
  assert.deepEqual(result.failure?.text.args, { parent: 'Sonnet 5.5', child: 'gpt-6-astra' })
  assert.deepEqual(result.failure?.settings, [
    { kind: 'manager-default-model', deviceId: 'local', sessionId: 'manager' },
    { kind: 'model-ranking', deviceId: 'local' },
  ])
  const missing = rankedModelSelection(config, 'claude-code', 'gateway/future-v1')
  assert.equal(
    modelLimitPreview(config, parent, missing, { deviceId: 'local', sessionId: 'manager' }).failure
      ?.reason.kind,
    'unranked',
  )
  assert.equal(
    modelLimitPreview({ ...config, crossHarness: false }, parent, child, {
      deviceId: 'local',
      sessionId: 'manager',
    }).allowed,
    true,
  )
})

test('预检身份沿用目录中唯一供应商别名，歧义与缺失不借用官方等级', () => {
  const config = sampleModelRanking()
  const parent = rankedModelSelection(config, 'claude-code', 'claude-sonnet-5-5')
  assert.equal(parent.provider, 'anthropic')
  assert.equal(parent.trusted, true)
  const duplicate = {
    ...parent,
    key: 'other-provider',
    provider: 'other',
    model: 'other/claude-sonnet-5-5',
  }
  const ambiguous = rankedModelSelection(
    { ...config, models: [...config.models, duplicate] },
    'claude-code',
    'claude-sonnet-5-5',
  )
  assert.equal(ambiguous.available, false)
  assert.equal(ambiguous.provider, 'unknown')
  const missing = rankedModelSelection(config, 'claude-code', 'opus')
  assert.equal(missing.provider, 'unknown')
  const uncertain = modelLimitPreview(config, parent, missing, {
    deviceId: 'local',
    sessionId: 's',
  })
  assert.equal(uncertain.failure?.reason.kind, 'unranked')
})

test('mock 保存开关为设备有效规则，恢复内置清掉开关', async () => {
  const time = fakeClock()
  const core = createMockCore({ clock: time.clock, modelRankingScenario: 'custom-cross' })
  const signal = new AbortController().signal
  const read = (await core.command(
    'device.modelRanking.read',
    { deviceId: 'local' },
    signal,
  )) as ReturnType<typeof sampleModelRanking>
  assert.equal(read.crossHarness, true)
  const saved = (await core.command(
    'device.modelRanking.write',
    { deviceId: 'local', ...read, expectedRevision: read.revision, crossHarness: false },
    signal,
  )) as typeof read
  assert.equal(saved.crossHarness, false)
  assert.equal(saved.mode, 'custom')
  const enabled = (await core.command(
    'device.modelRanking.write',
    { deviceId: 'local', ...saved, expectedRevision: saved.revision, crossHarness: true },
    signal,
  )) as typeof read
  assert.equal(enabled.crossHarness, true)
  const restored = (await core.command(
    'device.modelRanking.reset',
    { deviceId: 'local', expectedRevision: enabled.revision },
    signal,
  )) as typeof read
  assert.equal(restored.crossHarness, false)
  assert.equal(restored.mode, 'builtin')
})

test('设备结构化 RPC 错误经通道传递时保留模型原因与设置目标', async () => {
  const config = sampleModelRanking()
  const parent = config.models.find((row) => row.model === 'gpt-6-sol')!
  const child = config.models.find((row) => row.model === 'gpt-6-astra')!
  const reason = modelLimitFailure(config, parent, child)!
  const error = modelLimitSettings(
    channelFailure(new RpcError(-32602, 'Model exceeds the parent limit or is unranked', reason)),
    { deviceId: 'local', sessionId: 'parent' },
  )
  const [a, b] = createPortPair()
  const time = fakeClock()
  const server = serveChannel(
    a,
    {
      command: async () => {
        throw error
      },
      subscribe: () => () => {},
    },
    { clock: time.clock },
  )
  const client = connectChannel(b)
  try {
    await assert.rejects(
      client.command('session.proposal.accept', {
        deviceId: 'local',
        sessionId: 'parent',
        proposalId: 'p',
      }),
      (failure) => {
        assert.ok(failure instanceof ChannelError)
        assert.equal(failure.text?.key, 'modelRanking.limitExceeded')
        assert.deepEqual(failure.modelLimit?.reason, reason)
        assert.equal(failure.modelLimit?.settings[0]?.kind, 'manager-default-model')
        return true
      },
    )
  } finally {
    client.close()
    server()
  }
})

test('mock 场景覆盖开关、未分级、部分目录失败，建议卡越级保留原卡且不建子会话', async () => {
  assert.equal(sampleModelRanking('custom-local').crossHarness, false)
  assert.equal(sampleModelRanking('custom-cross').crossHarness, true)
  assert.ok(sampleModelRanking('partial').errors.pi)
  assert.ok(sampleModelRanking().unranked.length)
  const clock = fakeClock()
  const core = createMockCore({
    clock: clock.clock,
    chunkMs: 0,
    modelRankingScenario: 'custom-local',
  })
  let view: SessionView | undefined
  const off = core.subscribe(
    { kind: 'session', deviceId: 'local', sessionId: 's6' },
    {
      snapshot: (data) => {
        view = data as SessionView
      },
      delta: () => {},
      error: (failure) => {
        throw failure
      },
    },
  )
  try {
    await settle()
    await core.command(
      'session.send',
      { deviceId: 'local', sessionId: 's6', text: '模型越级建议' },
      new AbortController().signal,
    )
    await settle()
    // 重新订阅读取生成建议后的完整快照。
    const reread = core.subscribe(
      { kind: 'session', deviceId: 'local', sessionId: 's6' },
      {
        snapshot: (data) => {
          view = data as SessionView
        },
        delta: () => {},
        error: (failure) => {
          throw failure
        },
      },
    )
    reread()
    const proposal = view?.proposals.find((row) => row.model === 'anthropic/claude-opus-5-5')
    assert.ok(proposal)
    await assert.rejects(
      core.command(
        'session.proposal.accept',
        { deviceId: 'local', sessionId: 's6', proposalId: proposal.id },
        new AbortController().signal,
      ),
      (failure) => {
        assert.ok(failure instanceof ChannelError)
        assert.equal(failure.modelLimit?.reason.kind, 'exceeded')
        assert.equal(failure.modelLimit?.reason.parent.harness, 'claude-code')
        return true
      },
    )
    assert.equal(proposal.status, 'pending')
    await assert.rejects(
      core.command(
        'session.spawn',
        {
          deviceId: 'local',
          parentId: 's6',
          kind: 'fresh',
          title: 'too high',
          prompt: 'fixture',
          model: 'anthropic/claude-opus-5-5',
          wakeParent: false,
        },
        new AbortController().signal,
      ),
      (failure) =>
        failure instanceof ChannelError && failure.modelLimit?.reason.kind === 'exceeded',
    )
  } finally {
    off()
  }
})

test('真实核心的 spawn 和 accept 都补上父会话设置跳转，拒绝不改变目录', async () => {
  const config = sampleModelRanking('custom-local')
  const parent = rankedModelSelection(config, 'claude-code', 'anthropic/claude-sonnet-5-5')
  const child = rankedModelSelection(config, 'claude-code', 'anthropic/claude-opus-5-5')
  const reason = modelLimitFailure(config, parent, child)!
  const world = deviceWorld(
    [
      harness('claude-code', {
        threads: [thread({ id: 'parent' })],
        declaration: { extensions: ['clientTools'], features: features() },
      }),
    ],
    {
      prepare: (device) => {
        device.extensions.push('sessionTree')
      },
      extra: {
        'litch/session/start': () => {
          throw new RpcFailure(-32602, 'Model exceeds the parent limit or is unranked', reason)
        },
        'litch/sessionProposal/accept': () => {
          throw new RpcFailure(-32602, 'Model exceeds the parent limit or is unranked', reason)
        },
      },
    },
  )
  world.core.start()
  try {
    await settle()
    for (const task of [
      world.command('session.spawn', {
        parentId: 'parent',
        title: 'fixture',
        prompt: 'fixture',
        kind: 'fresh',
        wakeParent: false,
      }),
      world.command('session.proposal.accept', { sessionId: 'parent', proposalId: 'proposal' }),
    ]) {
      await assert.rejects(task, (error) => {
        assert.ok(error instanceof ChannelError)
        assert.deepEqual(error.modelLimit?.reason, reason)
        assert.deepEqual(error.modelLimit?.settings, [
          { kind: 'manager-default-model', deviceId: 'local', sessionId: 'parent' },
          { kind: 'model-ranking', deviceId: 'local' },
        ])
        return true
      })
    }
    assert.equal(world.side.sessions.size, 1)
  } finally {
    world.core.stop()
  }
})
