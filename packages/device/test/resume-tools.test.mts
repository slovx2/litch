import assert from 'node:assert/strict'
import test from 'node:test'
import { SESSION_TOOLS } from '../../protocol/src/client-tools-sessions.mjs'
import { TASKS_TOOLS } from '../../protocol/src/client-tools-tasks.mjs'
import { RESUME_TOOLS_CHANGED, RESUME_TOOLS_READ } from '../../protocol/src/resume-tools.mjs'
import { ResumeTools } from '../src/resume-tools.mjs'
import { codexRig, sentTo } from './codex-kit.mjs'
import { ECHO_SPEC, litch, treeRig } from './tree-kit.mjs'

const names = (tools: any[]) => tools.map((tool) => tool.name)

test('经理定时任务随设备能力补齐或移除，其他角色定义不变', () => {
  let tasks = true
  const coordinator = new ResumeTools(
    () => ({ 'tools.browser': false }),
    { setTools() {} },
    () => false,
    () => tasks,
  )
  const role = { ...ECHO_SPEC, name: 'litch_manager' }
  assert.deepEqual(coordinator.tools('claude-code', [role]), [role, TASKS_TOOLS])
  tasks = false
  assert.deepEqual(coordinator.tools('claude-code', [role, TASKS_TOOLS]), [role])
})

for (const harness of ['claude-code', 'pi']) {
  test(`${harness}：重新打开与重新连接按当前开关刷新，角色和自定义工具保留`, async () => {
    const env = treeRig({}, { values: { 'tools.browser': false, 'tools.machine': false } })
    try {
      let client = await litch(env)
      const { thread } = await client.call('thread/start', {
        harness,
        dynamicTools: [SESSION_TOOLS, ECHO_SPEC],
      })
      const initial = env.device.sessionTree.store.tools(thread.id)!
      const preserved = initial.filter(
        (tool: any) =>
          !['litch_browser', 'litch_machine', 'litch_computer', 'litch_automation'].includes(
            tool.name,
          ),
      )
      env.control!.patch({ values: { 'tools.browser': true, 'tools.machine': true } as never })
      const other = await litch(env)
      await Promise.all([
        client.call('thread/resume', { threadId: thread.id, dynamicTools: [] }),
        other.call('thread/resume', { threadId: thread.id }),
      ])
      let tools = env.device.sessionTree.store.tools(thread.id)!
      assert.ok(names(tools).includes('litch_machine'))
      assert.ok(names(tools).includes('litch_browser'))
      assert.deepEqual(
        tools.filter(
          (tool: any) =>
            !['litch_browser', 'litch_machine', 'litch_automation'].includes(tool.name),
        ),
        preserved,
      )
      assert.equal(names(tools).length, new Set(names(tools)).size)
      client.close()
      client = await litch(env)
      env.control!.patch({ values: { 'tools.browser': false, 'tools.machine': false } as never })
      await client.call('thread/resume', { threadId: thread.id })
      tools = env.device.sessionTree.store.tools(thread.id)!
      assert.deepEqual(tools, preserved)
      assert.ok(!client.notifications.some((frame) => frame.method === RESUME_TOOLS_CHANGED))
    } finally {
      await env.close()
    }
  })
}

test('协调器：活动回合不提前回写；生效通知更新；过期快照不能盖掉通知', async () => {
  let tools: unknown[] = [ECHO_SPEC]
  let saved: unknown[] = []
  let pending: unknown[] = []
  let reads = 0
  const coordinator = new ResumeTools(
    () => ({ 'tools.machine': true }),
    {
      setTools: (_id, value) => {
        saved = value
      },
    },
    () => false,
  )
  const request = async (method: string, params: any) => {
    if (method === RESUME_TOOLS_READ) {
      reads++
      const old = tools
      if (reads === 2) {
        tools = pending
        coordinator.observe(RESUME_TOOLS_CHANGED, {
          threadId: 't',
          dynamicTools: tools,
          instance: 'engine',
          revision: 1,
        })
      }
      return { dynamicTools: old, restricted: false, instance: 'engine', revision: 0 }
    }
    pending = params.dynamicTools
    assert.deepEqual(saved, [ECHO_SPEC], '活动回合不能提前回写')
    return { thread: { id: 't' } }
  }
  await coordinator.resume('pi', { threadId: 't' }, request)
  assert.ok(names(saved).includes('litch_machine'))
  assert.deepEqual(saved, tools)
  coordinator.observe(RESUME_TOOLS_CHANGED, {
    threadId: 't',
    dynamicTools: [],
    instance: 'engine',
    revision: 0,
  })
  assert.deepEqual(saved, tools, '另一条连接迟到的通知不能回写旧工具')
})

test('协调器：只读、临时、已结束经理恢复不增加工具', async () => {
  for (const restricted of [true, false]) {
    const coordinator = new ResumeTools(
      () => ({ 'tools.machine': true }),
      {
        setTools: (_id, tools) => assert.deepEqual(tools, []),
      },
      () => !restricted,
    )
    await coordinator.resume(
      'claude-code',
      { threadId: 't', dynamicTools: [ECHO_SPEC] },
      async (method, params: any) => {
        if (method === RESUME_TOOLS_READ)
          return { dynamicTools: [], restricted, instance: 'engine', revision: 0 }
        assert.equal(params.dynamicTools, undefined)
        return {}
      },
    )
  }
})

test('Codex 恢复仍不刷新工具，不发送私有工具查询', async () => {
  const env = codexRig()
  try {
    const client = env.connect()
    await client.initialize(['harness'])
    const { thread } = await client.call('thread/start', { harness: 'codex' })
    await client.call('thread/resume', { threadId: thread.id })
    assert.equal(sentTo(env.codex, 'thread/resume').at(-1).dynamicTools, undefined)
    assert.equal(sentTo(env.codex, RESUME_TOOLS_READ).length, 0)
  } finally {
    await env.close()
  }
})

test('经理显式替换与普通恢复共用锁，角色定义不会被较早的恢复覆盖', async () => {
  let release!: () => void
  let enter!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  let tools: unknown[] = [ECHO_SPEC]
  let revision = 0
  let paused = false
  const applied: unknown[][] = []
  const coordinator = new ResumeTools(
    () => ({ 'tools.browser': false }),
    { setTools() {} },
    () => false,
  )
  const request = async (method: string, params: any) => {
    if (method === RESUME_TOOLS_READ) {
      if (!paused) {
        paused = true
        enter()
        await gate
      }
      return { dynamicTools: tools, instance: 'engine', revision, restricted: false }
    }
    tools = params.dynamicTools
    revision++
    applied.push(tools)
    return {}
  }
  const ordinary = coordinator.resume('claude-code', { threadId: 't' }, request)
  await entered
  const replacement = [{ ...ECHO_SPEC, description: '新的角色定义' }]
  const reset = coordinator.resume(
    'claude-code',
    { threadId: 't', dynamicTools: replacement },
    request,
    true,
  )
  assert.deepEqual(applied, [])
  release()
  await Promise.all([ordinary, reset])
  assert.deepEqual(applied, [[ECHO_SPEC], replacement])
  await coordinator.resume('claude-code', { threadId: 't' }, request)
  assert.deepEqual(tools, replacement)
})
