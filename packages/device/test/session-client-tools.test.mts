import assert from 'node:assert/strict'
import test from 'node:test'
import { SESSION_TOOLS } from '../../protocol/src/client-tools-sessions.mjs'
import { clientToolSpecs } from '../../protocol/src/client-tools-specs.mjs'
import { codexVerdict } from '../../shared/test/codex-params.mjs'
import { prepareSessionTools } from '../src/session-client-tools.mjs'
import { codexRig, sentTo } from './codex-kit.mjs'
import { resultOf } from './fake-engine.mjs'
import { brief, ECHO_SPEC, litch, parent, text, treeRig, until } from './tree-kit.mjs'

const names = (tools: any[]) => tools.map((tool) => tool.name)

test('桌面普通 Claude 分叉保留自定义和会话工具，只重算常驻工具', async () => {
  const env = treeRig({}, { values: { 'tools.browser': true } })
  try {
    const client = await litch(env)
    const { thread } = await client.call('thread/start', {
      harness: 'claude-code',
      dynamicTools: [ECHO_SPEC, SESSION_TOOLS],
    })
    env.control?.patch({ values: { 'tools.browser': false, 'tools.computer': true } as never })
    const forked = await client.call('thread/fork', { threadId: thread.id })
    const tools = names(env.device.sessionTree.store.tools(forked.thread.id) ?? [])
    assert.ok(tools.includes('litch_echo'))
    assert.ok(tools.includes('litch_sessions'))
    assert.ok(tools.includes('litch_computer'))
    assert.ok(!tools.includes('litch_browser'))
  } finally {
    await env.close()
  }
})

for (const kind of ['fork', 'hand_off'] as const) {
  test(`Claude ${kind}：按当前开关换工具，源会话仍保留创建时的工具`, async () => {
    const env = treeRig({}, { values: { 'tools.computer': false } })
    try {
      const client = await litch(env)
      const { thread } = await client.call('thread/start', {
        harness: 'claude-code',
        dynamicTools: [SESSION_TOOLS],
      })
      await client.call('turn/start', { threadId: thread.id, input: text('把工作交接出去') })
      env.control?.patch({
        values: { 'tools.browser': false, 'tools.computer': true, 'tools.machine': true } as never,
      })
      let childId: string
      if (kind === 'fork') {
        const child = await client.call('litch/session/start', {
          parentThreadId: thread.id,
          title: '分叉工具',
          kind: 'fork',
          prompt: '继续检查工具',
          wakeParent: false,
          worktree: false,
        })
        childId = child.threadId
      } else {
        const call = await env.claude.callTool(thread.id, 'litch_sessions', 'hand_off', {
          title: '交接工具',
          remaining_plan: '继续检查客户端工具开关',
          worktree: false,
        })
        assert.ok(call)
        childId = resultOf(call.answer).thread_id
      }
      const tools = names(env.device.sessionTree.store.tools(childId) ?? [])
      assert.ok(!tools.includes('litch_browser'))
      for (const name of ['litch_computer', 'litch_machine', 'litch_tasks', 'litch_presentation'])
        assert.ok(tools.includes(name), name)
      assert.ok(
        names(env.device.sessionTree.store.tools(thread.id) ?? []).includes('litch_browser'),
      )
      assert.equal(tools.length, new Set(tools).size)
    } finally {
      await env.close()
    }
  })
}

test('原生 Codex：手机离线建会话带三种常驻工具，不带空命名空间，校验仍通过', async () => {
  const env = codexRig({
    toolSettings: { 'tools.browser': true, 'tools.computer': true, 'tools.machine': true },
  })
  try {
    const phone = env.connect()
    await phone.initialize(['harness', 'sessionTree'])
    await phone.call('thread/start', {
      harness: 'codex',
      cwd: env.stateDir,
      dynamicTools: clientToolSpecs(['litch_browser']),
    })
    const sent = sentTo(env.codex, 'thread/start')[0]
    assert.deepEqual(
      new Set(names(sent.dynamicTools)),
      new Set(['litch_browser', 'litch_computer', 'litch_machine']),
    )
    assert.equal(sent.dynamicTools.length, 3)
    assert.deepEqual(codexVerdict('thread/start', sent), { rejects: [], ignored: [] })
  } finally {
    await env.close()
  }
})

test('常驻工具：不支持的引擎不注入；去重、关闭移除、呈现风格按目标 harness', () => {
  const given = { dynamicTools: clientToolSpecs(['litch_browser', 'litch_computer']) }
  const opts = { tasks: true }
  assert.equal(prepareSessionTools(given, 'unknown', null, false, {}, opts), given)
  for (const native of [false, true]) {
    const ready = prepareSessionTools(
      { dynamicTools: [...given.dynamicTools, ...given.dynamicTools] },
      native ? 'codex' : 'pi',
      { extensions: ['clientTools'] },
      native,
      { 'tools.browser': false, 'tools.computer': true },
      opts,
    )
    const list = names(ready.dynamicTools as any[])
    assert.equal(list.includes('litch_browser'), false)
    assert.equal(list.filter((name) => name === 'litch_computer').length, 1)
    assert.equal(list.includes('litch_presentation'), !native)
    const computer = (ready.dynamicTools as any[]).find((tool) => tool.name === 'litch_computer')
    assert.ok(computer.tools.some((tool: any) => tool.name === 'run_actions'))
  }
})

