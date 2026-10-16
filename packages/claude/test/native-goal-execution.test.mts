import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { saveArtifact } from './fixtures/artifacts.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

const goalTool = (status: string) => ({
  type: 'tool_use',
  id: randomUUID(),
  name: 'mcp__codex_harness_adapter_goal__update_goal',
  input: { status },
})

async function modelCalls(llm: MockLLM, expected: number): Promise<void> {
  const deadline = Date.now() + 15_000
  while (llm.requests.length < expected && Date.now() < deadline) await delay(20)
  assert.equal(llm.requests.length, expected)
}

async function saveGoalEvidence(home: string): Promise<void> {
  const db = new DatabaseSync(join(home, 'adapter', 'state.sqlite'), { readOnly: true })
  try {
    await saveArtifact('goal-ledger', {
      goals: db.prepare('SELECT thread_id,goal_json FROM thread_goals').all(),
      accounting: db.prepare('SELECT thread_id,ledger_json FROM goal_ledgers').all(),
      tools: db
        .prepare('SELECT thread_id,call_id,payload_hash,result_json FROM tool_executions')
        .all(),
    })
  } finally {
    db.close()
  }
}

async function fixture(
  run: (home: string, llm: MockLLM, client: ProtocolClient) => Promise<void>,
  oauth = false,
) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'native-goal-execution-')))
  const llm = new MockLLM()
  const client = await ProtocolClient.start(
    home,
    await llm.start(),
    false,
    oauth ? 'oauth' : 'api-key',
  )
  try {
    await run(home, llm, client)
    llm.assertConsumed()
  } finally {
    await saveGoalEvidence(home)
    await client.close()
    await llm.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

test('GOAL-002：真实 SDK 自动回合读取前次写入并以原生目标工具结束，完整预算账本不重复累计', {
  timeout: 90_000,
}, async () => {
  await fixture(async (home, llm, client) => {
    const secret = randomUUID()
    const objective = '自动创建并读取目标文件 ' + randomUUID()
    const target = join(home, 'goal-result.txt')
    llm.enqueue((request) => {
      assert.ok(JSON.stringify(request).includes(objective))
      return [
        {
          type: 'tool_use',
          id: randomUUID(),
          name: 'Write',
          input: { file_path: target, content: secret },
        },
      ]
    })
    llm.enqueue(() => [{ type: 'text', text: '文件已写入；后续回合验证实际内容。' }])
    llm.enqueue((request) => {
      assert.ok(JSON.stringify(request).includes(objective))
      return [{ type: 'tool_use', id: randomUUID(), name: 'Read', input: { file_path: target } }]
    })
    llm.enqueue((request) => {
      assert.ok(JSON.stringify(request.messages).includes(secret), '真实 Read 结果必须回到模型')
      return [goalTool('complete')]
    })
    llm.enqueue(() => [{ type: 'text', text: '目标文件已验证。' }])
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
    await client.request('thread/goal/set', { threadId: thread.id, objective, tokenBudget: 2000 })
    await client.notification(
      'thread/goal/updated',
      (params) => params.threadId === thread.id && params.goal.status === 'complete',
    )
    const finalItem = await client.notification(
      'item/completed',
      (params) =>
        params.threadId === thread.id &&
        params.item.type === 'agentMessage' &&
        params.item.text.includes('目标文件已验证'),
    )
    assert.equal((await client.completed(finalItem.turnId)).status, 'completed')
    assert.equal(await readFile(target, 'utf8'), secret)
    const { goal } = await client.request('thread/goal/get', { threadId: thread.id })
    assert.equal(goal.status, 'complete')
    assert.equal(goal.tokensUsed, 480, 'complete 之后模型回复不再计入目标')
    const turns = client.trace.filter(
      (message) => message.method === 'turn/started' && message.params.threadId === thread.id,
    )
    assert.equal(turns.length, 2)
    assert.notEqual(turns[0].params.turn.id, turns[1].params.turn.id)
    await delay(250)
    assert.equal(llm.requests.length, 5)
  })
})

test('GOAL-002：软预算容许真实工具完成，达预算后停止续跑且 RPC 更新不清除账本', {
  timeout: 60_000,
}, async () => {
  await fixture(async (home, llm, client) => {
    const target = join(home, 'soft-budget.txt')
    const secret = randomUUID()
    llm.enqueue(() => [
      {
        type: 'tool_use',
        id: randomUUID(),
        name: 'Write',
        input: { file_path: target, content: secret },
      },
    ])
    llm.enqueue(() => [{ type: 'text', text: '软预算回合完成。' }])
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
    await client.request('thread/goal/set', {
      threadId: thread.id,
      objective: '验证软预算完整回合',
      tokenBudget: 1,
    })
    await client.notification(
      'thread/goal/updated',
      (params) => params.threadId === thread.id && params.goal.status === 'budgetLimited',
    )
    assert.equal(await readFile(target, 'utf8'), secret)
    const { goal } = await client.request('thread/goal/get', { threadId: thread.id })
    assert.equal(goal.tokensUsed, 240)
    assert.equal(goal.tokenBudget, 1)
    await delay(250)
    assert.equal(llm.requests.length, 2)
    const { goal: changed } = await client.request('thread/goal/set', {
      threadId: thread.id,
      objective: 'RPC 部分更新',
      status: 'paused',
      tokenBudget: null,
    })
    assert.equal(changed.tokensUsed, goal.tokensUsed)
    assert.equal(changed.createdAt, goal.createdAt)
  })
})

test('GOAL-002：运行中暂停不打断回合，暂停后的真实模型用量不计入目标', {
  timeout: 60_000,
}, async () => {
  await fixture(async (home, llm, client) => {
    let started!: () => void
    const modelStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    llm.enqueue(async () => {
      started()
      await released
      return [{ type: 'text', text: '暂停后的回复' }]
    })
    const { thread } = await client.request('thread/start', { cwd: home })
    await client.request('thread/goal/set', { threadId: thread.id, objective: '验证运行中暂停' })
    await modelStarted
    await delay(1100)
    await client.request('thread/goal/set', { threadId: thread.id, status: 'paused' })
    release()
    const completed = await client.notification(
      'turn/completed',
      (params) => params.threadId === thread.id,
    )
    assert.equal(completed.turn.status, 'completed')
    const { goal } = await client.request('thread/goal/get', { threadId: thread.id })
    assert.equal(goal.status, 'paused')
    assert.equal(goal.tokensUsed, 0)
    assert.ok(goal.timeUsedSeconds >= 1)
    assert.equal(llm.requests.length, 1)
  })
})

test('GOAL-002：真实 Bash 副作用后崩溃，目标恢复必须阻塞且不重放未确认工具', {
  timeout: 60_000,
}, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'native-goal-crash-')))
  const llm = new MockLLM()
  const url = await llm.start()
  let client = await ProtocolClient.start(home, url)
  const db = new DatabaseSync(join(home, 'adapter', 'state.sqlite'))
  try {
    const target = join(home, 'effect-count.txt')
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
    llm.enqueue(() => [
      {
        type: 'tool_use',
        id: 'goal_uncertain_bash',
        name: 'Bash',
        input: {
          command: 'printf EXECUTED_ONCE >> ' + quote(target) + '; /bin/sleep 30',
          timeout: 60000,
        },
      },
    ])
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
    await client.request('thread/goal/set', {
      threadId: thread.id,
      objective: '追加一次实际记录并等待工具完成',
    })
    const deadline = Date.now() + 20_000
    while (
      Date.now() < deadline &&
      (await readFile(target, 'utf8').catch(() => '')) !== 'EXECUTED_ONCE'
    )
      await delay(20)
    assert.equal(await readFile(target, 'utf8'), 'EXECUTED_ONCE')
    const intent = () =>
      db
        .prepare('SELECT result_json FROM tool_executions WHERE thread_id=? AND call_id=?')
        .get(thread.id, 'native:goal_uncertain_bash')
    assert.equal(intent()?.result_json, null, '原生意图必须先于真实副作用落库')
    client.crash()
    await client.close()
    client = await ProtocolClient.start(home, url)
    assert.equal(llm.requests.length, 1, '仅启动进程不能恢复目标')
    await client.request('thread/resume', { threadId: thread.id })
    await client.notification(
      'thread/goal/updated',
      (params) => params.threadId === thread.id && params.goal.status === 'blocked',
    )
    await delay(300)
    assert.equal(llm.requests.length, 1, '存在未确认副作用时不能自动恢复模型')
    assert.equal(await readFile(target, 'utf8'), 'EXECUTED_ONCE')
    assert.equal(intent()?.result_json, null, '不能用目标状态伪造工具确认结果')
    await client.request('thread/goal/set', { threadId: thread.id, status: 'active' })
    await delay(300)
    assert.equal(
      (await client.request('thread/goal/get', { threadId: thread.id })).goal.status,
      'blocked',
    )
    assert.equal(llm.requests.length, 1)
    llm.assertConsumed()
  } finally {
    await saveGoalEvidence(home)
    db.close()
    await client.close()
    await llm.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('GOAL-002：用户中断后重启只在 resume 续跑，active 分叉独立，归档中断且取消自动队列', {
  timeout: 90_000,
}, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'native-goal-lifecycle-')))
  const llm = new MockLLM()
  const url = await llm.start()
  let client = await ProtocolClient.start(home, url)
  const release: Array<() => void> = []
  const held = () =>
    new Promise<Array<Record<string, unknown>>>((resolve) =>
      release.push(() => resolve([{ type: 'text', text: '已中断的响应' }])),
    )
  try {
    llm.enqueue(() => [{ type: 'text', text: '目标第一步完成，等待继续。' }])
    llm.enqueue(held)
    llm.enqueue(held)
    llm.enqueue(() => [goalTool('complete')])
    llm.enqueue(() => [{ type: 'text', text: '恢复后完成目标。' }])
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    await client.request('thread/goal/set', {
      threadId: thread.id,
      objective: '验证目标中断恢复',
      tokenBudget: 2000,
    })
    await modelCalls(llm, 2)
    const second = client.trace
      .filter((entry) => entry.method === 'turn/started' && entry.params.threadId === thread.id)
      .at(-1).params.turn.id
    await client.request('turn/interrupt', { threadId: thread.id, turnId: second })
    release.shift()?.()
    assert.equal((await client.completed(second)).status, 'interrupted')
    assert.equal(
      (await client.request('thread/goal/get', { threadId: thread.id })).goal.status,
      'active',
    )
    await delay(250)
    assert.equal(llm.requests.length, 2, '用户中断不能立即续跑')
    const { thread: fork } = await client.request('thread/fork', { threadId: thread.id })
    assert.equal((await client.request('thread/goal/get', { threadId: fork.id })).goal, null)
    await client.request('thread/resume', { threadId: fork.id })
    await delay(100)
    assert.equal(llm.requests.length, 2, '分叉不能复制活动目标并自动执行')
    await client.close()
    client = await ProtocolClient.start(home, url)
    await delay(250)
    assert.equal(llm.requests.length, 2, '重启与 initialize 不能自行恢复目标')
    await client.request('thread/resume', { threadId: thread.id })
    await modelCalls(llm, 3)
    const third = client.trace.find(
      (entry) => entry.method === 'turn/started' && entry.params.threadId === thread.id,
    ).params.turn.id
    assert.equal(
      (await client.request('thread/unsubscribe', { threadId: thread.id })).status,
      'unsubscribed',
    )
    await client.request('thread/archive', { threadId: thread.id })
    release.shift()?.()
    const archived = new DatabaseSync(join(home, 'adapter', 'state.sqlite'), { readOnly: true })
    try {
      assert.equal(
        archived.prepare('SELECT status FROM turns WHERE id=?').get(third)?.status,
        'interrupted',
        '取消原订阅后归档也必须中断真实回合',
      )
    } finally {
      archived.close()
    }
    assert.equal((await client.completed(third)).status, 'interrupted')
    assert.equal(
      (await client.request('thread/goal/get', { threadId: thread.id })).goal.status,
      'active',
      '归档目标仍可读取，中断不能隐式更改目标状态',
    )
    await client.request('thread/unarchive', { threadId: thread.id })
    await delay(250)
    assert.equal(llm.requests.length, 3, '取消归档不应自动执行')
    await client.request('thread/resume', { threadId: thread.id })
    await client.notification(
      'thread/goal/updated',
      (params) => params.threadId === thread.id && params.goal.status === 'complete',
    )
    const final = await client.notification(
      'item/completed',
      (params) => params.threadId === thread.id && params.item.text === '恢复后完成目标。',
    )
    assert.equal((await client.completed(final.turnId)).status, 'completed')
    assert.equal(
      (await client.request('thread/goal/get', { threadId: thread.id })).goal.tokensUsed,
      240,
    )
    assert.equal(llm.requests.length, 5)
    llm.assertConsumed()
  } finally {
    await saveGoalEvidence(home)
    for (const done of release) done()
    await client.close()
    await llm.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('GOAL-002：工作流列表本地完成必须清理目标账本，随后激活仍能执行真实 SDK', {
  timeout: 60_000,
}, async () => {
  await fixture(async (home, llm, client) => {
    const { thread } = await client.request('thread/start', { cwd: home })
    await client.request('thread/goal/set', {
      threadId: thread.id,
      objective: '工作流列表后继续目标',
      status: 'paused',
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '/workflows', text_elements: [] }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    assert.equal(llm.requests.length, 0, '工作流列表不能伪造模型调用')
    const db = new DatabaseSync(join(home, 'adapter', 'state.sqlite'), { readOnly: true })
    try {
      const row = db
        .prepare('SELECT ledger_json FROM goal_ledgers WHERE thread_id=?')
        .get(thread.id)
      const ledger = JSON.parse(String(row?.ledger_json))
      assert.equal(ledger.runningTurnId, null)
      assert.equal(ledger.activeSinceMs, null)
    } finally {
      db.close()
    }
    llm.enqueue(() => [goalTool('complete')])
    llm.enqueue(() => [{ type: 'text', text: '工作流列表后目标已完成。' }])
    await client.request('thread/goal/set', { threadId: thread.id, status: 'active' })
    const completed = await client.notification(
      'item/completed',
      (params) => params.threadId === thread.id && params.item.text === '工作流列表后目标已完成。',
    )
    assert.equal((await client.completed(completed.turnId)).status, 'completed')
    assert.equal(
      (await client.request('thread/goal/get', { threadId: thread.id })).goal.status,
      'complete',
    )
    assert.equal(llm.requests.length, 2)
  })
})

test('GOAL-002：模型 create_goal 仅替换完成目标并重置账本，未知参数明确拒绝', {
  timeout: 60_000,
}, async () => {
  await fixture(async (home, llm, client) => {
    const objective = '新的持续目标 ' + randomUUID()
    llm.enqueue(() => [{ type: 'text', text: '旧目标预算达到。' }])
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    await client.request('thread/goal/set', {
      threadId: thread.id,
      objective: '旧目标',
      tokenBudget: 1,
    })
    await client.notification(
      'thread/goal/updated',
      (params) => params.threadId === thread.id && params.goal.status === 'budgetLimited',
    )
    const { goal: old } = await client.request('thread/goal/set', {
      threadId: thread.id,
      status: 'complete',
    })
    assert.equal(old.tokensUsed, 120)
    llm.enqueue(() => [
      {
        type: 'tool_use',
        id: randomUUID(),
        name: 'mcp__codex_harness_adapter_goal__update_goal',
        input: { status: 'active' },
      },
    ])
    llm.enqueue((request) => {
      const result = request.messages
        .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
        .filter((block: any) => block.type === 'tool_result')
        .at(-1)
      assert.equal(result.is_error, true, '模型不能通过目标工具自行恢复或扩大授权')
      return [{ type: 'text', text: '无效目标更新已经拒绝。' }]
    })
    const rejected = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '检查无效工具参数' }],
    })
    assert.equal((await client.completed(rejected.turn.id)).status, 'completed')
    assert.equal(
      (await client.request('thread/goal/get', { threadId: thread.id })).goal.status,
      'complete',
    )
    llm.enqueue(() => [
      {
        type: 'tool_use',
        id: randomUUID(),
        name: 'mcp__codex_harness_adapter_goal__create_goal',
        input: { objective, token_budget: 300 },
      },
    ])
    llm.enqueue((request) => {
      const result = request.messages
        .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
        .filter((block: any) => block.type === 'tool_result')
        .at(-1)
      assert.ok(JSON.stringify(result).includes(objective))
      assert.match(JSON.stringify(result), /tokensUsed[^0-9]*0/)
      return [goalTool('complete')]
    })
    llm.enqueue(() => [{ type: 'text', text: '新目标完成。' }])
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '明确创建并完成新的持续目标' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    const { goal } = await client.request('thread/goal/get', { threadId: thread.id })
    assert.equal(goal.objective, objective)
    assert.equal(goal.status, 'complete')
    assert.equal(goal.tokenBudget, 300)
    assert.equal(goal.tokensUsed, 120)
    assert.equal(llm.requests.length, 6)
  })
})

