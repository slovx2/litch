// litch_tasks（模型在会话里管定时任务的工具）由设备进程自己执行：
// 客户端连接对应的上游连接上截下来答，不转给客户端；原生 codex 发给每条订阅连接的几份只答一份；
// create 默认在发起调用的会话里接着发，new_thread 沿用这个会话的目录、工作区和设置。
import assert from 'node:assert/strict'
import test from 'node:test'
import { codexRig } from './codex-kit.mjs'
import { codexThread } from './fake-codex.mjs'
import type { FakeConnection } from './fake-upstream.mjs'
import { settle, type TestClient } from './helpers.mjs'
import { DECLARED, TaskEngine, taskRig, tasksClient, until } from './task-kit.mjs'

let serial = 0

/** 以引擎的身份在一条上游连接上发一次 litch_tasks 调用 */
function call(
  connection: FakeConnection,
  threadId: string,
  tool: string,
  args: unknown,
  id: string | number = `call-${++serial}`,
  callId = `c-${serial}`,
): string | number {
  connection.send({
    id,
    method: 'item/tool/call',
    params: { threadId, turnId: 't1', callId, namespace: 'litch_tasks', tool, arguments: args },
  })
  return id
}

async function answer(connection: FakeConnection, id: string | number): Promise<any> {
  await until('设备答了', () => connection.answers.some((frame) => frame.id === id))
  return connection.answers.find((frame) => frame.id === id).result
}

const json = (result: any) => JSON.parse(result.contentItems[0].text)
const toolCalls = (client: TestClient) =>
  client.requests.filter((frame) => frame.method === 'item/tool/call')

test('适配器的引擎：litch_tasks 的调用由设备答，不转给客户端；握手替连接声明了 litch_tasks，客户端自己的声明照留', async () => {
  const engine = new TaskEngine()
  engine.threads.push({ id: 'pi-1', updatedAt: 1, cwd: '/work/app' })
  const target = taskRig({ pi: engine })
  try {
    const client = target.connect()
    await client.initialize([...DECLARED, 'clientTools'], {
      litchClientTools: { namespaces: ['litch_browser'] },
    })
    const greeting = engine.seen.find((item) => item.method === 'initialize')?.params
    assert.deepEqual(greeting.capabilities.litchClientTools, {
      namespaces: ['litch_browser', 'litch_tasks'],
    })
    assert.deepEqual(greeting.capabilities.litchExtensions, [...DECLARED, 'clientTools'])
    const upstream = engine.live.at(-1) as FakeConnection

    const created = await answer(
      upstream,
      call(upstream, 'pi-1', 'create', {
        name: '早报',
        prompt: '看一下昨晚的构建。',
        schedule: { type: 'daily', time: '09:00' },
        timezone: 'Asia/Shanghai',
      }),
    )
    assert.equal(created.success, true)
    const task = json(created).task
    assert.deepEqual(task.target, { kind: 'thread', harness: 'pi', threadId: 'pi-1' })
    assert.deepEqual(task.origin, { kind: 'tool', harness: 'pi', threadId: 'pi-1' })
    assert.equal(toolCalls(client).length, 0, '客户端收不到')
    // 声明了 deviceTasks 的客户端照样收到任务变化的通知
    await client.waitFor((frame) => frame.method === 'litch/task/changed')

    // new_thread：沿用这个会话的目录和设置（引擎恢复会话时报的模型）
    const fresh = json(
      await answer(
        upstream,
        call(upstream, 'pi-1', 'create', {
          name: '周报',
          prompt: '写周报。',
          schedule: { type: 'weekly', days: ['FR'], time: '17:00' },
          target: 'new_thread',
          status: 'paused',
        }),
      ),
    ).task
    assert.deepEqual(fresh.target, {
      kind: 'newThread',
      harness: 'pi',
      cwd: '/work/app',
      workspaceId: null,
      settings: { model: 'fake', effort: null, permission: null },
    })
    assert.equal(fresh.status, 'paused')

    const listed = json(await answer(upstream, call(upstream, 'pi-1', 'list', {})))
    assert.deepEqual(
      listed.tasks.map((item: any) => item.name),
      ['早报', '周报'],
    )
    const updated = json(
      await answer(upstream, call(upstream, 'pi-1', 'update', { id: task.id, status: 'paused' })),
    )
    assert.equal(updated.task.status, 'paused')
    assert.equal(updated.task.revision, 2)
    const ran = json(await answer(upstream, call(upstream, 'pi-1', 'run_now', { id: task.id })))
    assert.equal(ran.deduplicated, false)
    assert.equal(ran.run.trigger, 'manual')
    const removed = json(await answer(upstream, call(upstream, 'pi-1', 'delete', { id: fresh.id })))
    assert.deepEqual(removed, { deleted: fresh.id })

    // 出错：一句说明，开头是 [litch:invalid]
    const bad = await answer(
      upstream,
      call(upstream, 'pi-1', 'create', {
        name: 'x',
        prompt: 'y',
        schedule: { type: 'interval', minutes: 1 },
      }),
    )
    assert.equal(bad.success, false)
    assert.match(bad.contentItems[0].text, /^\[litch:invalid\] .*\(field: schedule\.minutes\)\.$/)
    const unknown = await answer(upstream, call(upstream, 'pi-1', 'explode', {}))
    assert.match(unknown.contentItems[0].text, /^\[litch:invalid\] litch_tasks has no tool/)
    const missing = await answer(upstream, call(upstream, 'pi-1', 'run_now', { id: 'nope' }))
    assert.match(missing.contentItems[0].text, /^\[litch:invalid\] There is no task nope/)
    assert.equal(toolCalls(client).length, 0)
  } finally {
    await target.close()
  }
})

