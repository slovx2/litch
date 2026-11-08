import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import { startChild } from '../src/session-start.mjs'
import { resultOf } from './fake-engine.mjs'
import { brief, text, treeRig, until } from './tree-kit.mjs'
import { makeRepo } from './worktree-kit.mjs'

async function setup(worktree: boolean, depth: number) {
  const env = treeRig()
  const client = env.connect()
  await client.initialize(['harness', 'sessionTree', 'litchManager', 'worktrees'])
  const { threadId: managerId } = await client.call(MANAGER_METHOD.create, {
    cwd: env.stateDir,
    harness: 'pi',
    model: null,
    effort: null,
    name: '测试经理',
    scope: '',
    rules: '',
    template: 'blank',
    firstTask: '',
    dispatch: { ...MANAGER_DEFAULT_DISPATCH, worktree },
    contact: MANAGER_DEFAULT_CONTACT,
  })
  let sourceId = managerId
  for (let level = 0; level < depth; level++) {
    const child = await startChild(
      env.device.sessionTree,
      sourceId,
      {
        title: `第 ${level + 1} 层`,
        ...brief('测试任务'),
        kind: 'fresh',
        wakeParent: false,
        worktree: false,
      },
      'user',
    )
    sourceId = child.threadId
  }
  if (!depth) await client.call('turn/start', { threadId: sourceId, input: text('提出建议') })
  return { env, client, managerId, sourceId }
}

for (const setting of [false, true]) {
  for (const depth of [0, 1, 2]) {
    test(`经理 worktree=${setting}，来源深度 ${depth}：模型参数不改初值，用户可改后在非 Git 目录开始`, async () => {
      const { env, client, sourceId, managerId } = await setup(setting, depth)
      try {
        const tree = env.device.sessionTree
        for (const requested of [undefined, true, false]) {
          const result = resultOf(
            (
              await env.pi.callTool(sourceId, 'litch_sessions', 'start', {
                initiation: 'propose',
                title: `建议 ${String(requested)}`,
                ...brief('检查目录'),
                ...(requested === undefined ? {} : { worktree: requested }),
                wake_parent: false,
              })
            )?.answer,
          )
          const proposalId = result.proposal_id as string
          assert.ok(proposalId)
          const proposal = tree.proposal(proposalId)
          assert.equal(proposal?.worktree, setting)
          assert.equal(proposal?.worktreeDefault, setting)
          const at = env.pi.seen.length
          assert.deepEqual(
            await client.call('litch/sessionProposal/checkWorktree', {
              threadId: sourceId,
              proposalId,
            }),
            { available: false },
          )
          assert.equal(
            env.pi.seen.slice(at).some((r) => r.method === 'thread/start'),
            false,
          )
          // 用户保持关闭，或把经理预选的开改成关：非 Git 目录也可正常开始。
          const accepted = await client.call('litch/sessionProposal/accept', {
            threadId: sourceId,
            proposalId,
            ...(setting ? { overrides: { worktree: false } } : {}),
          })
          assert.equal(tree.lineage(accepted.threadId)?.parentThreadId, managerId)
          assert.equal(env.pi.thread(accepted.threadId).cwd, env.stateDir)
          assert.equal(env.device.worktrees?.forThread(accepted.threadId), null)
          env.pi.end(accepted.threadId)
          await until(() => !tree.isActive(accepted.threadId), '新线结束，释放经理容量')
        }
      } finally {
        env.close()
      }
    })
  }
}

test('用户可把经理关闭的工作树改为开：预检编辑目录，再实际创建新工作树', async () => {
  const { env, client, sourceId } = await setup(false, 1)
  try {
    const repo = makeRepo(env.stateDir)
    const result = resultOf(
      (
        await env.pi.callTool(sourceId, 'litch_sessions', 'start', {
          title: '新工作树',
          ...brief('测试任务'),
          worktree: true,
          wake_parent: false,
        })
      )?.answer,
    )
    const proposalId = result.proposal_id as string
    assert.equal(env.device.sessionTree.proposal(proposalId)?.worktree, false)
    assert.deepEqual(
      await client.call('litch/sessionProposal/checkWorktree', {
        proposalId,
        cwd: repo,
      }),
      { available: true },
    )
    assert.deepEqual(
      await client.call('litch/sessionProposal/checkWorktree', {
        proposalId,
        cwd: '',
      }),
      { available: false },
    )
    const child = await client.call('litch/sessionProposal/accept', {
      proposalId,
      overrides: { cwd: repo, worktree: true },
    })
    assert.ok(env.device.worktrees?.forThread(child.threadId))
  } finally {
    env.close()
  }
})

for (const depth of [0, 1]) {
  test(`offer 来源深度 ${depth}：初值继承经理，用户选择保留到模型补简报`, async () => {
    const { env, client, sourceId } = await setup(true, depth)
    try {
      if (depth) {
        env.pi.end(sourceId)
        await until(() => !env.device.sessionTree.isActive(sourceId), '线空闲')
        await client.call('turn/start', { threadId: sourceId, input: text('新任务') })
      }
      const pending = env.pi.callTool(sourceId, 'litch_sessions', 'start', {
        initiation: 'offer',
        title: '新任务',
      })
      const tree = env.device.sessionTree
      await until(() => tree.proposals(sourceId).some((p) => p.offer), 'offer 卡出现')
      const proposal = tree.proposals(sourceId).find((p) => p.offer)
      assert.ok(proposal)
      assert.equal(proposal.worktree, true)
      assert.equal(proposal.worktreeDefault, true)
      await client.call('litch/sessionProposal/answer', {
        proposalId: proposal.id,
        choice: 'session',
        worktree: false,
      })
      await pending
      const accepted = resultOf(
        (
          await env.pi.callTool(sourceId, 'litch_sessions', 'accept', {
            proposal_id: proposal.id,
            ...brief('新的任务'),
            worktree: true,
          })
        )?.answer,
      )
      assert.equal(typeof accepted.thread_id, 'string')
      assert.equal(env.device.worktrees?.forThread(accepted.thread_id as string), null)
      assert.equal(tree.proposal(proposal.id)?.worktree, false)
    } finally {
      env.close()
    }
  })
}