for (const quota of [false, true]) {
  test('GOAL-002：真实 SDK ' +
    (quota ? '订阅额度耗尽保持 usageLimited' : '普通 API 429 保持 blocked') +
    '，恢复需要显式激活', { timeout: 60_000 }, async () => {
    await fixture(async (home, llm, client) => {
      llm.enqueue(() => ({
        status: 429,
        message: 'Local bounded rate-limit test',
        ...(quota
          ? {
              headers: {
                'anthropic-ratelimit-unified-status': 'rejected',
                'anthropic-ratelimit-unified-representative-claim': 'five_hour',
                'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 1),
                'anthropic-ratelimit-unified-5h-status': 'rejected',
              },
            }
          : {}),
      }))
      const { thread } = await client.request('thread/start', {
        cwd: home,
        sandbox: 'read-only',
        approvalPolicy: 'never',
      })
      await client.request('thread/goal/set', { threadId: thread.id, objective: '限额恢复测试' })
      const started = await client.notification(
        'turn/started',
        (params) => params.threadId === thread.id,
      )
      assert.equal((await client.completed(started.turn.id)).status, 'failed')
      const { goal } = await client.request('thread/goal/get', { threadId: thread.id })
      assert.equal(goal.status, quota ? 'usageLimited' : 'blocked')
      assert.equal(goal.tokensUsed, 0)
      await delay(1500)
      await client.request('thread/resume', { threadId: thread.id })
      await delay(250)
      assert.equal(llm.requests.length, 1, '时间经过和 resume 不能解除模型限额或阻塞')
      llm.enqueue(() => [goalTool('complete')])
      llm.enqueue(() => [{ type: 'text', text: '显式激活后完成。' }])
      await client.request('thread/goal/set', { threadId: thread.id, status: 'active' })
      const final = await client.notification(
        'item/completed',
        (params) => params.threadId === thread.id && params.item.text === '显式激活后完成。',
      )
      assert.equal((await client.completed(final.turnId)).status, 'completed')
      assert.equal(
        (await client.request('thread/goal/get', { threadId: thread.id })).goal.tokensUsed,
        120,
      )
    }, quota)
  })
}