test('原生 codex：同一次 litch_tasks 调用发给每条订阅连接，设备只答一份，哪条客户端都收不到', async () => {
  const env = codexRig()
  try {
    const thread = codexThread(1, 400).id
    const desktop = env.connect()
    await desktop.initialize(['harness', 'clientTools'], {
      litchClientTools: { namespaces: ['litch_browser'] },
    })
    const phone = await tasksClient(env)
    for (const client of [desktop, phone]) await client.call('thread/resume', { threadId: thread })
    // 原生 codex 不认识我们的扩展键：握手里没有
    for (const greeting of env.codex.greetings) {
      assert.equal('litchExtensions' in greeting.capabilities, false)
      assert.equal('litchClientTools' in greeting.capabilities, false)
    }
    const id = 7
    for (const connection of env.codex.live) call(connection, thread, 'list', {}, id, 'same-call')
    await until('答了', () => env.codex.connections.some((item) => item.answers.length > 0))
    await settle(50)
    const answers = env.codex.connections.flatMap((connection) => connection.answers)
    assert.equal(answers.length, 1, JSON.stringify(answers))
    assert.equal(answers[0].id, id)
    assert.equal(answers[0].result.success, true)
    assert.deepEqual(json(answers[0].result), { tasks: [] })
    for (const client of [desktop, phone]) assert.equal(toolCalls(client).length, 0)
  } finally {
    await env.close()
  }
})

test('原生 codex 上的任务建会话：权限给预设和配套的审批策略，来源记 automation，带上 litch_tasks；codex 都认', async () => {
  const env = codexRig()
  try {
    const client = await tasksClient(env)
    const { task } = await client.call('litch/task/create', {
      name: '巡检',
      prompt: '看一眼。',
      schedule: { type: 'interval', minutes: 60 },
      target: {
        kind: 'newThread',
        harness: 'codex',
        cwd: env.stateDir,
        workspaceId: null,
        settings: { model: null, effort: 'high', permission: ':workspace' },
      },
      status: 'paused',
    })
    await client.call('litch/task/runNow', { id: task.id })
    await until('发了回合', () => env.codex.seen.some((item) => item.method === 'turn/start'))
    const start = env.codex.seen.find((item) => item.method === 'thread/start')?.params
    assert.equal(start.permissions, ':workspace')
    assert.equal(start.approvalPolicy, 'on-request')
    assert.equal(start.threadSource, 'automation')
    assert.deepEqual(
      start.dynamicTools.map((tool: any) => tool.name),
      ['litch_tasks'],
    )
    const turn = env.codex.seen.find((item) => item.method === 'turn/start')?.params
    assert.equal(turn.effort, 'high')
  } finally {
    // 收尾时 codexRig 核对 codex 没有悄悄丢掉的字段
    await env.close()
  }
})
