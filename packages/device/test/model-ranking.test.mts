import assert from 'node:assert/strict'
import test from 'node:test'
import { builtinTier, emptyRanking, modelKey } from '../../protocol/src/model-ranking.mjs'
import { checkChildModel, rankedModel } from '../src/model-ranking.mjs'
import type { SessionTree } from '../src/session-tree.mjs'
import { resultOf } from './fake-engine.mjs'
import { brief, litch, SESSIONS, text, treeRig } from './tree-kit.mjs'

const rows = ['sonnet', 'opus', 'fable'].map((id) => ({
  id,
  model: id,
  displayName: id,
  isDefault: id === 'opus',
  litchModelIdentity: { provider: 'account', resolved: `claude-${id}-5`, trusted: true },
}))
function mockTree(custom = false, crossHarness = custom) {
  return {
    host: {
      modelRanking: async () => ({
        ...emptyRanking(),
        mode: custom ? 'custom' : 'builtin',
        crossHarness,
        tiers: [[modelKey('claude-code', 'opus')], [modelKey('codex', 'gpt-6-astra')]],
        models: [],
      }),
    },
    link: async (harness: string) => ({
      request: async () => ({
        data:
          harness === 'codex'
            ? [{ id: 'gpt-6-astra', model: 'gpt-6-astra', isDefault: true }]
            : rows,
      }),
    }),
  } as unknown as SessionTree
}
test('有效身份、缺省型号、跨引擎自定义与仅用户选择例外', async () => {
  const tree = mockTree()
  await assert.rejects(
    checkChildModel(tree, 'claude-code', 'opus', 'claude-code', 'fable'),
    /Allowed models:.*opus/,
  )
  assert.equal(
    await checkChildModel(tree, 'claude-code', 'opus', 'claude-code', 'sonnet'),
    'sonnet',
  )
  assert.equal(await checkChildModel(tree, 'claude-code', 'opus', 'claude-code', null), 'opus')
  assert.equal(
    await checkChildModel(tree, 'claude-code', 'opus', 'claude-code', 'fable', true),
    'fable',
  )
  await assert.rejects(
    checkChildModel(tree, 'claude-code', 'opus', 'claude-code', 'invented', true),
    /unranked/,
  )
  assert.equal(
    await checkChildModel(tree, 'claude-code', 'opus', 'codex', 'gpt-6-astra'),
    'gpt-6-astra',
  )
  await assert.rejects(
    checkChildModel(mockTree(true), 'claude-code', 'opus', 'codex', 'gpt-6-astra'),
    /limit/,
  )
})

test('custom 关闭跨 harness 时不读对方目录，未分级父子也不会阻塞跨 harness', async () => {
  for (const parent of ['opus', 'unranked-parent']) {
    for (const child of ['gpt-6-astra', 'unranked-child']) {
      const tree = mockTree(true, false)
      tree.link = async () => {
        throw Error('跨 harness 放行不需要读取目录')
      }
      assert.equal(await checkChildModel(tree, 'claude-code', parent, 'codex', child), child)
    }
  }
  await assert.rejects(
    checkChildModel(mockTree(false, false), 'claude-code', 'opus', 'claude-code', 'fable'),
    (error) => {
      const failure = error as Error & {
        data: import('../../protocol/src/model-ranking.mjs').ModelLimitFailure
      }
      assert.equal(failure.data.kind, 'exceeded')
      assert.equal(failure.data.parent.model, 'opus')
      assert.equal(failure.data.child.model, 'fable')
      assert.equal(failure.data.crossHarness, false)
      assert.ok(failure.data.allowed.some((row) => row.model === 'sonnet'))
      return true
    },
  )
  await assert.rejects(
    checkChildModel(mockTree(false, false), 'claude-code', 'unknown', 'claude-code', 'opus'),
    (error) => {
      assert.equal((error as { data: { kind: string } }).data.kind, 'unranked')
      return true
    },
  )
})
test('设备入口：工具拒绝、普通卡开始拒绝、实际用户选择放行且权限仍检查', async () => {
  const env = treeRig()
  try {
    env.claude.handlers['model/list'] = () => ({ data: rows, nextCursor: null })
    Object.assign(env.claude.config, { model: 'opus' })
    // 假引擎创建应答反映实际选择，恢复父仍由 config 给出 opus。
    const start = env.claude.handlers['thread/start']!
    env.claude.handlers['thread/start'] = (p, c) => ({
      ...(start(p, c) as Record<string, unknown>),
      model: p.model ?? 'opus',
    })
    const client = await litch(env)
    const { thread } = await client.call('thread/start', {
      harness: 'claude-code',
      cwd: '/work/app',
    })
    await client.call('turn/start', { threadId: thread.id, input: text('派子会话') })
    const tool = async (name: string, args: object) =>
      resultOf((await env.claude.callTool(thread.id, SESSIONS, name, args))?.answer)
    const count = env.claude.sent('thread/start').length
    await assert.rejects(
      tool('start', {
        title: '高档',
        ...brief('检查'),
        model: 'fable',
        initiation: 'user_asked',
        modelSelected: true,
      }),
      /limit|上限/,
    )
    assert.equal(env.claude.sent('thread/start').length, count)
    const proposed = await tool('start', {
      title: '高档提案',
      ...brief('检查'),
      model: 'fable',
      initiation: 'propose',
    })
    const id = proposed.proposal_id as string
    assert.ok(id)
    await assert.rejects(
      client.call('litch/sessionProposal/accept', { proposalId: id }),
      (error) => {
        const data = (
          error as { data: import('../../protocol/src/model-ranking.mjs').ModelLimitFailure }
        ).data
        assert.equal(data.litch, 'model_cap_exceeded')
        assert.equal(data.parent.model, 'opus')
        assert.equal(data.child.model, 'fable')
        assert.deepEqual(data.allowedModels, ['sonnet', 'opus'])
        return true
      },
    )
    const raw = (await env.claude.callTool(thread.id, SESSIONS, 'accept', { proposal_id: id }))
      ?.answer
    assert.ok(JSON.stringify(raw).includes('modelLimit'))
    assert.ok(JSON.stringify(raw).includes('model_cap_exceeded'))
    assert.equal(env.claude.sent('thread/start').length, count)
    await assert.rejects(
      client.call('litch/sessionProposal/accept', {
        proposalId: id,
        overrides: { model: 'fable', modelSelected: true, permission: ':danger-full-access' },
      }),
      { message: /permission/ },
    )
    const accepted = await client.call('litch/sessionProposal/accept', {
      proposalId: id,
      overrides: { model: 'fable', modelSelected: true },
    })
    assert.ok(accepted.threadId)
    assert.equal(env.claude.sent('thread/start').at(-1)?.model, 'fable')
  } finally {
    env.close()
  }
})