test('GOAL-002：清除运行中目标保持当前回合完成并取消后续自动执行', {
  timeout: 60_000,
}, async () => {
  await fixture(async (home, llm, client) => {
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    llm.enqueue(async () => {
      await released
      return [{ type: 'text', text: '当前回合正常完成。' }]
    })
    const { thread } = await client.request('thread/start', { cwd: home })
    await client.request('thread/goal/set', { threadId: thread.id, objective: '验证清除取消续跑' })
    await modelCalls(llm, 1)
    const started = await client.notification(
      'turn/started',
      (params) => params.threadId === thread.id,
    )
    assert.deepEqual(await client.request('thread/goal/clear', { threadId: thread.id }), {
      cleared: true,
    })
    release()
    assert.equal((await client.completed(started.turn.id)).status, 'completed')
    assert.equal((await client.request('thread/goal/get', { threadId: thread.id })).goal, null)
    await delay(250)
    assert.equal(llm.requests.length, 1)
  })
})

test('GOAL-002：真实 SDK 计划模式和只读权限仍阻止文件副作用，内部目标工具不扩大权限', {
  timeout: 60_000,
}, async () => {
  await fixture(async (home, llm, client) => {
    const target = join(home, 'forbidden-goal-file.txt')
    llm.enqueue(() => [
      { type: 'tool_use', id: 'goal_enter_plan', name: 'EnterPlanMode', input: {} },
    ])
    llm.enqueue(() => [
      {
        type: 'tool_use',
        id: 'goal_forbidden_write',
        name: 'Write',
        input: { file_path: target, content: randomUUID() },
      },
    ])
    llm.enqueue((request) => {
      const result = request.messages
        .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
        .find(
          (block: any) =>
            block.type === 'tool_result' && block.tool_use_id === 'goal_forbidden_write',
        )
      assert.equal(result.is_error, true, '文件拒绝必须进入真实模型上下文')
      return [goalTool('complete')]
    })
    llm.enqueue(() => [{ type: 'text', text: '已验证权限边界，继续保持计划模式。' }])
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    await client.request('thread/goal/set', {
      threadId: thread.id,
      objective: '验证计划和只读权限边界',
      tokenBudget: 1000,
    })
    const started = await client.notification(
      'turn/started',
      (params) => params.threadId === thread.id,
    )
    assert.equal((await client.completed(started.turn.id)).status, 'completed')
    await assert.rejects(readFile(target, 'utf8'), { code: 'ENOENT' })
    assert.equal(
      (await client.request('thread/goal/get', { threadId: thread.id })).goal.status,
      'complete',
    )
    const settings = client.trace
      .filter(
        (message) =>
          message.method === 'thread/settings/updated' && message.params.threadId === thread.id,
      )
      .at(-1)
    assert.equal(settings.params.threadSettings.collaborationMode.mode, 'plan')
    assert.equal(llm.requests.length, 4)
  })
})