test('手机创建：无执行端仍注入；调用立即失败，桌面后来连接后下一次调用成功', async () => {
  const env = treeRig({}, { values: { 'tools.computer': true, 'tools.machine': true } })
  try {
    const phone = env.connect()
    await phone.initialize(['harness', 'sessionTree'])
    const { thread } = await phone.call('thread/start', { harness: 'pi' })
    const tools = env.device.sessionTree.store.tools(thread.id) ?? []
    assert.ok(names(tools).includes('litch_browser'))
    assert.ok(names(tools).includes('litch_computer'))
    assert.ok(names(tools).includes('litch_machine'))
    await phone.call('turn/start', { threadId: thread.id, input: text('测试工具') })
    const child = await phone.call('litch/session/start', {
      parentThreadId: thread.id,
      title: '手机子会话',
      ...brief('检查手机派出的新会话'),
      kind: 'fresh',
      harness: 'claude-code',
      wakeParent: false,
      worktree: false,
    })
    const childTools = names(env.device.sessionTree.store.tools(child.threadId) ?? [])
    for (const name of ['litch_browser', 'litch_computer', 'litch_machine', 'litch_tasks'])
      assert.ok(childTools.includes(name), name)
    const started = Date.now()
    const failed = await env.pi.callTool(thread.id, 'litch_browser', 'tabs', {})
    assert.ok(failed)
    assert.equal(failed.answer.result.success, false)
    assert.match(failed.answer.result.contentItems[0].text, /noExecutor.*Litch.*桌面/)
    assert.ok(Date.now() - started < 1500)
    assert.equal(phone.requests.length, 0)
    const desktop = env.connect()
    await desktop.initialize(['harness', 'clientTools'], {
      litchClientTools: { namespaces: ['litch_browser'] },
    })
    const next = env.pi.callTool(thread.id, 'litch_browser', 'tabs', {})
    const request = await desktop.waitFor((frame) => frame.method === 'item/tool/call')
    desktop.answer(request.id, { success: true, contentItems: [] })
    assert.equal((await next)?.answer.result.success, true)
    assert.equal(phone.requests.length, 0)
  } finally {
    await env.close()
  }
})

test('经理与工作线：桌面离线新建，目标 harness 开关覆盖父会话，工具不重复', async () => {
  const env = treeRig(
    {},
    {
      values: {
        'tools.browser': false,
        'tools.computer': true,
        'tools.machine': true,
        'harness.pi.browser': true,
        'harness.pi.computer': false,
      },
    },
  )
  try {
    const phone = env.connect()
    await phone.initialize(['harness', 'litchManager', 'sessionTree'])
    const { manager, threadId } = await phone.call('litch/manager/create', {
      name: '工具经理',
      cwd: env.stateDir,
      harness: 'pi',
      model: null,
      effort: null,
      permission: ':workspace',
      scope: '',
      rules: '',
      firstTask: '',
      template: 'blank',
      dispatch: {
        harness: 'claude-code',
        model: null,
        effort: null,
        worktree: false,
        merge: 'manager',
        maxRunningLines: 4,
      },
      contact: { desktopNotification: false, unanswered: 'wait' },
    })
    const managerTools = names(env.device.sessionTree.store.tools(threadId) ?? [])
    assert.ok(managerTools.includes('litch_browser'))
    assert.ok(!managerTools.includes('litch_computer'))
    assert.ok(managerTools.includes('litch_tasks'))
    assert.ok(managerTools.includes('litch_machine'))
    assert.ok(managerTools.includes('litch_manager'))
    await until(() => env.pi.running(threadId) !== null, '经理首回合已开始')
    const made = await phone.call('litch/session/start', {
      parentThreadId: threadId,
      title: '工具线',
      ...brief('验证新工作线的工具'),
      kind: 'fresh',
      harness: 'claude-code',
      worktree: false,
      wakeParent: false,
    })
    assert.equal(env.device.managers.lines.managerFor(made.threadId)?.id, manager.id)
    const child = names(env.device.sessionTree.store.tools(made.threadId) ?? [])
    assert.ok(!child.includes('litch_browser'))
    assert.ok(child.includes('litch_computer'))
    assert.ok(child.includes('litch_machine'))
    assert.ok(child.includes('litch_tasks'))
    assert.ok(child.includes('litch_presentation'))
    assert.ok(!child.includes('litch_manager'))
    assert.equal(child.length, new Set(child).size)
  } finally {
    await env.close()
  }
})

test('普通父会话不带 CU，跨 harness 子会话按设备设置获得 CU', async () => {
  const env = treeRig({}, { values: { 'harness.claude-code.computer': true } })
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const called = await env.pi.callTool(threadId, 'litch_sessions', 'start', {
      title: '子会话工具',
      ...brief('检查目标 harness 的工具配置'),
      harness: 'claude-code',
      initiation: 'user_asked',
      worktree: false,
    })
    assert.ok(called)
    const id = resultOf(called.answer).thread_id
    assert.ok(!names(env.device.sessionTree.store.tools(threadId) ?? []).includes('litch_computer'))
    assert.ok(names(env.device.sessionTree.store.tools(id) ?? []).includes('litch_computer'))
  } finally {
    await env.close()
  }
})
