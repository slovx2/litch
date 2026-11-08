import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import {
  SUGGESTION_NEVER,
  SUGGESTION_RETENTION_SETTING,
  SUGGESTIONS_CHANGED,
  SUGGESTIONS_LIST,
} from '../../protocol/src/suggestion-inbox.mjs'
import { startChild } from '../src/session-start.mjs'
import { RpcFailure } from './fake-upstream.mjs'
import { got, parent, plain, TREE, treeRig, until } from './tree-kit.mjs'

async function setup(values?: Record<string, unknown>) {
  const env = treeRig({}, values ? { values } : {})
  const client = env.connect()
  await client.initialize([...TREE, 'suggestionInbox', 'litchManager', 'litchManagerPaging'])
  const { threadId } = await parent(client, false)
  const tree = env.device.sessionTree
  const propose = (source = threadId, offer = false) =>
    tree.propose({
      threadId: source,
      title: '检查边界',
      prompt: '验证数据来源',
      background:
        '这是一条隔离环境中的后续检查建议，任务仅在临时目录执行，不访问个人配置，不修改真实项目，也不执行任何发布。请核对当前样例并汇报结果。',
      harness: null,
      model: null,
      cwd: null,
      kind: 'fresh',
      wakeParent: true,
      offer,
    })
  return { env, client, threadId, tree, propose }
}

test('建议快照和增量：过滤 offer，逐连接声明隔离，处理后移除', async () => {
  const { env, client, tree, propose } = await setup()
  try {
    const other = await plain(env)
    assert.equal((await other.fails(SUGGESTIONS_LIST, {})).data?.litch, 'extensionRequired')
    assert.ok((await client.call('runtime/info', {})).device.extensions.includes('suggestionInbox'))
    const p = propose()
    propose(undefined, true)
    const result = await client.call(SUGGESTIONS_LIST, {})
    assert.deepEqual(
      result.suggestions.map((r: any) => r.proposal.id),
      [p.id],
    )
    assert.equal(result.suggestions[0].source.cwd, '/work/app')
    assert.equal(result.suggestions[0].source.archived, false)
    await until(
      () =>
        got(client, SUGGESTIONS_CHANGED).some((n) =>
          n.upserts.some((r: any) => r.proposal.id === p.id),
        ),
      '新建议增量',
    )
    tree.settleProposal(p.id, 'dismissed', null)
    await until(
      () => got(client, SUGGESTIONS_CHANGED).some((n) => n.removed.includes(p.id)),
      '处理移除',
    )
    assert.deepEqual((await client.call(SUGGESTIONS_LIST, {})).suggestions, [])
    assert.equal(got(other, SUGGESTIONS_CHANGED).length, 0)
  } finally {
    await env.close()
  }
})

test('留存从创建时间重算；缩短立即过期，不过期及延长不复活已了结卡', async () => {
  const { env, client, tree, propose } = await setup({ [SUGGESTION_RETENTION_SETTING]: '7' })
  try {
    const p = propose()
    const old = tree.store.addProposal({
      ...p,
      id: 'old',
      createdAt: p.createdAt - 2 * 86_400,
      expiresAt: p.createdAt + 5 * 86_400,
    })
    await client.call(SUGGESTIONS_LIST, {})
    env.control?.patch({ values: { [SUGGESTION_RETENTION_SETTING]: '1' } })
    assert.equal(tree.proposal(old.id)?.status, 'expired')
    assert.equal(tree.proposal(p.id)?.expiresAt, p.createdAt + 86_400)
    env.control?.patch({ values: { [SUGGESTION_RETENTION_SETTING]: 'never' } })
    assert.equal(tree.proposal(p.id)?.expiresAt, SUGGESTION_NEVER)
    assert.equal(tree.proposal(old.id)?.status, 'expired')
    env.control?.patch({ values: { [SUGGESTION_RETENTION_SETTING]: '30' } })
    assert.equal(tree.proposal(p.id)?.expiresAt, p.createdAt + 30 * 86_400)
  } finally {
    await env.close()
  }
})

