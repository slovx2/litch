import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import { emptyRanking } from '../../protocol/src/model-ranking.mjs'
import { acceptProposal, startChild } from '../src/session-start.mjs'
import { RpcFailure } from './fake-upstream.mjs'
import { treeRig, until } from './tree-kit.mjs'

for (const mode of ['builtin', 'custom', 'off'] as const) {
  for (const selection of ['card', 'dispatch', 'default', 'cross-harness'] as const) {
    test(`归档建议 ${mode}/${selection}：按卡片、派线默认、harness 默认选模型`, async () => {
      const env = treeRig()
      try {
        const engine = env.claude
        engine.handlers['model/list'] = () => ({
          data: ['sonnet', 'opus', 'fable'].map((id) => ({
            id,
            model: id,
            displayName: id,
            isDefault: id === 'opus',
            litchModelIdentity: { provider: 'account', resolved: `claude-${id}-5`, trusted: true },
          })),
          nextCursor: null,
        })
        Object.assign(engine.config, { model: 'sonnet' })
        const start = engine.handlers['thread/start']
        assert.ok(start)
        engine.handlers['thread/start'] = (params, connection) => ({
          ...(start(params, connection) as object),
          model: params.model ?? 'opus',
        })
        const client = env.connect()
        await client.initialize(['harness', 'sessionTree', 'litchManager'])
        const { threadId } = await client.call(MANAGER_METHOD.create, {
          cwd: env.stateDir,
          harness: 'claude-code',
          model: 'sonnet',
          effort: null,
          name: '隔离经理',
          scope: '',
          rules: '',
          template: 'blank',
          firstTask: '',
          dispatch: {
            ...MANAGER_DEFAULT_DISPATCH,
            harness: 'claude-code',
            model: selection === 'dispatch' || selection === 'cross-harness' ? 'fable' : null,
            worktree: false,
          },
          contact: { ...MANAGER_DEFAULT_CONTACT },
        })
        const tree = env.device.sessionTree
        const source = await startChild(
          tree,
          threadId,
          {
            title: '归档的来源',
            prompt: '先前任务',
            kind: 'fresh',
            harness: 'claude-code',
            model: 'sonnet',
            wakeParent: false,
            worktree: false,
          },
          'user',
        )
        const proposal = tree.propose({
          threadId: source.threadId,
          title: '继续执行建议',
          prompt: '只执行卡片任务',
          kind: 'fresh',
          harness:
            selection === 'cross-harness' ? 'pi' : selection === 'dispatch' ? null : 'claude-code',
          model: selection === 'card' ? 'fable' : null,
          cwd: env.stateDir,
          wakeParent: false,
          worktree: false,
        })
        engine.end(source.threadId)
        await until(() => !tree.isActive(source.threadId), '来源停止')
        await client.call('thread/archive', { threadId: source.threadId })
        const resume = engine.handlers['thread/resume']
        assert.ok(resume)
        engine.handlers['thread/resume'] = (params, connection) => {
          if (params.threadId === source.threadId)
            throw new RpcFailure(-32600, '测试禁止恢复归档来源')
          return resume(params, connection)
        }
        if (mode !== 'off') tree.host.modelRanking = async () => ({ ...emptyRanking(), mode })
        if (mode !== 'off' && (mode === 'custom' || selection !== 'cross-harness'))
          await assert.rejects(
            acceptProposal(tree, proposal.id),
            (error: unknown) => {
              assert.equal((error as { data: { litch: string } }).data.litch, 'archivedSourceModel')
              return true
            },
            '模型工具不能借用户开始的例外绕过委派上限',
          )
        const before = engine.seen.length
        const target = selection === 'cross-harness' ? env.pi : engine
        const beforeTarget = target.seen.length
        if (mode === 'builtin' && selection === 'card')
          await assert.rejects(
            client.call('litch/sessionProposal/accept', {
              threadId: source.threadId,
              proposalId: proposal.id,
              overrides: { permission: ':danger-full-access', worktree: false },
            }),
            (error: unknown) => {
              assert.match((error as { message: string }).message, /permission|权限/i)
              return true
            },
            '确认型号不能提升权限',
          )
        const accepted =
          mode === 'off' && selection !== 'default'
            ? await acceptProposal(tree, proposal.id)
            : await client.call('litch/sessionProposal/accept', {
                threadId: source.threadId,
                proposalId: proposal.id,
                overrides: { worktree: false },
              })
        const requests = engine.seen.slice(before)
        assert.equal(
          target.seen.slice(beforeTarget).find((request) => request.method === 'thread/start')
            ?.params.model,
          selection === 'cross-harness' || (mode === 'off' && selection === 'default')
            ? undefined
            : selection === 'default'
              ? 'opus'
              : 'fable',
        )
        assert.equal(tree.lineage(accepted.threadId)?.parentThreadId, threadId)
        assert.equal(tree.host.index.archived(source.threadId), true)
        assert.equal(
          requests.some(
            (request) =>
              ['thread/resume', 'thread/fork', 'thread/unarchive'].includes(request.method) &&
              request.params.threadId === source.threadId,
          ),
          false,
        )
      } finally {
        await env.close()
      }
    })
  }
}
