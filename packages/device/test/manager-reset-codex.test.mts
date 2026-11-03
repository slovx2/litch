import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import { RESUME_TOOLS_READ } from '../../protocol/src/resume-tools.mjs'
import { codexRig, sentTo } from './codex-kit.mjs'
import { codexThread } from './fake-codex.mjs'
import { until } from './tree-kit.mjs'

test('原生 Codex 经理恢复不补工具，重置的新线程按当前开关注入并通过协议校验', async () => {
  const env = codexRig()
  try {
    let serial = 100
    const start = env.codex.handlers['thread/start']!
    env.codex.handlers['thread/start'] = (params, connection) => {
      const result = start(params, connection) as { thread: { id: string } }
      const thread = env.codex.threads.find((one) => one.id === result.thread.id)!
      const identity = codexThread(++serial, 9000)
      Object.assign(thread, identity, { cwd: params.cwd, dynamicTools: params.dynamicTools })
      return { ...result, thread }
    }
    env.codex.handlers['thread/name/set'] = () => ({})
    env.codex.handlers['thread/goal/get'] = () => ({ goal: null })
    const resume = env.codex.handlers['thread/resume']!
    env.codex.handlers['thread/resume'] = (params, connection) => ({
      ...(resume(params, connection) as Record<string, unknown>),
      activePermissionProfile: ':workspace',
    })
    const read = env.codex.handlers['thread/read']!
    env.codex.handlers['thread/read'] = (params, connection) => {
      const result = read(params, connection) as { thread: { turns: unknown[] } }
      result.thread.turns = params.includeTurns
        ? (env.codex.threads.find((thread) => thread.id === params.threadId)!.turns as unknown[])
        : []
      return result
    }
    const startTurn = env.codex.handlers['turn/start']!
    const active = new Map<string, string>()
    env.codex.handlers['turn/start'] = (params, connection) => {
      const result = startTurn(params, connection) as { turn: { id: string } }
      result.turn.id = `turn-${++serial}`
      active.set(params.threadId, result.turn.id)
      return result
    }
    const client = env.connect()
    await client.initialize(['harness', 'litchManager'])
    const { manager, threadId } = await client.call(MANAGER_METHOD.create, {
      cwd: env.stateDir,
      harness: 'codex',
      model: null,
      effort: null,
      name: 'Codex 重置',
      scope: '',
      rules: '',
      template: 'blank',
      dispatch: MANAGER_DEFAULT_DISPATCH,
      contact: MANAGER_DEFAULT_CONTACT,
      firstTask: '',
    })
    const tree = env.device.sessionTree
    const end = (text: string) => {
      const turn = {
        id: active.get(threadId)!,
        status: 'completed',
        items: [{ type: 'agentMessage', id: 'answer', text }],
      }
      const thread = env.codex.threads.find((one) => one.id === threadId)!
      thread.turns = [turn]
      thread.status = { type: 'idle' }
      env.codex.notify('turn/completed', { threadId, turn })
    }
    await until(() => tree.isActive(threadId), '经理开场')
    end('开场结束')
    await until(() => !tree.isActive(threadId), '开场结束')
    const oldTools = tree.store.tools(threadId)!.filter((tool: any) => tool.name !== 'litch_tasks')
    tree.store.setTools(threadId, oldTools)
    env.codex.threads.find((one) => one.id === threadId)!.dynamicTools = oldTools
    env.control.patch({
      values: {
        'tools.browser': true,
        'tools.computer': true,
        'tools.machine': true,
      } as never,
    })
    await client.call('thread/resume', { threadId })
    assert.deepEqual(tree.store.tools(threadId), oldTools)
    assert.equal(sentTo(env.codex, 'thread/resume').at(-1).dynamicTools, undefined)
    assert.equal(sentTo(env.codex, RESUME_TOOLS_READ).length, 0)
    await client.call(MANAGER_METHOD.reset, { managerId: manager.id })
    await until(
      () => {
        const reset = env.device.managers.manager(manager.id).reset
        assert.notEqual(reset?.phase, 'failed', JSON.stringify(reset))
        return tree.isActive(threadId)
      },
      '交接摘要开始',
      5000,
    )
    end('交接摘要')
    await until(
      () => {
        const current = env.device.managers.manager(manager.id)
        assert.ok(
          !['failed', 'summaryFailed'].includes(current.reset!.phase),
          JSON.stringify(current.reset),
        )
        return current.threadId !== threadId
      },
      'Codex 换绑完成',
      5000,
    )
    const current = env.device.managers.manager(manager.id)
    const tools = tree.store.tools(current.threadId)! as { name: string }[]
    for (const name of [
      'litch_browser',
      'litch_computer',
      'litch_machine',
      'litch_tasks',
      'litch_manager',
      'litch_sessions',
      'litch_repository',
    ])
      assert.ok(
        tools.some((tool) => tool.name === name),
        name,
      )
    assert.deepEqual(tree.store.tools(threadId), oldTools)
    assert.equal(sentTo(env.codex, RESUME_TOOLS_READ).length, 0)
    const sent = sentTo(env.codex, 'thread/start').at(-1).dynamicTools as { name: string }[]
    assert.deepEqual(
      sent.map((tool) => tool.name),
      tools.map((tool) => tool.name),
    )
  } finally {
    await env.close()
  }
})