test('归档保留标记；在来源执行前恢复，失败保留卡；删除撤回', async () => {
  const { env, client, threadId, tree, propose } = await setup()
  try {
    const p = propose()
    await client.call('thread/archive', { threadId })
    const archived = await client.call(SUGGESTIONS_LIST, {})
    assert.equal(archived.suggestions[0].source.archived, true)
    await until(
      () =>
        got(client, SUGGESTIONS_CHANGED).some((n) => n.upserts.some((r: any) => r.source.archived)),
      '归档增量',
    )
    env.pi.handlers['thread/unarchive'] = () => {
      throw new RpcFailure(-32602, '恢复失败')
    }
    assert.equal(
      (await client.fails('litch/sessionProposal/markHere', { threadId, proposalId: p.id }))
        .message,
      '恢复失败',
    )
    assert.equal(tree.proposal(p.id)?.status, 'pending')
    env.pi.handlers['thread/unarchive'] = () => ({})
    await client.call('litch/sessionProposal/markHere', { threadId, proposalId: p.id })
    assert.equal(tree.host.index.archived(threadId), false)
    assert.equal(tree.proposal(p.id)?.status, 'here')
    const next = propose()
    tree.deleted(threadId)
    assert.equal(tree.proposal(next.id)?.status, 'withdrawn')
    assert.deepEqual((await client.call(SUGGESTIONS_LIST, {})).suggestions, [])
  } finally {
    await env.close()
  }
})

test('经理筛选归属覆盖工作线的子孙，脱离后移除归属', async () => {
  const { env, client, tree, propose } = await setup()
  try {
    const { manager } = await client.call(MANAGER_METHOD.create, {
      cwd: env.stateDir,
      harness: 'pi',
      model: null,
      effort: null,
      name: '经理',
      scope: '',
      template: 'blank',
      rules: '',
      firstTask: '',
      dispatch: { ...MANAGER_DEFAULT_DISPATCH, worktree: false },
      contact: { ...MANAGER_DEFAULT_CONTACT },
    })
    const line = await startChild(
      tree,
      manager.threadId,
      { kind: 'fresh', title: '工作线', prompt: '检查', worktree: false, wakeParent: false },
      'user',
    )
    const child = await startChild(
      tree,
      line.threadId,
      { kind: 'fresh', title: '子线', prompt: '检查', worktree: false, wakeParent: false },
      'user',
    )
    const p = propose(child.threadId)
    const own = propose(manager.threadId)
    assert.equal(
      (await client.call(SUGGESTIONS_LIST, {})).suggestions.find(
        (r: any) => r.proposal.id === own.id,
      )?.managerId,
      manager.id,
    )
    const find = async () =>
      (await client.call(SUGGESTIONS_LIST, {})).suggestions.find((r: any) => r.proposal.id === p.id)
    assert.equal((await find()).managerId, manager.id)
    assert.equal((await find()).managerReview.state, 'pending')
    const ownRow = (await client.call(SUGGESTIONS_LIST, {})).suggestions.find(
      (r: any) => r.proposal.id === own.id,
    )
    assert.equal(ownRow.managerReview.state, 'endorsed')
    const endorse = await env.pi.callTool(manager.threadId, 'litch_manager', 'endorse', {
      proposalId: p.id,
      reason: '值得执行',
    })
    assert.equal(endorse?.answer.result.success, true)
    assert.equal((await find()).managerReview.state, 'endorsed')
    assert.equal(env.device.managers.store.suggestionReview(manager.id, p.id)?.reason, '值得执行')
    const ignored = propose(child.threadId)
    const dismiss = await env.pi.callTool(manager.threadId, 'litch_manager', 'dismiss', {
      proposalId: ignored.id,
      reason: '范围重复',
    })
    assert.equal(dismiss?.answer.result.success, true)
    assert.equal(tree.store.proposal(ignored.id)?.status, 'dismissed')
    assert.equal(
      env.device.managers.store.suggestionReview(manager.id, ignored.id)?.state,
      'dismissed',
    )
    assert.ok(
      env.device.managers.store
        .changes(manager.id)
        .some((change) => change.why.includes('经理忽略') && change.why.includes('范围重复')),
    )
    const foreign = propose()
    const refused = await env.pi.callTool(manager.threadId, 'litch_manager', 'endorse', {
      proposalId: foreign.id,
    })
    assert.equal(refused?.answer.result.success, false)
    const unreviewed = propose(child.threadId)
    const started = await client.call('litch/sessionProposal/accept', { proposalId: unreviewed.id })
    assert.equal(tree.store.proposal(unreviewed.id)?.status, 'started')
    assert.equal(env.device.managers.lines.managerFor(started.threadId)?.id, manager.id)

    tree.detach(line.threadId)
    assert.equal((await find()).managerId, null)
  } finally {
    await env.close()
  }
})
