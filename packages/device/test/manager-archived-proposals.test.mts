import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import { startChild } from '../src/session-start.mjs'
import { RpcFailure } from './fake-upstream.mjs'
import { litch, parent, treeRig, until } from './tree-kit.mjs'
import { makeRepo } from './worktree-kit.mjs'

for (const edit of [false, true]) {
  test(`已归档工作线的建议${edit ? '编辑后开始' : '开始'}：只用简报建经理直属新工作树，不恢复或分叉来源`, async () => {
    const env = treeRig()
    try {
      const cwd = makeRepo(env.stateDir)
      const client = env.connect()
      await client.initialize(['harness', 'sessionTree', 'litchManager', 'worktrees'])
      const { threadId } = await client.call(MANAGER_METHOD.create, {
        cwd,
        harness: 'pi',
        model: null,
        effort: null,
        name: '测试经理',
        scope: '',
        rules: '',
        template: 'blank',
        firstTask: '',
        dispatch: { ...MANAGER_DEFAULT_DISPATCH, worktree: false },
        contact: { ...MANAGER_DEFAULT_CONTACT },
      })
      const tree = env.device.sessionTree
      const source = await startChild(
        tree,
        threadId,
        {
          title: '已归档来源',
          prompt: '先前的工作',
          kind: 'fresh',
          wakeParent: false,
          worktree: false,
        },
        'user',
      )
      const proposal = tree.propose({
        threadId: source.threadId,
        title: '待执行建议',
        prompt: '卡片任务',
        background: '卡片背景',
        kind: edit ? 'fork' : 'fresh',
        harness: 'pi',
        model: null,
        cwd,
        wakeParent: false,
        worktree: true,
      })
      env.pi.end(source.threadId)
      await until(() => !tree.isActive(source.threadId), '来源停止')
      await client.call('thread/archive', { threadId: source.threadId })
      // 模拟原生 Codex：归档会话拒绝 resume，而不是像宽松假引擎一样放行。
      const resume = env.pi.handlers['thread/resume']
      assert.ok(resume)
      env.pi.handlers['thread/resume'] = (params, connection) => {
        if (env.pi.thread(params.threadId).archived)
          throw new RpcFailure(
            -32600,
            `session ${params.threadId} is archived. Run \`codex unarchive ${params.threadId}\` to unarchive it first.`,
          )
        return resume(params, connection)
      }
      const at = env.pi.seen.length
      const accepted = await client.call('litch/sessionProposal/accept', {
        threadId: source.threadId,
        proposalId: proposal.id,
        ...(edit
          ? {
              overrides: {
                title: '编辑后标题',
                background: '编辑后背景',
                prompt: '编辑后任务',
                kind: 'fork',
                worktree: true,
              },
            }
          : {}),
      })
      assert.equal(tree.lineage(accepted.threadId)?.parentThreadId, threadId)
      assert.equal(tree.lineage(accepted.threadId)?.kind, 'fresh')
      assert.ok(env.device.worktrees?.forThread(accepted.threadId))
      assert.equal(tree.host.index.archived(source.threadId), true)
      assert.equal(tree.proposal(proposal.id)?.threadId, source.threadId)
      assert.equal(tree.proposal(proposal.id)?.status, 'started')
      assert.equal(
        env.pi.seen
          .slice(at)
          .some(
            (request) =>
              ['thread/resume', 'thread/fork', 'thread/unarchive'].includes(request.method) &&
              request.params.threadId === source.threadId,
          ),
        false,
      )
      const input = env.pi.sent('turn/start').find((p) => p.threadId === accepted.threadId)
        ?.input[0].text
      assert.match(input, /started this one: "测试经理"/)
      assert.match(input, /Suggestion source: "已归档来源"/)
      assert.ok(input.includes(edit ? '编辑后背景' : '卡片背景'))
      assert.ok(input.includes(edit ? '编辑后任务' : '卡片任务'))
      assert.ok(!input.includes('先前的工作'))
    } finally {
      await env.close()
    }
  })
}

for (const method of ['here', 'markHere']) {
  test(`已归档建议来源 ${method}：先恢复再执行，归档拒绝不阻止原会话恢复流程`, async () => {
    const env = treeRig()
    try {
      const client = await litch(env)
      const { threadId } = await parent(client, false)
      const tree = env.device.sessionTree
      const proposal = tree.propose({
        threadId,
        title: '原会话执行',
        prompt: '卡片任务',
        kind: 'fresh',
        harness: 'pi',
        model: null,
        cwd: null,
        wakeParent: false,
        worktree: false,
      })
      await client.call('thread/archive', { threadId })
      const resume = env.pi.handlers['thread/resume']
      assert.ok(resume)
      env.pi.handlers['thread/resume'] = (params, connection) => {
        if (env.pi.thread(params.threadId).archived)
          throw new RpcFailure(-32600, 'session is archived. Run `codex unarchive` first.')
        return resume(params, connection)
      }
      const at = env.pi.seen.length
      const result = await client.call(`litch/sessionProposal/${method}`, {
        threadId,
        proposalId: proposal.id,
      })
      if (method === 'markHere') {
        await client.call('thread/resume', { threadId })
        await client.call('turn/start', {
          threadId,
          input: [{ type: 'text', text: result.text, text_elements: [] }],
        })
      }
      await until(() => env.pi.running(threadId), '来源已恢复并开始执行')
      assert.equal(tree.host.index.archived(threadId), false)
      assert.equal(tree.proposal(proposal.id)?.status, 'here')
      const requests = env.pi.seen.slice(at)
      const restored = requests.findIndex((r) => r.method === 'thread/unarchive')
      const sent = requests.findIndex((r) => r.method === 'turn/start')
      assert.ok(restored >= 0 && sent > restored, '发送必须发生在恢复之后')
      assert.match(env.pi.sent('turn/start').at(-1)?.input[0].text, /卡片任务/)
    } finally {
      await env.close()
    }
  })
}