test('等级设置声明门禁、设备持久配置、通知只发给声明连接', async () => {
  const env = treeRig({}, { values: {} })
  try {
    env.claude.handlers['model/list'] = () => ({ data: rows, nextCursor: null })
    const plain = await litch(env)
    await assert.rejects(plain.call('litch/device/modelRanking/read', {}), {
      message: /modelRanking/,
    })
    const user = env.connect()
    await user.initialize(['harness', 'sessionTree', 'modelRanking'])
    const snapshot = await user.call('litch/device/modelRanking/read', {})
    assert.equal(snapshot.mode, 'builtin')
    assert.equal(snapshot.crossHarness, false)
    assert.ok(snapshot.models.length)
    const saved = await user.call('litch/device/modelRanking/write', {
      expectedRevision: snapshot.revision,
      crossHarness: true,
      tiers: [snapshot.models.map((row: any) => row.key)],
      unranked: [],
      models: snapshot.models,
    })
    assert.equal(saved.mode, 'custom')
    assert.equal(saved.crossHarness, true)
    assert.ok(saved.revision > snapshot.revision)
    assert.equal(env.control?.ranking.mode, 'custom')
    await assert.rejects(
      user.call('litch/device/modelRanking/reset', { expectedRevision: snapshot.revision }),
      { message: /changed/ },
    )
    assert.equal(
      plain.notifications.some((note) => note.method === 'litch/device/modelRanking/changed'),
      false,
    )
    const restored = await user.call('litch/device/modelRanking/reset', {
      expectedRevision: saved.revision,
    })
    assert.equal(restored.mode, 'builtin')
    assert.equal(restored.crossHarness, false)
  } finally {
    env.close()
  }
})

test('引擎创建后确认了超限型号，不发送第一个任务', async () => {
  const env = treeRig()
  try {
    env.claude.handlers['model/list'] = () => ({ data: rows, nextCursor: null })
    Object.assign(env.claude.config, { model: 'opus' })
    const client = await litch(env)
    const { thread } = await client.call('thread/start', {
      harness: 'claude-code',
      cwd: '/work/app',
    })
    const start = env.claude.handlers['thread/start']!
    env.claude.handlers['thread/start'] = (p, c) => ({
      ...(start(p, c) as Record<string, unknown>),
      model: 'fable',
    })
    const before = env.claude.sent('turn/start').length
    await assert.rejects(
      client.call('litch/session/start', {
        parentThreadId: thread.id,
        kind: 'fresh',
        title: '检查',
        prompt: '检查',
        model: 'sonnet',
        wakeParent: false,
      }),
      { message: /created|父会话|parent/ },
    )
    assert.equal(env.claude.sent('turn/start').length, before)
  } finally {
    env.close()
  }
})

test('供应商前缀变化不改变已解析身份；残缺身份不得借用官方家族等级', () => {
  const base = {
    id: 'opus',
    alias: 'opus',
    name: 'Opus',
    hidden: false,
    isDefault: false,
    efforts: [],
    defaultEffort: null,
  }
  const identity = { provider: 'account', resolved: 'claude-opus-5-5', trusted: true }
  const plain = rankedModel('claude-code', 'opus', { ...base, identity })
  const qualified = rankedModel('claude-code', 'account/opus', {
    ...base,
    id: 'account/opus',
    identity,
  })
  assert.equal(plain.key, qualified.key)
  assert.equal(builtinTier(plain), 2)
  const incomplete = rankedModel('claude-code', 'opus', { ...base, identity: { trusted: false } })
  assert.equal(incomplete.provider, 'unknown')
  assert.equal(builtinTier(incomplete), null)
})
