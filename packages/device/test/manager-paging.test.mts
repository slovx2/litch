import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Ajv } from 'ajv'
import { MANAGER_DEFAULT_CONTACT, MANAGER_DEFAULT_DISPATCH } from '../../protocol/src/manager.mjs'
import { MANAGER_PAGING_METHOD as METHOD } from '../../protocol/src/manager-paging.mjs'
import { treeRig } from './tree-kit.mjs'

function setup() {
  const env = treeRig()
  const owner = env.device.managers
  owner.store.saveManager({
    id: 'paging',
    threadId: 'paging-thread',
    name: '分页夹具',
    cwd: env.stateDir,
    harness: 'pi',
    model: null,
    effort: null,
    scope: '',
    template: 'blank',
    rules: '',
    dispatch: { ...MANAGER_DEFAULT_DISPATCH },
    contact: { ...MANAGER_DEFAULT_CONTACT },
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    endedAt: null,
    pendingDecisions: 0,
    runningLines: 0,
    latestActivity: null,
  })
  for (let i = 1; i <= 65; i++)
    owner.writer.tool('paging', 'add', {
      kind: 'decision',
      decision: { title: `决策 ${i}`, background: '背景'.repeat(1000) },
    })
  return {
    env,
    owner,
    query: {
      managerId: 'paging',
      kind: 'decision' as const,
      status: 'open',
      order: 'newest' as const,
    },
  }
}

test('分页必须按连接声明；摘要不读全对象、全历史或引擎', async () => {
  const { env, owner } = setup()
  try {
    for (const method of Object.values(METHOD))
      await assert.rejects(
        owner.call(method, { managerId: 'paging' }, true),
        /requires litchManagerPaging/i,
      )
    owner.store.changes = () => {
      throw new Error('禁止全历史')
    }
    owner.store.objects = () => {
      throw new Error('禁止全对象')
    }
    owner.lines.refresh = async () => {
      throw new Error('禁止阻塞引擎读取')
    }
    const summary = owner.paging.summary('paging')
    assert.equal(summary.counts.decision.open, 65)
    assert.equal(summary.initial.entries.length, 30)
    assert.equal(summary.initial.total, 65)
    assert.equal(summary.activities.length, 10)
    assert.ok(
      summary.initial.entries.every(
        (head) => head.preview.length <= 160 && !('background' in head),
      ),
    )
    await owner.call(METHOD.catalog, {}, true, true)
    await owner.call(METHOD.summary, { managerId: 'paging' }, true, true)
  } finally {
    await env.close()
  }
})

test('键集分页保持同秒排序；新建不挤入旧游标，筛选计数与状态对账一致', async () => {
  const { env, owner, query } = setup()
  try {
    const first = owner.paging.queries.page(query)
    assert.ok(first.nextCursor)
    owner.writer.tool('paging', 'add', {
      kind: 'decision',
      decision: { title: '新建', background: '' },
    })
    const second = owner.paging.queries.page({ ...query, cursor: first.nextCursor })
    assert.ok(second.nextCursor)
    const third = owner.paging.queries.page({ ...query, cursor: second.nextCursor })
    assert.equal(third.nextCursor, null)
    const ids = [...first.entries, ...second.entries, ...third.entries].map((head) => head.id)
    assert.equal(new Set(ids).size, 65)
    assert.ok(!ids.includes('D-66'))
    assert.equal(owner.paging.queries.page(query).total, 66)
    assert.throws(
      () => owner.paging.queries.page({ ...query, status: 'answered', cursor: first.nextCursor! }),
      /cursor/i,
    )
    assert.throws(
      () => owner.paging.queries.page({ ...query, managerId: 'other', cursor: first.nextCursor! }),
      /cursor/i,
    )
    for (const limit of [0, 101, 1.5])
      assert.throws(() => owner.paging.queries.page({ ...query, limit }))
    const before = owner.writer.object('paging', 'D-1')
    owner.store.saveObject('paging', { ...before, status: 'answered' } as typeof before)
    assert.equal(owner.paging.queries.page(query).total, 65)
    assert.equal(owner.paging.queries.page({ ...query, status: 'answered' }).total, 1)
    assert.equal(owner.paging.summary('paging').counts.decision.answered, 1)
    const oldest = owner.paging.queries.page({ ...query, status: 'all', order: 'oldest', limit: 1 })
    assert.equal(oldest.entries[0]?.id, 'D-1')
  } finally {
    await env.close()
  }
})

test('详情与对象历史分离，历史按 seq 取页并隔离新增变更', async () => {
  const { env, owner } = setup()
  try {
    for (let i = 0; i < 35; i++) {
      const before = owner.writer.object('paging', 'D-1')
      const after = { ...before, revision: before.revision + 1, title: `修订 ${i}` }
      owner.store.saveObject('paging', after)
      owner.store.record('paging', 'D-1', 'manager', before, after, `变更 ${i}`)
    }
    const detail = owner.paging.detail('paging', 'D-1')
    assert.equal(detail.post?.versions.length, 0)
    assert.equal(detail.object?.revision, 36)
    const first = owner.paging.queries.history('paging', 'D-1')
    assert.equal(first.changes.length, 30)
    assert.ok(first.nextCursor)
    owner.store.record('paging', 'D-1', 'manager', null, detail.object, '游标之后')
    const second = owner.paging.queries.history('paging', 'D-1', first.nextCursor)
    assert.equal(second.changes.length, 6)
    assert.equal(second.nextCursor, null)
    assert.equal(new Set([...first.changes, ...second.changes].map((c) => c.id)).size, 36)
    assert.throws(() => owner.paging.queries.history('paging', 'D-2', first.nextCursor!), /cursor/i)
    assert.throws(() => owner.paging.detail('paging', 'D-999'), /belong/i)
  } finally {
    await env.close()
  }
})

test('新增方法响应符合声明的 JSON schema，工作线失败保留核对时间', async () => {
  const { env, owner, query } = setup()
  try {
    env.device.sessionTree.store.addLineage({
      threadId: 'paging-line',
      parentThreadId: 'paging-thread',
      harness: 'pi',
      kind: 'fresh',
      origin: 'model',
      title: '测试线',
      prompt: '',
      wakeParent: false,
      createdAt: 1,
      proposalId: 'paging-proposal',
    })
    env.device.sessionTree.read = async (id) =>
      ({ thread: { id, status: { type: 'idle' }, cwd: env.stateDir } }) as never
    const definitions = JSON.parse(readFileSync('protocol/extensions/manager.json', 'utf8'))
    const ajv = new Ajv({ strict: false })
    for (const [method, params] of [
      [METHOD.catalog, {}],
      [METHOD.summary, { managerId: 'paging' }],
      [METHOD.page, query],
      [METHOD.detail, { managerId: 'paging', id: 'D-1' }],
      [METHOD.history, { managerId: 'paging', id: 'D-1' }],
      [METHOD.lines, { managerId: 'paging', refresh: true }],
    ] as const) {
      const part = definitions.parts.find((part: { method?: string }) => part.method === method)
      const validate = ajv.compile({ ...part.response, definitions: definitions.definitions })
      const result = await owner.call(method, params, true, true)
      assert.equal(validate(result), true, `${method}: ${JSON.stringify(validate.errors)}`)
    }
    const checked = owner.paging.snapshot('paging')
    assert.ok(checked.checkedAt)
    env.device.sessionTree.read = async () => {
      throw new Error('隔离断线')
    }
    const failed = await owner.paging.lines('paging')
    assert.equal(failed.failed, 1)
    assert.equal(failed.checkedAt, checked.checkedAt)
  } finally {
    await env.close()
  }
})
