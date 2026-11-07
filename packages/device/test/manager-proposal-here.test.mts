import assert from 'node:assert/strict'
import test from 'node:test'
import { MANAGER_DEFAULT_CONTACT, MANAGER_DEFAULT_DISPATCH } from '../../protocol/src/manager.mjs'
import { startChild } from '../src/session-start.mjs'
import { got, litch, parent, plain, treeRig, until } from './tree-kit.mjs'

test('经理卡在列表、增量和建议收件箱标明来源；新旧客户端的 here/markHere 均拒绝且不结算', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const old = await plain(env)
    const { threadId } = await parent(client)
    const tree = env.device.sessionTree
    env.device.managers.store.saveManager({
      id: 'manager',
      threadId,
      name: '经理',
      cwd: env.stateDir,
      harness: 'pi',
      model: null,
      effort: null,
      scope: '',
      template: 'blank',
      rules: '',
      dispatch: { ...MANAGER_DEFAULT_DISPATCH, worktree: false },
      contact: { ...MANAGER_DEFAULT_CONTACT },
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
      endedAt: null,
      pendingDecisions: 0,
      runningLines: 0,
      latestActivity: null,
    })
    const propose = (source: string) =>
      tree.propose({
        threadId: source,
        title: '整理代码',
        prompt: '完成独立任务',
        harness: 'pi',
        model: null,
        cwd: env.stateDir,
        kind: 'fresh',
        wakeParent: false,
      })
    const p = propose(threadId)
    await until(
      () =>
        got(client, 'litch/sessionProposal/changed').some((note) =>
          note.changed?.some((entry: any) => entry.id === p.id && entry.sourceIsManager === true),
        ),
      '经理提案增量带来源限制',
    )
    const listed = await client.call('litch/sessionProposal/list', { threadId })
    assert.equal(listed.proposals[0].sourceIsManager, true)
    assert.equal(
      (await tree.suggestions.list()).suggestions.find((s) => s.proposal.id === p.id)?.proposal
        .sourceIsManager,
      true,
    )
    const sent = env.pi.sent('turn/start').length
    for (const connection of [client, old]) {
      for (const action of ['here', 'markHere']) {
        const failure = await connection.fails(`litch/sessionProposal/${action}`, {
          proposalId: p.id,
          ...(connection === client ? { threadId } : {}),
          sourceIsManager: false,
        })
        assert.equal(failure.code, -32602)
        assert.match(failure.message, /经理.*开始.*工作线.*忽略/)
        assert.equal(tree.proposal(p.id)?.status, 'pending')
      }
    }
    assert.equal(env.pi.sent('turn/start').length, sent)
    assert.throws(() => tree.proposalHere(p.id, undefined, false), /经理/)
    const offer = tree.propose({ ...p, offer: true, title: '另开一条线' })
    const rejectedOffer = await client.fails('litch/sessionProposal/answer', {
      proposalId: offer.id,
      choice: 'here',
    })
    assert.match(rejectedOffer.message, /经理.*工作线/)
    assert.equal(tree.proposal(offer.id)?.status, 'offered')
    // 经理下面的工作线仍是普通提议者，不能按 managerId 一概禁止。
    const line = await startChild(
      tree,
      threadId,
      {
        title: '工作线',
        prompt: '检查',
        kind: 'fresh',
        worktree: false,
        wakeParent: false,
      },
      'model',
    )
    const lineCard = propose(line.threadId)
    assert.equal(tree.proposal(lineCard.id)?.sourceIsManager, false)
    assert.match(tree.proposalHere(lineCard.id, undefined, false), /整理代码/)
    const ordinary = await parent(client, false)
    const normalCard = propose(ordinary.threadId)
    const params = { threadId: ordinary.threadId, proposalId: normalCard.id }
    const marked = await client.call('litch/sessionProposal/markHere', params)
    assert.match(marked.text, /整理代码/)
    assert.deepEqual(await client.call('litch/sessionProposal/markHere', params), marked)
    assert.equal(tree.proposal(normalCard.id)?.status, 'here')
    // 经理的卡仍可忽略，也可正常开始新线。
    await client.call('litch/sessionProposal/dismiss', { threadId, proposalId: p.id })
    const next = propose(threadId)
    const started = await client.call('litch/sessionProposal/accept', {
      threadId,
      proposalId: next.id,
    })
    assert.notEqual(started.threadId, threadId)
    assert.equal(tree.proposal(next.id)?.status, 'started')
  } finally {
    await env.close()
  }
})
