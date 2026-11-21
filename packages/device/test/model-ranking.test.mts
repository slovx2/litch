import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionTools } from '../../protocol/src/client-tools-sessions.mjs'
import { EXTENSION } from '../../protocol/src/device.mjs'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import {
  builtinTier,
  emptyRanking,
  MODEL_RANKING,
  modelKey,
} from '../../protocol/src/model-ranking.mjs'
import { checkChildModel, rankedModel } from '../src/model-ranking.mjs'
import { startChild } from '../src/session-start.mjs'
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
    await checkChildModel(tree, 'claude-code', 'sonnet', 'claude-code', null, true),
    'opus',
    '用户确认的默认型号也须先解析，不能被无关父模型挡住',
  )
  await assert.rejects(
    checkChildModel(tree, 'claude-code', 'sonnet', 'claude-code', null),
    /limit/,
    '模型自行沿用默认仍受父模型上限约束',
  )
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
  const env = treeRig({}, { modelRankingEnabled: true })
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

test('暂停排序时旧客户端读不到等级，已存配置不影响目录、默认值或派发', async () => {
  const env = treeRig({}, { values: {} })
  try {
    assert.ok(env.control)
    const ranking = {
      ...emptyRanking(),
      mode: 'custom' as const,
      revision: 8,
      crossHarness: true,
      tiers: [
        [modelKey('pi', 'pi-model')],
        [modelKey('claude-code', 'opus', 'account')],
        [modelKey('claude-code', 'fable', 'account')],
      ],
    }
    env.control.ranking = structuredClone(ranking)
    // 目录顺序故意与存下来的等级相反；默认型号也不在目录第一项。
    const catalog = [rows[2], rows[0], rows[1]]
    env.claude.handlers['model/list'] = () => ({ data: catalog, nextCursor: null })
    Object.assign(env.pi.config, { model: 'pi-model' })
    Object.assign(env.claude.config, { model: 'opus' })
    const client = env.connect()
    await client.initialize(['harness', 'sessionTree', EXTENSION.modelRanking])
    const info = await client.call('runtime/info', {})
    assert.ok(!info.device.extensions.includes(EXTENSION.modelRanking))
    await assert.rejects(client.call(MODEL_RANKING.read, {}), {
      message: 'Model ranking unavailable',
      data: { litch: 'unsupported' },
    })
    assert.deepEqual((await client.call('model/list', { harness: 'claude-code' })).data, catalog)

    const { thread } = await client.call('thread/start', { harness: 'pi', cwd: env.stateDir })
    const tree = env.device.sessionTree
    for (const model of ['fable', null]) {
      const started = await startChild(
        tree,
        thread.id,
        {
          title: '跨 harness 派发',
          prompt: '运行夹具',
          kind: 'fresh',
          harness: 'claude-code',
          model,
          wakeParent: false,
          worktree: false,
        },
        'model',
      )
      assert.ok(started.threadId)
      assert.equal(env.claude.sent('thread/start').at(-1)?.model, model ?? undefined)
      assert.ok(
        env.claude.sent('turn/start').some((params) => params.threadId === started.threadId),
      )
    }
    assert.deepEqual(env.control.ranking, ranking)
    assert.ok(!env.control.requests.some(({ method }) => method.startsWith('modelRanking.')))
  } finally {
    await env.close()
  }
})

test('经理的跨 harness 工作线再派同 harness 子会话时，省略模型仍用目标默认', async () => {
  const env = treeRig()
  try {
    env.claude.handlers['model/list'] = () => ({ data: rows, nextCursor: null })
    Object.assign(env.claude.config, { model: 'fable' })
    const client = env.connect()
    await client.initialize(['harness', 'sessionTree', 'litchManager'])
    const { threadId } = await client.call(MANAGER_METHOD.create, {
      cwd: env.stateDir,
      harness: 'pi',
      model: null,
      effort: null,
      name: '经理',
      scope: '',
      rules: '',
      template: 'blank',
      firstTask: '',
      dispatch: { ...MANAGER_DEFAULT_DISPATCH, harness: 'claude-code', worktree: false },
      contact: { ...MANAGER_DEFAULT_CONTACT },
    })
    const tree = env.device.sessionTree
    const spec = {
      title: '测试跨 harness 派发',
      prompt: '运行夹具',
      kind: 'fresh' as const,
      harness: 'claude-code',
      wakeParent: false,
      worktree: false,
    }
    const line = await startChild(tree, threadId, { ...spec, model: 'fable' }, 'user')
    assert.equal(env.claude.sent('thread/start').at(-1)?.model, 'fable')
    assert.ok(env.claude.sent('turn/start').some((params) => params.threadId === line.threadId))
    await startChild(tree, line.threadId, spec, 'model')
    assert.equal(env.claude.sent('thread/start').at(-1)?.model, undefined)
  } finally {
    await env.close()
  }
})

test('收尾建议仍说明默认模型，但不把已暂停的等级限制交给模型', () => {
  const wrapUp = sessionTools(true).tools.find((tool) => tool.name === 'wrap_up')
  assert.ok(wrapUp)
  const schema = JSON.stringify(wrapUp.inputSchema)
  assert.match(schema, /target harness’s default when the harness differs/)
  assert.doesNotMatch(schema, /parent model rank|over-limit start|custom device ranking/)
})

test('等级设置声明门禁、设备持久配置、通知只发给声明连接', async () => {
  const env = treeRig({}, { values: {}, modelRankingEnabled: true })
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
  const env = treeRig({}, { modelRankingEnabled: true })
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
