import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import { parseSessionEvent } from '../../protocol/src/session-tree.mjs'
import { questionSnapshot } from '../src/manager-questions.mjs'
import { codexRig, sentTo } from './codex-kit.mjs'
import { rig } from './helpers.mjs'
import { treeRig, until } from './tree-kit.mjs'

function present<T>(value: T | null | undefined): T {
  assert.ok(value)
  return value
}

async function setup(fork = true, safe = true) {
  const env = treeRig()
  env.pi.declaration = {
    extensions: ['clientTools'],
    features: { ephemeralFork: fork, managerQuestions: safe },
  }
  const client = env.connect()
  await client.initialize(['harness', 'litchManager'])
  const { manager, threadId } = await client.call(MANAGER_METHOD.create, {
    cwd: env.stateDir,
    harness: 'pi',
    model: null,
    effort: null,
    name: '旁问测试',
    scope: '',
    rules: '',
    template: 'blank',
    firstTask: '',
    dispatch: MANAGER_DEFAULT_DISPATCH,
    contact: MANAGER_DEFAULT_CONTACT,
  })
  await until(() => env.pi.running(threadId), '经理开始')
  const add = () =>
    (
      env.device.managers.writer.tool(manager.id, 'add', {
        kind: 'decision',
        decision: { title: '选择方案', background: '需要核对的背景' },
      }) as { id: `D-${number}` }
    ).id
  const id = add()
  env.pi.end(threadId, 'completed', '经理首轮完成')
  await until(() => !env.device.sessionTree.isActive(threadId), '经理结束')
  const state = () => present(env.device.managers.store.question(manager.id, id))
  const ask = async (question: string, decisionId = id) => {
    const revision = present(env.device.managers.store.object(manager.id, decisionId)).revision
    await client.call(MANAGER_METHOD.questionAsk, {
      managerId: manager.id,
      decisionId,
      revision,
      question,
    })
    await until(() => {
      const current = env.device.managers.store.question(manager.id, decisionId)
      return !!current?.threadId && env.pi.running(current.threadId)
    }, '旁问开始')
    return present(present(env.device.managers.store.question(manager.id, decisionId)).threadId)
  }
  const finish = async (answer: string, decisionId = id) => {
    const current = present(env.device.managers.store.question(manager.id, decisionId))
    env.pi.end(present(current.threadId), 'completed', answer)
    await until(
      () =>
        env.device.managers.store.question(manager.id, decisionId)?.discussion.messages.at(-1)
          ?.status === 'completed',
      '旁问结束',
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return { env, client, manager, threadId, id, add, state, ask, finish }
}

test('旁问快照：经理忙时只取此前回合，没有历史也不复制进行中内容', () => {
  assert.deepEqual(
    questionSnapshot([
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'inProgress' },
    ]),
    { source: 'a', position: { beforeTurnId: 'b' } },
  )
  assert.deepEqual(questionSnapshot([{ id: 'b', status: 'inProgress' }]), {
    source: '',
    position: { beforeTurnId: 'b' },
  })
  assert.deepEqual(questionSnapshot([]), { source: '', position: {} })
})

test('两轮旁问共用分叉；不同决策隔离；设备拒绝开线、越权改板及客户端工具', async () => {
  const { env, client, manager, id, add, state, ask, finish } = await setup()
  try {
    const fork = await ask('为什么？')
    const created = present(env.pi.seen.find((call) => call.method === 'thread/fork'))
    assert.equal(created.params.ephemeral, true)
    assert.equal(created.params.sandbox, 'read-only')
    assert.deepEqual(
      created.params.dynamicTools[0].tools.map((tool: { name: string }) => tool.name),
      ['summary', 'get', 'update', 'close'],
    )
    for (const [namespace, tool, args] of [
      ['litch_sessions', 'start', { title: '不能开线' }],
      ['litch_manager', 'status', { text: '不能改板' }],
      ['litch_echo', 'echo', { text: '不能发消息' }],
    ] as const) {
      const call = await env.pi.callTool(fork, namespace, tool, args)
      assert.equal(call?.answer.result.success, false)
    }
    const summary = await env.pi.callTool(fork, 'litch_manager', 'summary', {})
    assert.equal(summary?.answer.result.success, true)
    await assert.rejects(
      client.call(MANAGER_METHOD.questionAsk, {
        managerId: manager.id,
        decisionId: id,
        revision: 1,
        question: '并发请求',
      }),
    )
    const during = await client.call(MANAGER_METHOD.answersSubmit, {
      managerId: manager.id,
      answers: [{ decisionId: id, revision: 1, optionId: null, text: '还在问' }],
    })
    assert.equal(during.accepted.length, 0)
    await finish('因为上下文')
    assert.equal(await ask('再解释'), fork)
    await finish('进一步解释')
    assert.equal(state().discussion.messages.length, 2)
    const other = add()
    assert.notEqual(await ask('另一项背景', other), fork)
    await finish('独立回答', other)
    assert.equal(state().discussion.messages.length, 2)
    const second = env.connect()
    await second.initialize(['harness', 'litchManager'])
    const board = await second.call(MANAGER_METHOD.boardRead, { managerId: manager.id })
    assert.equal(board.board.decisions[0].discussion.messages[1].answer, '进一步解释')
  } finally {
    await env.close()
  }
})

test('经理新增已完成回合或决策变更才重分叉，携带旧问答引文', async () => {
  const { env, client, manager, threadId, id, state, ask, finish } = await setup()
  try {
    const first = await ask('原问题')
    await finish('原回答')
    await client.call('turn/start', { threadId, input: [{ type: 'text', text: '新任务' }] })
    assert.equal(await ask('经理忙时继续'), first)
    await finish('仍用原背景')
    env.pi.end(threadId, 'completed', '新进展')
    const second = await ask('进展之后')
    assert.notEqual(second, first)
    assert.equal(state().discussion.messages.at(-1)?.refreshed, true)
    assert.match(JSON.stringify(env.pi.current(second)), /原回答/)
    await finish('新背景')
    env.device.managers.writer.tool(manager.id, 'update', {
      kind: 'decision',
      id,
      patch: { background: '已修改' },
      why: '新证据',
    })
    assert.notEqual(await ask('决策变更'), second)
    await finish('已核对修改')
  } finally {
    await env.close()
  }
})

test('转给经理不答决策且幂等；交答复附问答；已答复和关闭后仍可追问、修改答案', async () => {
  const { env, client, manager, id, add, state, ask, finish } = await setup()
  try {
    await ask('依据是什么')
    await finish('依据路径')
    const forward = () =>
      client.call(MANAGER_METHOD.questionForward, { managerId: manager.id, decisionId: id })
    assert.equal((await forward()).queued, true)
    assert.equal((await forward()).queued, false)
    assert.equal(env.device.managers.store.object(manager.id, id)?.status, 'open')
    const submit = async (decisionId: string, text: string) =>
      client.call(MANAGER_METHOD.answersSubmit, {
        managerId: manager.id,
        answers: [
          {
            decisionId,
            revision: present(env.device.managers.store.object(manager.id, decisionId)).revision,
            optionId: null,
            text,
          },
        ],
      })
    const first = await submit(id, '采用方案')
    assert.equal(first.accepted.length, 1)
    const events = env.pi.seen
      .filter((call) => ['turn/start', 'turn/steer'].includes(call.method))
      .map((call) => call.params.input?.[0]?.text ?? '')
      .map((text) => parseSessionEvent(text).event)
      .filter((event) => event?.kind === 'manager-answers')
    // 投递是后台执行；队列和已投递两处都算，不能依赖微任务时序。
    const queued = env.device.managers.store
      .deliveries(manager.id)
      .map((event) => parseSessionEvent(event.text).event)
    assert.ok(
      [...events, ...queued].some(
        (event) => event?.manager?.answers?.[0]?.discussion?.messages[0]?.answer === '依据路径',
      ),
    )
    await until(() => state().threadId === null, '提交后释放')
    await ask('答复后再问')
    await finish('答复后的解释')
    assert.equal((await submit(id, '改选另一方案')).accepted[0].answer.text, '改选另一方案')
    const closed = add()
    env.device.managers.writer.tool(manager.id, 'close', {
      kind: 'decision',
      id: closed,
      status: 'withdrawn',
      reason: '暂不处理',
    })
    await ask('关闭后问', closed)
    await finish('关闭原因', closed)
    const revised = await submit(closed, '仍然要做')
    assert.equal(revised.accepted[0].status, 'answered')
    assert.equal(revised.accepted[0].closed, null)
    assert.ok(
      env.device.managers.store
        .changes(manager.id)
        .some((change) => change.before?.status === 'withdrawn'),
    )
  } finally {
    await env.close()
  }
})

test('轻会话带看板；不支持只读时不启动回合', async () => {
  const light = await setup(false)
  try {
    const id = await light.ask('轻会话问题')
    assert.equal(light.state().discussion.light, true)
    assert.match(JSON.stringify(light.env.pi.current(id)), /no manager conversation history/)
    await light.finish('轻会话回答')
  } finally {
    await light.env.close()
  }
  const unsafe = await setup(false, false)
  try {
    await unsafe.client.call(MANAGER_METHOD.questionAsk, {
      managerId: unsafe.manager.id,
      decisionId: unsafe.id,
      revision: 1,
      question: '只读？',
    })
    await until(() => unsafe.state().discussion.messages[0]?.status === 'failed', '拒绝不安全引擎')
    assert.equal(unsafe.state().threadId, null)
    assert.equal(unsafe.env.pi.seen.filter((call) => call.method === 'turn/start').length, 1)
  } finally {
    await unsafe.env.close()
  }
})

test('设备重启保留问答和退休分叉禁写身份，下次用引文重建', async () => {
  const first = await setup()
  let next: ReturnType<typeof rig> | undefined
  try {
    const old = await first.ask('重启前的问题')
    await first.finish('重启前的回答')
    await first.env.device.close()
    next = rig({ pi: first.env.pi }, {}, { stateDir: first.env.stateDir })
    const questions = next.device.managers.questions
    assert.equal(questions.allowed(old, 'litch_sessions', 'send'), false)
    assert.equal(next.device.managers.store.question(first.manager.id, first.id)?.threadId, null)
    const client = next.connect()
    await client.initialize(['harness', 'litchManager'])
    await client.call(MANAGER_METHOD.questionAsk, {
      managerId: first.manager.id,
      decisionId: first.id,
      revision: 1,
      question: '重启后继续',
    })
    await until(
      () => !!next?.device.managers.store.question(first.manager.id, first.id)?.threadId,
      '重建分叉',
    )
    const fresh = next.device.managers.store.question(first.manager.id, first.id)?.threadId
    assert.ok(fresh && fresh !== old)
    await until(() => first.env.pi.running(fresh), '重启后的问答开始')
    assert.match(JSON.stringify(first.env.pi.current(fresh)), /重启前的回答/)
    first.env.pi.end(fresh, 'completed', '继续回答')
  } finally {
    if (next) await next.close()
    else await first.env.close()
  }
})

test('长问答先摘要再提交，消息同时保留摘要和原文', async () => {
  const { env, client, manager, id, state, ask } = await setup()
  try {
    const threadId = await ask('长背景')
    const firstTurn = env.pi.current(threadId)?.id
    const original = '原文证据'.repeat(3200)
    env.pi.end(threadId, 'completed', original)
    await until(
      () => env.pi.running(threadId) && env.pi.current(threadId)?.id !== firstTurn,
      '自动摘要回合',
    )
    assert.equal(state().discussion.messages[0]?.status, 'running')
    env.pi.end(threadId, 'completed', '几行摘要，尚有不确定项')
    await until(() => state().discussion.messages[0]?.status === 'completed', '摘要完成')
    const result = await client.call(MANAGER_METHOD.answersSubmit, {
      managerId: manager.id,
      answers: [{ decisionId: id, revision: 1, optionId: null, text: '采用' }],
    })
    assert.equal(result.accepted[0].discussion.summary, '几行摘要，尚有不确定项')
    assert.equal(result.accepted[0].discussion.messages[0].answer, original)
  } finally {
    await env.close()
  }
})

test('Codex 旁问覆盖自治规则、禁用 MCP 和提权，不发上游未知参数', async () => {
  const env = codexRig()
  try {
    const start = env.codex.handlers['thread/start']
    assert.ok(start)
    env.codex.handlers['thread/start'] = (params, connection) => {
      const result = start(params, connection) as { thread: { id: string } }
      const old = env.codex.threads.find((thread) => thread.id === result.thread.id)
      const id = randomUUID()
      if (old) old.id = id
      result.thread.id = id
      return result
    }
    env.codex.handlers['config/read'] = () => ({
      config: { developer_instructions: 'Project policy.', mcp_servers: { unsafe: {} } },
    })
    const client = env.connect()
    await client.initialize(['harness', 'litchManager'])
    const { manager, threadId } = await client.call(MANAGER_METHOD.create, {
      cwd: env.stateDir,
      harness: 'codex',
      model: null,
      effort: null,
      name: 'Codex 经理',
      scope: '',
      rules: '',
      template: 'blank',
      firstTask: '',
      dispatch: MANAGER_DEFAULT_DISPATCH,
      contact: MANAGER_DEFAULT_CONTACT,
    })
    env.device.managers.writer.tool(manager.id, 'add', {
      kind: 'decision',
      decision: { title: 'Codex 问题', background: '' },
    })
    await client.call(MANAGER_METHOD.questionAsk, {
      managerId: manager.id,
      decisionId: 'D-1',
      revision: 1,
      question: '为什么？',
    })
    await until(() => {
      const entry = env.device.managers.store.question(manager.id, 'D-1')?.discussion.messages[0]
      assert.notEqual(entry?.status, 'failed', entry?.answer ?? '')
      return sentTo(env.codex, 'turn/start').some((params) => params.threadId !== threadId)
    }, 'Codex 旁问发起')
    const fork = sentTo(env.codex, 'thread/fork').at(-1)
    assert.equal(fork.dynamicTools, undefined)
    assert.equal(fork.sandbox, 'read-only')
    assert.equal(fork.approvalPolicy, 'never')
    assert.deepEqual(fork.config.mcp_servers, { unsafe: { enabled: false } })
    assert.equal(fork.config['features.request_permissions_tool'], false)
    assert.match(fork.developerInstructions, /background question \(read-only\)/)
    assert.doesNotMatch(
      fork.developerInstructions,
      /You are a Litch manager|Manager sessions \(Litch\)/,
    )
    const background = env.device.managers.store.question(manager.id, 'D-1')?.threadId
    assert.ok(background)
    await assert.rejects(
      client.call('turn/start', {
        threadId: background,
        input: [],
        sandboxPolicy: { type: 'dangerFullAccess' },
      }),
      { message: 'Decision background sessions are controlled by the manager board.' },
    )
    env.codex.notify('turn/completed', {
      threadId: background,
      turn: {
        id: `turn-of-${background}`,
        status: 'completed',
        items: [{ id: 'a', type: 'agentMessage', text: '只读回答' }],
      },
    })
    await until(
      () =>
        env.device.managers.store.question(manager.id, 'D-1')?.discussion.messages[0]?.status ===
        'completed',
      'Codex 旁问结束',
    )
  } finally {
    await env.close()
  }
})

test('经理追问混合提交：单事件、版本冲突、reply 入记录并保留另一项待答', async () => {
  const { env, client, manager, id, add } = await setup()
  try {
    const second = add()
    const result = await client.call(MANAGER_METHOD.feedbackSubmit, {
      managerId: manager.id,
      answers: [{ decisionId: id, revision: 1, optionId: null, text: '采用' }],
      questions: [
        { decisionId: id, revision: 1, question: '还有什么影响？' },
        { decisionId: second, revision: 1, question: '说明依据' },
      ],
    })
    assert.equal(result.accepted.length, 1)
    assert.equal(result.acceptedQuestions.length, 2)
    assert.equal(result.rejectedQuestions.length, 0)
    const writer = env.device.managers.writer
    const get = (decisionId: string) =>
      (writer.tool(manager.id, 'get', { id: decisionId }) as any).object
    assert.equal(get(id).status, 'answered')
    assert.equal(get(second).status, 'open')
    assert.equal(get(id).discussion.messages[0].mode, 'manager')
    assert.throws(
      () => writer.tool(manager.id, 'reply', { id, revision: 1, text: '旧背景' }),
      /current revision/,
    )
    writer.tool(manager.id, 'reply', { id, revision: get(id).revision, text: '影响已核实' })
    assert.equal(get(id).discussion.messages[0].answer, '影响已核实')
    assert.equal(get(id).discussion.messages[0].status, 'completed')
    assert.equal(get(second).discussion.messages[0].status, 'running')
    const conflict = await client.call(MANAGER_METHOD.feedbackSubmit, {
      managerId: manager.id,
      answers: [],
      questions: [{ decisionId: id, revision: 1, question: '旧草稿' }],
    })
    assert.equal(conflict.rejectedQuestions[0].code, 'decisionConflict')
    assert.equal(conflict.delivery, 'none')
  } finally {
    await env.close()
  }
})

test('临时追问只可改本决策指定字段，历史有来源且备注不唤醒经理', async () => {
  const { env, manager, threadId, id, add, ask, finish } = await setup()
  try {
    const other = add()
    const fork = await ask('请修正背景')
    for (const args of [
      { kind: 'decision', id: other, patch: { title: '越权' }, why: '测试' },
      { kind: 'decision', id, patch: { landed: [] }, why: '越权' },
      { kind: 'item', id: 'I-1', patch: { title: '越权' }, why: '测试' },
    ]) {
      const result = await env.pi.callTool(fork, 'litch_manager', 'update', args)
      assert.equal(result?.answer.result.success, false)
    }
    const updated = await env.pi.callTool(fork, 'litch_manager', 'update', {
      kind: 'decision',
      id,
      patch: { background: '追问核实后的背景' },
      why: '核对依据',
    })
    assert.equal(updated?.answer.result.success, true)
    assert.equal(env.device.managers.store.object(manager.id, id)?.revision, 2)
    assert.equal(env.device.managers.store.changes(manager.id)[0]?.by, 'question')
    assert.equal(env.pi.running(threadId), false)
    assert.match(
      JSON.stringify(env.device.sessionTree.store.notes(threadId)),
      /temporary question|temporary decision/,
    )
    const closed = await env.pi.callTool(fork, 'litch_manager', 'close', {
      kind: 'decision',
      id,
      status: 'withdrawn',
      reason: '已不需要决定',
    })
    assert.equal(closed?.answer.result.success, true)
    await finish('已修正背景并撤回。')
    assert.equal(env.device.managers.store.object(manager.id, id)?.status, 'withdrawn')
    assert.equal(
      env.device.managers.store
        .changes(manager.id)
        .find((change) => change.fields.includes('status'))?.by,
      'question',
    )
  } finally {
    await env.close()
  }
})

test('临时修改备注不插入当前回合，其他线的回报插话不能将它一并丢弃', async () => {
  const { env, client, manager, threadId, id, ask, finish } = await setup()
  try {
    const fork = await ask('修正背景')
    await client.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: '经理正在处理另一项工作' }],
    })
    const result = await env.pi.callTool(fork, 'litch_manager', 'update', {
      kind: 'decision',
      id,
      patch: { background: '临时讨论更新' },
      why: '核对',
    })
    assert.equal(result?.answer.result.success, true)
    env.device.sessionTree.store.addNote(
      threadId,
      { threadId: 'another-line', title: '另一条线', status: 'completed', excerpt: '普通线回报' },
      false,
    )
    env.device.sessionTree.checkAll()
    await until(
      () =>
        env.pi.seen.some(
          (entry) =>
            entry.method === 'turn/steer' && JSON.stringify(entry.params).includes('普通线回报'),
        ),
      '普通回报插入当前回合',
    )
    assert.ok(
      !env.pi.seen.some(
        (entry) =>
          entry.method === 'turn/steer' &&
          JSON.stringify(entry.params).includes('temporary question'),
      ),
    )
    assert.ok(env.device.sessionTree.store.notes(threadId).some((note) => note.threadId === fork))
    const next = env.device.sessionTree.beforeDeviceTurn(threadId, [
      { type: 'text', text: '下一回合' },
    ])
    assert.match(JSON.stringify(next), /temporary question/)
    assert.equal(env.device.sessionTree.store.notes(threadId).length, 0)
    assert.equal(env.device.managers.store.changes(manager.id)[0]?.by, 'question')
    await finish('已修改')
  } finally {
    await env.close()
  }
})
