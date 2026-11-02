// 真设备路由配协议假上游，覆盖创建入口和经理规则更新的工具登记。
import assert from 'node:assert/strict'
import test from 'node:test'
import { SESSION_TOOLS } from '../../protocol/src/client-tools-sessions.mjs'
import { withDeveloperInstructions } from '../../protocol/src/codex-developer-instructions.mjs'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import { codexRig, sentTo } from './codex-kit.mjs'
import { codexThread, FakeCodex } from './fake-codex.mjs'
import { installConfig } from './fake-codex-config.mjs'
import { brief, text, until } from './tree-kit.mjs'

function fixture() {
  const fake = new FakeCodex()
  fake.cliVersion = '0.166.0'
  installConfig(fake)
  let serial = 0
  fake.handlers['thread/start'] = (params) => {
    const thread = codexThread(++serial, 400, { cwd: params.cwd, status: { type: 'idle' } })
    fake.threads.push(thread)
    return { thread, model: 'fake' }
  }
  const resume = fake.handlers['thread/resume']
  assert.ok(resume)
  fake.handlers['thread/resume'] = (params, connection) => ({
    ...(resume(params, connection) as Record<string, unknown>),
    activePermissionProfile: ':workspace',
  })
  const env = codexRig({ fake })
  env.device.titles.setEnabled('codex', false)
  let callId = 0
  const tool = async (threadId: string, name: string, args: unknown, ns = 'litch_sessions') => {
    const id = fake.ask('item/tool/call', {
      threadId,
      turnId: `turn-of-${threadId}`,
      callId: `tool-${++callId}`,
      namespace: ns,
      tool: name,
      arguments: args,
    })
    await until(() => fake.connections.some((c) => c.answers.some((a) => a.id === id)), '工具回包')
    const result = fake.connections.flatMap((c) => c.answers).find((a) => a.id === id)?.result
    assert.equal(result.success, true, JSON.stringify(result))
    return JSON.parse(result.contentItems[0].text)
  }
  const checkTools = (threadId: string) => {
    const tools = env.device.sessionTree.store.tools(threadId)
    // 原生线上的 instructions 会并入 developerInstructions，登记仍保留规则元数据。
    assert.deepEqual(
      withDeveloperInstructions({ dynamicTools: tools }, null).dynamicTools,
      sentTo(fake, 'thread/start').at(-1).dynamicTools,
    )
    assert.equal(env.device.nativeBackground.installed(threadId), true)
  }
  return { ...env, fake, tool, checkTools }
}

for (const entry of ['start', 'accept', 'manager-line'] as const) {
  test(`SESSION-TOOLS-REGISTER ${entry} 的 fresh 子会话保留最终工具并能登记、完成唤醒`, async () => {
    const env = fixture()
    try {
      const client = env.connect()
      await client.initialize(['harness', 'sessionTree', 'clientTools', 'litchManager'])
      let parentId: string
      if (entry === 'manager-line') {
        const created = await client.call(MANAGER_METHOD.create, {
          cwd: env.stateDir,
          harness: 'codex',
          model: null,
          effort: null,
          name: '工具登记经理',
          scope: '核验后台接续',
          template: 'blank',
          rules: '',
          dispatch: { ...MANAGER_DEFAULT_DISPATCH, worktree: false },
          contact: { ...MANAGER_DEFAULT_CONTACT },
          firstTask: '',
        })
        parentId = created.threadId
      } else {
        const created = await client.call('thread/start', {
          harness: 'codex',
          cwd: env.stateDir,
          dynamicTools: [SESSION_TOOLS],
        })
        parentId = created.thread.id
      }
      await client.call('turn/start', { threadId: parentId, input: text('开始验收') })
      const started = await env.tool(parentId, 'start', {
        title: '核验后台任务',
        ...brief('执行有限命令并登记完成接续'),
        kind: 'fresh',
        initiation: entry === 'accept' ? 'propose' : 'user_asked',
        worktree: false,
        wake_parent: false,
      })
      const child =
        entry === 'accept'
          ? await env.tool(parentId, 'accept', { proposal_id: started.proposal_id })
          : started
      env.checkTools(child.thread_id)
      env.fake.handlers['thread/backgroundTerminals/list'] = () => ({
        data: [{ itemId: 'command', processId: '123' }],
      })
      const item = {
        type: 'commandExecution',
        id: 'command',
        processId: '123',
        command: 'finite fixture',
        status: 'inProgress',
      }
      env.fake.notify('item/started', {
        threadId: child.thread_id,
        turnId: `turn-of-${child.thread_id}`,
        item,
      })
      const watched = await env.tool(
        child.thread_id,
        'watch',
        { session_id: '123', purpose: '核验结果' },
        'litch_background',
      )
      assert.equal(watched.state, 'registered')
      env.fake.notify('turn/completed', {
        threadId: child.thread_id,
        turn: { id: `turn-of-${child.thread_id}`, status: 'completed' },
      })
      env.fake.handlers['thread/backgroundTerminals/list'] = () => ({ data: [] })
      env.fake.notify('item/completed', {
        threadId: child.thread_id,
        turnId: `turn-of-${child.thread_id}`,
        item: { ...item, status: 'completed', exitCode: 0, aggregatedOutput: 'CHILD_DONE' },
      })
      await until(
        () =>
          sentTo(env.fake, 'turn/start').some(
            (p) => p.toolOutput?.namespace === 'litch_background',
          ),
        '完成后唤醒回合',
      )
      const wake = sentTo(env.fake, 'turn/start').find((p) => p.toolOutput)
      assert.equal(wake.threadId, child.thread_id)
      assert.match(wake.toolOutput.output, /CHILD_DONE/)
    } finally {
      await env.close()
    }
  })
}

test('SESSION-TOOLS-REGISTER 经理创建和改规则保留已安装工具与后台指令，不给旧会话补装', async () => {
  const env = fixture()
  try {
    const client = env.connect()
    await client.initialize(['harness', 'litchManager'])
    const created = await client.call(MANAGER_METHOD.create, {
      cwd: env.stateDir,
      harness: 'codex',
      model: null,
      effort: null,
      name: '测试经理',
      scope: '旧范围',
      template: 'blank',
      rules: '',
      dispatch: { ...MANAGER_DEFAULT_DISPATCH, worktree: false },
      contact: { ...MANAGER_DEFAULT_CONTACT },
      firstTask: '',
    })
    env.checkTools(created.threadId)
    const store = env.device.sessionTree.store
    const tools = store.tools(created.threadId)
    await client.call(MANAGER_METHOD.update, { managerId: created.manager.id, scope: '新范围' })
    assert.deepEqual(store.tools(created.threadId), tools)
    const namespaces = store.instructions(created.threadId)?.namespaces
    assert.ok(namespaces?.some((n) => n.name === 'litch_background'))
    assert.ok(
      namespaces?.some((n) => n.name === 'litch_manager' && n.instructions.includes('新范围')),
    )
    // 模拟既有坏记录；设置更新不得据此伪造安装状态。
    store.setTools(created.threadId, [])
    await client.call(MANAGER_METHOD.update, { managerId: created.manager.id, name: '改名' })
    assert.deepEqual(store.tools(created.threadId), [])
    assert.equal(env.device.nativeBackground.installed(created.threadId), false)
  } finally {
    await env.close()
  }
})
