import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { ClientToolCallResponse } from '../../protocol/src/client-tools.mjs'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import { ManagerQuestions } from '../src/manager-questions.mjs'
import { FakeEngine } from './fake-engine.mjs'
import { rig } from './helpers.mjs'
import { until } from './tree-kit.mjs'

for (const harness of ['claude-code', 'pi', 'opencode']) {
  test(`${harness} 旁问：只读所属经理和有效跨引擎工作线，范围外在读历史前拒绝`, async () => {
    const engine = new FakeEngine(harness)
    engine.declaration = {
      extensions: ['clientTools'],
      features: {
        managerQuestions: true,
        ephemeralFork: harness !== 'opencode',
      },
    }
    const cross = new FakeEngine('cross')
    const env = rig({ [harness]: engine, cross })
    try {
      const client = env.connect()
      await client.initialize(['harness', 'litchManager'])
      const create = () =>
        client.call(MANAGER_METHOD.create, {
          cwd: env.stateDir,
          harness,
          model: null,
          effort: null,
          name: '读范围',
          scope: '',
          rules: '',
          template: 'blank',
          firstTask: '',
          dispatch: MANAGER_DEFAULT_DISPATCH,
          contact: MANAGER_DEFAULT_CONTACT,
        })
      const { manager, threadId } = await create()
      const other = await create()
      await until(() => engine.running(threadId), '经理回合')
      engine.end(threadId, 'completed', '经理的背景')
      const tree = env.device.sessionTree
      const child = async (parent: string | null, source = 'cross') => {
        const { thread } = await client.call('thread/start', { harness: source, cwd: env.stateDir })
        if (parent)
          tree.store.addLineage({
            threadId: thread.id,
            parentThreadId: parent,
            harness: source,
            kind: 'fresh',
            origin: 'model',
            title: '工作线',
            prompt: '',
            wakeParent: false,
            createdAt: 1,
            proposalId: '',
          })
        return thread.id as string
      }
      const line = await child(threadId)
      const descendant = await child(line, harness)
      await client.call('turn/start', {
        threadId: line,
        input: [{ type: 'text', text: '运行中工作线' }],
      })
      await client.call('turn/start', {
        threadId: descendant,
        input: [{ type: 'text', text: '已结束工作线' }],
      })
      engine.end(descendant, 'completed', '工作线完成结果')
      const unrelated = await child(null)
      const foreign = await child(other.threadId)
      // 另一位经理也可以是旧工作线的后代；遇到新的经理归属必须截断子树。
      tree.store.addLineage({
        threadId: other.threadId,
        parentThreadId: threadId,
        harness,
        kind: 'fresh',
        origin: 'model',
        title: '独立经理',
        prompt: '',
        wakeParent: false,
        createdAt: 1,
        proposalId: '',
      })
      const detached = await child(line)
      tree.store.detach(detached)
      env.device.managers.writer.tool(manager.id, 'add', {
        kind: 'decision',
        decision: { title: '选择', background: `引用其他会话 ${unrelated}` },
      })
      await client.call(MANAGER_METHOD.questionAsk, {
        managerId: manager.id,
        decisionId: 'D-1',
        revision: 1,
        question: '解释背景',
      })
      await until(() => !!env.device.managers.store.question(manager.id, 'D-1')?.threadId, '旁问')
      const question = env.device.managers.store.question(manager.id, 'D-1')?.threadId
      assert.ok(question)
      await until(() => engine.running(question), '旁问回合')
      const tool = (name: string, args: unknown = {}) =>
        new Promise<ClientToolCallResponse>((resolve) => {
          env.device.deviceTools.dispatch(
            harness,
            {
              threadId: question,
              turnId: 'probe',
              callId: randomUUID(),
              namespace: 'litch_sessions',
              tool: name,
              arguments: args,
            },
            (response) => {
              resolve(response)
              return true
            },
          )
        })
      const value = (result: ClientToolCallResponse) => {
        assert.equal(result.success, true, JSON.stringify(result))
        const part = result.contentItems[0]
        assert.ok(part && 'text' in part)
        return JSON.parse(part.text)
      }
      const list = value(await tool('list'))
      assert.deepEqual(
        list.sessions.map((row: { thread_id: string }) => row.thread_id).sort(),
        [threadId, line, descendant].sort(),
      )
      assert.deepEqual(
        value(await tool('list', { status: 'running' })).sessions.map(
          (row: { thread_id: string }) => row.thread_id,
        ),
        [line],
      )
      assert.equal(value(await tool('read', { thread_id: line })).turns.at(-1).answer, null)
      assert.equal(
        value(await tool('read', { thread_id: descendant })).turns.at(-1).answer,
        '工作线完成结果',
      )
      assert.deepEqual(
        value(await tool('list', { scope: 'mine', harness: 'cross' })).sessions.map(
          (row: { thread_id: string }) => row.thread_id,
        ),
        [line],
      )
      assert.deepEqual(value(await tool('list', { cwd: '/another' })).sessions, [])
      assert.equal(value(await tool('list', { limit: 1 })).truncated, true)
      tree.host.index.setArchived(descendant, true)
      assert.ok(
        !value(await tool('list')).sessions.some(
          (row: { thread_id: string }) => row.thread_id === descendant,
        ),
      )
      const archived = value(await tool('list', { archived: 'only' })).sessions
      assert.deepEqual(
        archived.map((row: { thread_id: string }) => row.thread_id),
        [descendant],
      )
      assert.equal(archived[0].archived, true)
      assert.equal(value(await tool('list', { archived: 'include' })).sessions.length, 3)
      tree.host.index.setArchived(descendant, false)
      for (const id of [threadId, line, descendant])
        assert.equal(value(await tool('read', { thread_id: id })).session.thread_id, id)
      for (const id of [other.threadId, foreign, unrelated, detached, question]) {
        const before = engine.seen.length + cross.seen.length
        assert.equal((await tool('read', { thread_id: id })).success, false)
        assert.equal(engine.seen.length + cross.seen.length, before, '范围外不读引擎历史')
      }
      for (const name of [
        'start',
        'send',
        'respond',
        'interrupt',
        'archive',
        'unarchive',
        'set_wake',
        'wrap_up',
        'options',
        'wait',
        'accept',
        'withdraw',
        'hand_off',
      ])
        assert.equal((await tool(name, { thread_id: line })).success, false, name)
      tree.store.detach(line)
      assert.equal((await tool('read', { thread_id: descendant })).success, false)
      const created = engine.seen.find(
        (call) =>
          call.method === (harness === 'opencode' ? 'thread/start' : 'thread/fork') &&
          call.params.ephemeral,
      )
      assert.ok(created)
      assert.deepEqual(
        created.params.dynamicTools[1].tools.map((one: { name: string }) => one.name),
        ['list', 'read'],
      )
      assert.match(created.params.dynamicTools[1].instructions, new RegExp(threadId))
      assert.doesNotMatch(
        created.params.dynamicTools[1].instructions,
        /Every turn ends|initiation "offer"/,
      )
      const state = env.device.managers.store.question(manager.id, 'D-1')
      assert.ok(state)
      await env.device.managers.questions.release(state, await tree.link(harness))
      assert.equal((await tool('list')).success, false)
      // 重启重新载入持久化的受限集合，不能因旧线程不在活动集合而获得普通会话权限。
      const restarted = new ManagerQuestions(env.device.managers)
      assert.equal(restarted.allowed(question, 'litch_sessions', 'read'), false)
      assert.equal(restarted.allowed(question, 'litch_manager', 'get'), false)
      assert.deepEqual([...(restarted.readableSessions(question) ?? [])], [])
    } finally {
      await env.close()
    }
  })
}
