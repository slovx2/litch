import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import { MANAGER_PAGING_METHOD } from '../../protocol/src/manager-paging.mjs'
import { startChild } from '../src/session-start.mjs'
import { resultOf } from './fake-engine.mjs'
import { brief, refuseSteer, treeRig, until } from './tree-kit.mjs'

// 真实设备聚合面与隔离 SQLite，只有 harness 使用假引擎。
test('工作线提案：默认看板、审核、两个启动入口、同级归属及并发', async () => {
  const env = treeRig()
  env.pi.handlers['model/list'] = () => ({
    data: [
      {
        id: 'fake',
        model: 'fake',
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
      },
    ],
  })
  try {
    const client = env.connect()
    await client.initialize([
      'harness',
      'sessionTree',
      'litchManager',
      'litchManagerPaging',
      'suggestionInbox',
    ])
    const { manager, threadId } = await client.call(MANAGER_METHOD.create, {
      cwd: env.stateDir,
      harness: 'pi',
      model: 'fake',
      effort: 'high',
      name: '测试经理',
      scope: '',
      rules: '',
      template: 'blank',
      firstTask: '',
      dispatch: { ...MANAGER_DEFAULT_DISPATCH, worktree: false, maxRunningLines: 3 },
      contact: { ...MANAGER_DEFAULT_CONTACT },
    })
    const mobile = env.connect()
    await mobile.initialize(['harness', 'sessionTree', 'litchManager', 'litchManagerPaging'])
    const tree = env.device.sessionTree
    const line = await startChild(
      tree,
      threadId,
      {
        title: '来源工作线',
        ...brief('检查代码'),
        kind: 'fresh',
        wakeParent: false,
        worktree: false,
      },
      'user',
    )
    const propose = async (title: string) => {
      const result = resultOf(
        (
          await env.pi.callTool(line.threadId, 'litch_sessions', 'start', {
            initiation: 'propose',
            title,
            ...brief(title),
            worktree: false,
            wake_parent: false,
          })
        )?.answer,
      )
      assert.equal(typeof result.proposal_id, 'string')
      return result.proposal_id as string
    }
    const first = await propose('看板开始')
    const page = (status: string) =>
      client.call(MANAGER_PAGING_METHOD.page, {
        managerId: manager.id,
        kind: 'suggestion',
        status,
        order: 'newest',
      })
    const initial = await page('pending')
    assert.equal(env.device.managers.paging.summary(manager.id).counts.suggestion.pending, 1)
    assert.equal(env.device.managers.manager(manager.id).pendingSuggestions, 1)
    const phonePage = await mobile.call(MANAGER_PAGING_METHOD.page, {
      managerId: manager.id,
      kind: 'suggestion',
      status: 'pending',
      order: 'newest',
    })
    assert.deepEqual(phonePage.entries, initial.entries)
    const review = await page('review')
    assert.ok(review.entries.some((p: any) => p.id === `S-${first}`))
    const approved = resultOf(
      (
        await env.pi.callTool(threadId, 'litch_manager', 'endorse', {
          proposalId: first,
          reason: '独立任务',
        })
      )?.answer,
    )
    assert.equal(approved.review.state, 'endorsed')
    assert.ok((await page('pending')).entries.some((p: any) => p.id === `S-${first}`))
    const firstChild = await client.call('litch/sessionProposal/accept', {
      proposalId: first,
    })
    const second = await propose('对话卡开始')
    const secondChild = await mobile.call('litch/sessionProposal/accept', {
      threadId: line.threadId,
      proposalId: second,
    })
    const summary = env.device.managers.paging.summary(manager.id)
    const evidence = {
      pendingBeforeReview: initial.entries.map((p: any) => p.id),
      reviewCount: review.total,
      parents: [firstChild, secondChild].map(
        (child) => tree.lineage(child.threadId)?.parentThreadId,
      ),
      managerThread: threadId,
      sourceLine: line.threadId,
      runningLines: summary.manager.runningLines,
    }
    console.log('LINE-CARDS-EVIDENCE', JSON.stringify(evidence))
    assert.ok(initial.entries.some((p: any) => p.id === `S-${first}`))
    assert.deepEqual(evidence.parents, [threadId, threadId])
    for (const child of [firstChild, secondChild]) {
      const input = env.pi.sent('turn/start').find((p) => p.threadId === child.threadId)
        ?.input[0].text
      assert.match(input, /Suggestion source:.*来源工作线/)
      assert.match(input, /started this one: "测试经理"/)
      assert.ok(input.includes(line.threadId))
      assert.ok(input.includes(threadId))
    }
    assert.equal(evidence.runningLines, 3)
    // 第四条线仍等待用户；开始被经理并发门槛拒绝。
    const limited = await propose('超出上限')
    const rejected = await client.fails('litch/sessionProposal/accept', {
      threadId: line.threadId,
      proposalId: limited,
    })
    assert.match(rejected.message, /capacity|limit/i)
    assert.equal(tree.proposal(limited)?.status, 'pending')
    const dismissed = resultOf(
      (
        await env.pi.callTool(threadId, 'litch_manager', 'dismiss', {
          proposalId: limited,
          reason: '暂不需要',
        })
      )?.answer,
    )
    assert.equal(dismissed.review.state, 'dismissed')
    assert.equal(tree.proposal(limited)?.status, 'dismissed')
    // 原提案归属不变；重复点开始仍幂等。
    assert.equal(tree.proposal(first)?.threadId, line.threadId)
    assert.equal(
      (await client.call('litch/sessionProposal/accept', { proposalId: first })).threadId,
      firstChild.threadId,
    )
    await until(() => tree.isActive(secondChild.threadId), '新工作线占槽')
    // 分叉仍继承来源线的上下文；回报对象则是经理。
    const steer = env.pi.handlers['turn/steer']
    refuseSteer(env.pi)
    env.pi.end(firstChild.threadId, 'completed', '检查完成')
    env.pi.end(secondChild.threadId, 'completed', '检查完成')
    await until(
      () => !tree.isActive(firstChild.threadId) && !tree.isActive(secondChild.threadId),
      '释放两个名额',
    )
    const forkProposal = tree.propose({
      threadId: line.threadId,
      title: '保留来源上下文',
      prompt: '检查',
      kind: 'fork',
      harness: 'pi',
      model: null,
      cwd: env.stateDir,
      wakeParent: false,
      worktree: false,
    })
    const fork = await client.call('litch/sessionProposal/accept', { proposalId: forkProposal.id })
    assert.equal(env.pi.sent('thread/fork').at(-1)?.threadId, line.threadId)
    assert.equal(tree.lineage(fork.threadId)?.parentThreadId, threadId)
    await until(
      () => tree.store.notes(threadId).some((note) => note.threadId === firstChild.threadId),
      '回报给经理',
    )
    assert.equal(
      tree.store.notes(line.threadId).some((note) => note.threadId === firstChild.threadId),
      false,
    )
    if (steer) env.pi.handlers['turn/steer'] = steer
    // 普通会话不改归属；已存在的嵌套线也不迁移。
    const ordinary = await client.call('thread/start', { harness: 'pi', cwd: env.stateDir })
    const ordinaryProposal = tree.propose({
      ...forkProposal,
      threadId: ordinary.thread.id,
      kind: 'fresh',
      title: '普通建议',
    })
    const child = await client.call('litch/sessionProposal/accept', {
      proposalId: ordinaryProposal.id,
    })
    assert.equal(tree.lineage(child.threadId)?.parentThreadId, ordinary.thread.id)
    const nested = await startChild(
      tree,
      line.threadId,
      { title: '已嵌套的线', prompt: '检查', kind: 'fresh', worktree: false, wakeParent: false },
      'user',
    )
    assert.equal(tree.lineage(nested.threadId)?.parentThreadId, line.threadId)
    env.pi.end(fork.threadId)
    await until(() => !tree.isActive(fork.threadId), '释放分叉名额')
    const deep = await startChild(
      tree,
      nested.threadId,
      {
        title: '历史第三层工作线',
        prompt: '检查',
        kind: 'fresh',
        worktree: false,
        wakeParent: false,
      },
      'user',
    )
    env.pi.end(line.threadId)
    env.pi.end(nested.threadId)
    await until(
      () => !tree.isActive(line.threadId) && !tree.isActive(nested.threadId),
      '历史来源线空闲',
    )
    const deepProposal = resultOf(
      (
        await env.pi.callTool(deep.threadId, 'litch_sessions', 'start', {
          initiation: 'propose',
          title: '来自第三层的建议',
          ...brief('独立修复'),
          worktree: false,
          wake_parent: false,
        })
      )?.answer,
    ).proposal_id
    const sibling = await client.call('litch/sessionProposal/accept', { proposalId: deepProposal })
    assert.equal(tree.lineage(sibling.threadId)?.parentThreadId, threadId)
    assert.equal(tree.lineage(deep.threadId)?.parentThreadId, nested.threadId)
    const fromLine = resultOf(
      (
        await env.pi.callTool(sibling.threadId, 'litch_sessions', 'send', {
          thread_id: threadId,
          message: '直接汇报经理',
        })
      )?.answer,
    )
    assert.equal(fromLine.thread_id, threadId)
    const fromManager = resultOf(
      (
        await env.pi.callTool(threadId, 'litch_sessions', 'send', {
          thread_id: sibling.threadId,
          message: '经理直接回复',
        })
      )?.answer,
    )
    assert.equal(fromManager.thread_id, sibling.threadId)
    env.pi.end(deep.threadId)
    await until(() => !tree.isActive(deep.threadId), '提卡来源停止')
    await client.call('thread/archive', { threadId: deep.threadId })
    assert.equal(Boolean(env.pi.thread(sibling.threadId).archived), false)
    assert.equal(tree.isActive(sibling.threadId), true)
  } finally {
    await env.close()
  }
})
