import assert from 'node:assert/strict'
import test from 'node:test'
import type { TaskTarget } from '../../protocol/src/device-tasks.mjs'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
  type ManagerResetPreview,
} from '../../protocol/src/manager.mjs'
import { ManagerResets } from '../src/manager-reset.mjs'
import { managerHandoverIndex } from '../src/manager-rules.mjs'
import { startChild } from '../src/session-start.mjs'
import { openTaskDatabase, type TaskRow, TaskStore } from '../src/task-store.mjs'
import { codexThread, FakeCodex } from './fake-codex.mjs'
import { FakeControl, managed } from './fake-control.mjs'
import type { FakeTurn } from './fake-engine.mjs'
import { FakeEngine } from './fake-engine.mjs'
import { rig } from './helpers.mjs'
import { until } from './tree-kit.mjs'

/** 两个协议假引擎；HOME/凭据由 helpers 的隔离夹具接管，不调用个人 CLI 或模型入口。 */
async function setup(source = 'claude-code') {
  const claude = new FakeEngine('claude-code')
  const pi = new FakeEngine('pi')
  claude.declaration.features = {
    ephemeralFork: true,
    backgroundTasks: true,
    steer: true,
    managerQuestions: true,
    goals: true,
  }
  claude.handlers['thread/goal/get'] = () => ({ goal: null })
  claude.handlers['thread/name/set'] = () => ({})
  const codex = new FakeCodex()
  const turns = new Map<string, FakeTurn[]>()
  const configs = new Map<
    string,
    { model: string; reasoningEffort: string | null; activePermissionProfile: string }
  >()
  let seq = 0
  const start = codex.handlers['thread/start']!
  codex.handlers['thread/start'] = (params, connection) => {
    const created = start(params, connection) as { thread: { id: string } }
    const thread = codex.threads.find((one) => one.id === created.thread.id)!
    Object.assign(thread, codexThread(++seq, 9000), {
      cwd: params.cwd,
      dynamicTools: params.dynamicTools,
      status: { type: 'idle' },
    })
    configs.set(thread.id, {
      model: params.model ?? 'codex-model',
      reasoningEffort: params.config?.model_reasoning_effort ?? 'medium',
      activePermissionProfile: params.permissions ?? ':workspace',
    })
    return { ...created, thread, ...configs.get(thread.id) }
  }
  codex.handlers['thread/resume'] = (params) => ({
    thread: { ...codex.threads.find((one) => one.id === params.threadId), turns: [] },
    ...configs.get(params.threadId),
    approvalPolicy: 'on-request',
    modelProvider: 'target-provider',
    serviceTier: 'fast',
  })
  codex.handlers['thread/read'] = (params) => ({
    thread: {
      ...codex.threads.find((one) => one.id === params.threadId),
      turns: params.includeTurns ? structuredClone(turns.get(params.threadId) ?? []) : [],
    },
  })
  const startTurn = codex.handlers['turn/start']!
  codex.handlers['turn/start'] = (params, connection) => {
    startTurn(params, connection)
    const turn: FakeTurn = {
      id: `turn-${++seq}`,
      status: 'inProgress',
      items: [{ type: 'userMessage', id: `u-${seq}`, content: params.input }],
      error: null,
    }
    turns.set(params.threadId, [...(turns.get(params.threadId) ?? []), turn])
    codex.threads.find((one) => one.id === params.threadId)!.status = {
      type: 'active',
      activeFlags: [],
    }
    queueMicrotask(() => codex.notify('turn/started', { threadId: params.threadId, turn }))
    return { turn }
  }
  codex.handlers['turn/steer'] = (params) => {
    const turn = turns.get(params.threadId)?.at(-1)
    if (!turn || turn.status !== 'inProgress') throw new Error('No active turn')
    turn.items.push({ type: 'userMessage', id: `steer-${++seq}`, content: params.input })
    return { turnId: turn.id }
  }
  codex.handlers['thread/goal/get'] = () => ({ goal: null })
  codex.handlers['thread/name/set'] = () => ({})
  codex.handlers['config/read'] = () => ({
    config: { model_provider: 'target-provider', service_tier: 'fast' },
  })
  const catalog = (id: string) => ({
    data: [
      {
        id,
        model: id,
        isDefault: true,
        litchModelIdentity: { provider: 'fixture', trusted: true },
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: ['low', 'medium', 'high'].map((reasoningEffort) => ({
          reasoningEffort,
        })),
      },
    ],
    nextCursor: null,
  })
  codex.handlers['model/list'] = () => catalog('codex-model')
  claude.handlers['model/list'] = () => catalog('fake')
  const control = new FakeControl([
    managed('claude-code'),
    { ...managed('codex'), native: true },
    managed('pi'),
  ])
  control.patch({
    values: { 'tools.browser': false, 'tools.computer': false, 'tools.machine': false } as never,
  })
  const fakes = { 'claude-code': claude, codex, pi }
  const logs: string[] = []
  const env = rig(
    {},
    {},
    {
      control,
      dial: (socket) => fakes[socket.slice('fake://'.length) as keyof typeof fakes].connector,
      log: (line) => logs.push(line),
    },
  )
  const client = env.connect()
  await client.initialize(['harness', 'litchManager', 'litchManagerResetTarget', 'sessionTree'])
  const created = await client.call(MANAGER_METHOD.create, {
    cwd: env.stateDir,
    harness: source,
    model: source === 'codex' ? 'codex-model' : 'fake',
    effort: 'medium',
    permission: ':workspace',
    name: '跨引擎经理',
    scope: '',
    rules: '保持约束',
    template: 'blank',
    dispatch: MANAGER_DEFAULT_DISPATCH,
    contact: MANAGER_DEFAULT_CONTACT,
    firstTask: '',
  })
  const oldId = created.threadId as string
  const tree = env.device.sessionTree
  const running = (harness: string, id: string) =>
    harness === 'claude-code' ? claude.running(id) : turns.get(id)?.at(-1)?.status === 'inProgress'
  const end = (
    harness: string,
    id: string,
    text = '交接摘要',
    status: FakeTurn['status'] = 'completed',
  ) => {
    if (harness === 'claude-code')
      return claude.end(id, status === 'inProgress' ? 'completed' : status, text)
    const turn = turns.get(id)?.at(-1)
    assert.ok(turn)
    turn.status = status
    turn.items.push({ type: 'agentMessage', id: `answer-${++seq}`, text })
    codex.threads.find((one) => one.id === id)!.status = { type: 'idle' }
    codex.notify('turn/completed', { threadId: id, turn })
  }
  await until(() => running(source, oldId), '开场')
  end(source, oldId, '原始历史')
  await until(() => !tree.isActive(oldId), '空闲')
  const preview = async (targetHarness = source === 'claude-code' ? 'codex' : 'claude-code') =>
    (await client.call(MANAGER_METHOD.resetPreview, {
      managerId: created.manager.id,
      target: { harness: targetHarness, model: null, effort: null, permission: ':workspace' },
    })) as ManagerResetPreview
  const input = (plan: ManagerResetPreview, requestId = 'handover-1') => ({
    managerId: created.manager.id,
    target: plan.target,
    expectedThreadId: plan.expectedThreadId,
    expectedSettingsHash: plan.expectedSettingsHash,
    requestId,
  })
  return {
    ...env,
    client,
    control,
    claude,
    codex,
    pi,
    logs,
    tree,
    manager: created.manager,
    oldId,
    end,
    running,
    preview,
    input,
    turns,
    current: () => env.device.managers.manager(created.manager.id),
    async close() {
      await env.close()
      assert.deepEqual(codex.ignored, [])
    },
  }
}

for (const source of ['claude-code', 'codex'])
  test(`${source} 跨引擎换绑：源摘要、目标配置、工作线与历史不丢，重复请求不重建`, async () => {
    const env = await setup(source)
    try {
      const child = await startChild(
        env.tree,
        env.oldId,
        {
          kind: 'fresh',
          title: '继续运行的线',
          prompt: '保持运行',
          harness: 'claude-code',
          wakeParent: false,
          worktree: false,
        },
        'model',
      )
      const epoch = env.tree.store.parentOf(child.threadId)!.reportEpoch
      const plan = await env.preview()
      assert.equal(plan.canSubmit, true, JSON.stringify(plan.reasons))
      assert.equal(plan.mode, 'replace')
      const request = env.input(plan)
      await Promise.all([
        env.client.call(MANAGER_METHOD.reset, request),
        env.client.call(MANAGER_METHOD.reset, request),
      ])
      assert.equal(env.device.managers.resets.held(env.oldId), true)
      await until(() => env.running(source, env.oldId), '源引擎摘要')
      // 后台结果现在可在活动回合插话；内部连接仍必须挡住接班摘要期间的新输入。
      const sourceLink = await env.tree.link(source)
      await assert.rejects(
        sourceLink.request('turn/steer', {
          threadId: env.oldId,
          expectedTurnId: env.tree.activeTurn(env.oldId),
          input: [{ type: 'text', text: '后台结果不应进入交接摘要', text_elements: [] }],
        }),
        /reset/,
      )
      env.end(source, env.oldId)
      await until(() => env.current().threadId !== env.oldId, '跨引擎提交', 5000)
      const current = env.current()
      assert.equal(current.harness, plan.target.harness)
      assert.equal(current.model, plan.target.model)
      assert.equal(current.effort, plan.target.effort)
      assert.equal(current.permission, ':workspace')
      assert.equal(current.id, env.manager.id)
      assert.equal(env.tree.store.parentOf(child.threadId)?.parentThreadId, current.threadId)
      assert.equal(env.tree.store.parentOf(child.threadId)?.reportEpoch, epoch)
      assert.equal(env.tree.host.index.lookup(env.oldId), source)
      assert.equal(env.tree.host.index.lookup(current.threadId), plan.target.harness)
      const response = await env.client.call(MANAGER_METHOD.reset, request)
      assert.equal(response.manager.reset.operation.requestId, request.requestId)
      assert.equal(env.current().threadId, current.threadId)
      await until(() => env.running(current.harness, current.threadId), '接班首轮', 5000)
      await until(
        () => !env.device.managers.resets.handoverPending(current.threadId),
        '接班输入已接受',
      )
      const call = await env.device.managers.tool({
        harness: current.harness,
        threadId: current.threadId,
        turnId: 'handover',
        callId: 'summary',
        namespace: 'litch_manager',
        tool: 'summary',
        arguments: {},
      })
      assert.equal(call.success, true)
      const target = current.harness === 'codex' ? env.codex : env.claude
      const start = target.seen.filter((one) => one.method === 'thread/start').at(-1)!.params
      assert.equal(start.model, plan.target.model)
      assert.equal(start.config.model_reasoning_effort, 'medium')
      if (current.harness === 'codex') {
        assert.equal(start.modelProvider, 'target-provider')
        assert.equal(start.serviceTier, 'fast')
      } else {
        assert.equal(start.modelProvider, undefined)
        assert.equal(start.serviceTier, undefined)
      }
      await assert.rejects(env.client.call('turn/start', { threadId: env.oldId, input: [] }), /./)
      const oldLink = await env.tree.link(source)
      await assert.rejects(
        oldLink.request('turn/start', { threadId: env.oldId, input: [] }),
        /read-only/,
      )
      await assert.rejects(oldLink.request('thread/resume', { threadId: env.oldId }), /read-only/)
    } finally {
      await env.close()
    }
  })

test('只读预览拒绝未验目标、权限提升、活动 goal 和派活型号冲突；过期确认不启动摘要', async () => {
  const env = await setup()
  try {
    const preview = await env.preview('pi')
    assert.equal(preview.canSubmit, false)
    assert.ok(preview.reasons.some((issue) => issue.code === 'notValidated'))
    const permission = await env.client.call(MANAGER_METHOD.resetPreview, {
      managerId: env.manager.id,
      target: { harness: 'codex', model: null, effort: null, permission: ':danger-full-access' },
    })
    assert.equal(permission.canSubmit, false)
    assert.ok(
      permission.reasons.some((issue: { code: string }) => issue.code === 'permissionMismatch'),
    )
    const policy = env.claude.config.approvalPolicy
    env.claude.config.approvalPolicy = { granular: { exec: false } }
    assert.ok((await env.preview()).reasons.some((issue) => issue.code === 'unsupportedPermission'))
    env.claude.config.approvalPolicy = policy
    const goal = env.claude.handlers['thread/goal/get']!
    env.claude.handlers['thread/goal/get'] = () => ({ goal: { status: 'active' } })
    assert.ok((await env.preview()).reasons.some((issue) => issue.code === 'activeGoal'))
    env.claude.handlers['thread/goal/get'] = () => {
      throw new Error('disconnected goal')
    }
    assert.ok((await env.preview()).reasons.some((issue) => issue.code === 'sourceStateUnknown'))
    env.claude.handlers['thread/goal/get'] = goal
    const plan = await env.preview()
    env.control.patch({ values: { 'tools.browser': true } as never })
    await assert.rejects(
      env.client.call(MANAGER_METHOD.reset, env.input(plan)),
      (error: any) => error.data.litch === 'managerResetConflict',
    )
    assert.equal(env.current().threadId, env.oldId)
    assert.equal(env.claude.running(env.oldId), false)
    await env.client.call(MANAGER_METHOD.update, {
      managerId: env.manager.id,
      dispatch: { ...MANAGER_DEFAULT_DISPATCH, model: 'fake' },
    })
    assert.ok((await env.preview()).reasons.some((issue) => issue.code === 'dispatchConflict'))
  } finally {
    await env.close()
  }
})

test('目标默认型号与强度取目标配置；默认变化使旧确认失效', async () => {
  const env = await setup()
  try {
    const before = await env.preview()
    env.codex.handlers['config/read'] = () => ({
      config: {
        model: 'codex-model',
        model_reasoning_effort: 'high',
        model_provider: 'target-provider',
        service_tier: 'fast',
      },
    })
    const after = await env.preview()
    assert.equal(after.target.model, 'codex-model')
    assert.equal(after.target.effort, 'high')
    assert.notEqual(before.expectedSettingsHash, after.expectedSettingsHash)
    await assert.rejects(
      env.client.call(MANAGER_METHOD.reset, env.input(before)),
      (error: any) => error.data.litch === 'managerResetConflict',
    )
    assert.equal(env.claude.running(env.oldId), false)
  } finally {
    await env.close()
  }
})

test('大量交接对象仍保留每类总数、未展开数量和读取入口，索引有界', () => {
  const categories = Object.fromEntries(
    [
      'lines',
      'items',
      'decisions',
      'requests',
      'answeredPending',
      'suggestions',
      'unread',
      'questions',
    ].map((kind) => [
      kind,
      {
        entries: Array.from({ length: 100 }, (_, at) => ({
          id: `${kind}-${at}`,
          title: '需要验收的长标题'.repeat(15),
          status: '需核对',
          revision: 1,
        })),
        read: 'litch_manager.summary/get(id)；litch_sessions.read(thread_id)',
      },
    ]),
  )
  const text = managerHandoverIndex({ managerId: 'm', requestId: 'r', generatedAt: 1 }, categories)
  assert.ok(Buffer.byteLength(text, 'utf8') <= 8000)
  const index = JSON.parse(text)
  assert.deepEqual(Object.keys(index.sections), Object.keys(categories))
  for (const section of Object.values(index.sections) as any[]) {
    assert.equal(section.total, 100)
    assert.equal(section.entries.length + section.omitted, 100)
    assert.ok(section.read)
  }
})

test('Claude 改强度强制换线程，同有效设置仍刷新；跨引擎等待后台可取消且旧确认不能复活', async () => {
  const env = await setup()
  try {
    const unchanged = await env.preview('claude-code')
    assert.equal(unchanged.mode, 'refresh')
    const changed = await env.client.call(MANAGER_METHOD.resetPreview, {
      managerId: env.manager.id,
      target: { ...unchanged.target, effort: 'high' },
    })
    assert.equal(changed.mode, 'replace')
    const background = env.tree.host.backgroundRunning
    env.tree.host.backgroundRunning = () => 1
    const plan = await env.preview()
    const request = env.input(plan)
    await env.client.call(MANAGER_METHOD.reset, request)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(env.current().reset?.phase, 'waiting')
    assert.equal(env.claude.running(env.oldId), false)
    env.tree.store.addNote(
      env.oldId,
      {
        threadId: 'pending-line',
        title: '待投递回报',
        status: 'completed',
        excerpt: '保留这条回报',
      },
      false,
    )
    assert.throws(() => env.tree.beforeDeviceTurn(env.oldId, []), /reset/)
    assert.equal(env.tree.store.notes(env.oldId).length, 1)
    const link = await env.tree.link('claude-code')
    await assert.rejects(link.request('turn/start', { threadId: env.oldId, input: [] }), /reset/)
    await env.client.call(MANAGER_METHOD.resetCancel, { managerId: env.manager.id })
    env.tree.host.backgroundRunning = background
    const repeat = await env.client.call(MANAGER_METHOD.reset, request)
    assert.equal(repeat.manager.reset.phase, 'idle')
    assert.equal(env.claude.running(env.oldId), false)
    assert.equal(env.device.managers.resets.handoverPending(env.current().threadId), false)
  } finally {
    await env.close()
  }
})

test('摘要失败只可用原 requestId 和目标 boardOnly 二次确认，不接受新目标或裸旧请求', async () => {
  const env = await setup()
  try {
    const plan = await env.preview()
    const request = env.input(plan)
    await env.client.call(MANAGER_METHOD.reset, request)
    await until(() => env.claude.running(env.oldId), '摘要')
    env.end('claude-code', env.oldId, '', 'failed')
    await until(() => env.current().reset?.phase === 'summaryFailed', '摘要失败')
    await assert.rejects(
      env.client.call(MANAGER_METHOD.reset, {
        ...request,
        target: { ...request.target, harness: 'claude-code' },
        boardOnly: true,
      }),
      (error: any) => error.data.litch === 'managerResetConflict',
    )
    await assert.rejects(
      env.client.call(MANAGER_METHOD.reset, {
        ...request,
        requestId: 'new-confirmation',
        boardOnly: true,
      }),
      /./,
    )
    await assert.rejects(
      env.client.call(MANAGER_METHOD.reset, { managerId: env.manager.id, boardOnly: true }),
      /./,
    )
    await env.client.call(MANAGER_METHOD.reset, { ...request, boardOnly: true })
    await until(() => env.current().threadId !== env.oldId, '仅按看板接班', 5000)
    assert.equal(env.current().harness, 'codex')
  } finally {
    await env.close()
  }
})

test('候选命名失败保留候选，模拟进程恢复复用同一线程，提交后只向前修复', async () => {
  const env = await setup()
  let recovered: ManagerResets | undefined
  try {
    const plan = await env.preview()
    const request = env.input(plan)
    const name = env.codex.handlers['thread/name/set']!
    env.codex.handlers['thread/name/set'] = () => {
      throw new Error('name failure')
    }
    await env.client.call(MANAGER_METHOD.reset, request)
    await until(() => env.claude.running(env.oldId), '摘要')
    env.end('claude-code', env.oldId)
    await until(() => env.current().reset?.phase === 'failed', '候选命名失败', 5000)
    const record = env.device.managers.store.reset(env.manager.id)!
    assert.ok(record.candidate)
    assert.equal(env.current().threadId, env.oldId)
    assert.equal(
      env.device.managers.resets.refusal(String(record.candidate.thread.id))?.includes('candidate'),
      true,
    )
    await env.device.managers.resets.close()
    env.codex.handlers['thread/name/set'] = name
    record.phase = 'applying'
    env.device.managers.store.saveReset(record)
    const rebind = env.tree.store.rebindManager.bind(env.tree.store)
    let fault = true
    env.tree.store.rebindManager = (oldId, newId) => {
      rebind(oldId, newId)
      if (fault) {
        fault = false
        throw new Error('session store committed, manager store not yet committed')
      }
    }
    recovered = new ManagerResets(env.device.managers)
    recovered.tick(env.manager.id)
    await until(
      () => !!env.device.managers.store.reset(env.manager.id)?.committed,
      '提交意图耐久',
      5000,
    )
    recovered.tick(env.manager.id)
    await until(
      () => {
        recovered?.tick(env.manager.id)
        return env.device.managers.store.reset(env.manager.id)?.phase === 'ready'
      },
      '向前恢复',
      5000,
    )
    assert.equal(env.current().threadId, record.candidate.thread.id)
    assert.equal(env.codex.seen.filter((one) => one.method === 'thread/start').length, 1)
    assert.equal(env.current().reset?.operation?.committed, true)
  } finally {
    await recovered?.close()
    await env.close()
  }
})

for (const ackLost of [false, true])
  test(`接班${ackLost ? '应答丢失先查历史' : '请求失败保留绑定并重试'}，不重复建候选或输入`, async () => {
    const env = await setup()
    try {
      const targetStart = env.codex.handlers['turn/start']!
      let first = true
      env.codex.handlers['turn/start'] = (params, connection) => {
        if (first) {
          first = false
          if (ackLost) targetStart(params, connection)
          throw new Error(ackLost ? 'ack lost' : 'target disconnected')
        }
        return targetStart(params, connection)
      }
      const request = env.input(await env.preview())
      await env.client.call(MANAGER_METHOD.reset, request)
      await until(() => env.claude.running(env.oldId), '摘要')
      env.end('claude-code', env.oldId)
      await until(() => env.current().threadId !== env.oldId, '已提交', 5000)
      await until(() => env.current().reset?.operation?.handover === 'failed', '接班失败投影', 5000)
      assert.equal(env.device.managers.resets.handoverPending(env.current().threadId), false)
      const newId = env.current().threadId
      env.device.managers.kick(env.manager.id)
      await until(
        () => env.current().reset?.operation?.handover === 'accepted',
        '重试/核对接班',
        5000,
      )
      assert.equal(env.codex.seen.filter((one) => one.method === 'thread/start').length, 1)
      assert.equal(env.turns.get(newId)?.length, 1)
      env.end('codex', newId, '', 'failed')
      await until(
        () => env.current().reset?.operation?.handover === 'failed',
        '首轮失败明确投影',
        5000,
      )
      assert.equal(env.current().threadId, newId)
      assert.equal(env.device.managers.resets.handoverPending(env.current().threadId), false)
    } finally {
      await env.close()
    }
  })

test('固定经理线程的任务（含 paused）与未结束运行阻止切换，并列出任务身份；提交前新增任务也阻止', async () => {
  const env = await setup()
  const store = new TaskStore(openTaskDatabase(env.stateDir))
  try {
    const draft = {
      name: '经理巡检',
      prompt: '核对工作',
      schedule: { type: 'interval' as const, minutes: 60 },
      timezone: 'UTC',
      status: 'paused' as const,
    }
    let serial = 0
    const create = (target: TaskTarget) => {
      const row: TaskRow = {
        ...draft,
        id: `task-${++serial}`,
        seq: serial,
        target,
        origin: { kind: 'client' },
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        anchor: 1,
        nextRunAt: null,
        lastRunAt: null,
        lastError: null,
        pendingCoalesced: 0,
      }
      store.saveTask(row)
      return row
    }
    const paused = create({ kind: 'thread', harness: 'claude-code', threadId: env.oldId })
    let preview = await env.preview()
    assert.equal(preview.canSubmit, false)
    assert.ok(
      preview.reasons.some(
        (reason) =>
          reason.code === 'scheduledTasks' &&
          reason.message.includes(paused.id) &&
          reason.message.includes(paused.name),
      ),
    )
    store.deleteTask(paused.id)
    const independent = create({
      kind: 'newThread',
      harness: 'claude-code',
      cwd: env.stateDir,
      workspaceId: null,
      settings: { model: null, effort: null, permission: ':workspace' },
    })
    store.insertRun(
      {
        id: 'pending-manager-run',
        taskId: independent.id,
        trigger: 'manual',
        scheduledFor: 1,
        coalesced: 0,
        status: 'running',
        harness: 'claude-code',
        threadId: env.oldId,
        turnId: 'old-run',
        startedAt: 1,
        finishedAt: null,
        summary: null,
        error: null,
        read: true,
      },
      null,
    )
    preview = await env.preview()
    assert.ok(
      preview.reasons.some(
        (reason) => reason.code === 'scheduledTasks' && reason.message.includes(independent.id),
      ),
    )
    store.deleteTask(independent.id)
    const plan = await env.preview()
    assert.equal(plan.canSubmit, true)
    env.codex.handlers['thread/name/set'] = () => {
      create({ kind: 'thread', harness: 'claude-code', threadId: env.oldId })
      return {}
    }
    await env.client.call(MANAGER_METHOD.reset, env.input(plan))
    await until(() => env.claude.running(env.oldId), '摘要')
    env.end('claude-code', env.oldId)
    await until(() => env.current().reset?.phase === 'failed', '提交前任务复核', 5000)
    assert.equal(env.current().threadId, env.oldId)
    assert.ok(env.current().reset?.error?.includes('经理巡检'))
  } finally {
    store.close()
    await env.close()
  }
})

test('新扩展逐接收连接协商，旧客户端看不到操作明细，也不能静默提交目标', async () => {
  const env = await setup()
  try {
    const old = env.connect()
    await old.initialize(['harness', 'litchManager'])
    const plan = await env.preview()
    await assert.rejects(
      old.call(MANAGER_METHOD.resetPreview, { managerId: env.manager.id }),
      (error: any) => error.data.litch === 'extensionRequired',
    )
    await assert.rejects(
      old.call(MANAGER_METHOD.reset, env.input(plan)),
      (error: any) => error.data.litch === 'extensionRequired',
    )
    await env.client.call(MANAGER_METHOD.reset, env.input(plan))
    await until(() => env.claude.running(env.oldId), '摘要')
    const oldResponse = await old.call(MANAGER_METHOD.list, {})
    assert.equal(oldResponse.managers[0].reset.operation, undefined)
    const currentResponse = await env.client.call(MANAGER_METHOD.list, {})
    assert.equal(currentResponse.managers[0].reset.operation.requestId, 'handover-1')
    env.end('claude-code', env.oldId)
    await until(() => env.current().threadId !== env.oldId, '提交', 5000)
    await until(
      () =>
        old.notifications.some(
          (frame: any) =>
            frame.method === 'litch/manager/changed' && frame.params.manager.harness === 'codex',
        ),
      '旧端收到普通绑定更新',
    )
    for (const frame of old.notifications as any[])
      if (frame.method === 'litch/manager/changed')
        assert.equal(frame.params.manager.reset.operation, undefined)
  } finally {
    await env.close()
  }
})

test('旧 requestId 的幂等回执独立返回，不覆盖下一次重置的当前状态', async () => {
  const env = await setup()
  try {
    const first = env.input(await env.preview())
    await env.client.call(MANAGER_METHOD.reset, first)
    await until(() => env.claude.running(env.oldId), '第一份摘要')
    env.end('claude-code', env.oldId)
    await until(() => env.current().threadId !== env.oldId, '第一次提交', 5000)
    const nextId = env.current().threadId
    await until(() => env.running('codex', nextId), '接班')
    env.end('codex', nextId)
    await until(() => !env.tree.isActive(nextId), '接班结束')
    const second = env.input(await env.preview('claude-code'), 'handover-2')
    await env.client.call(MANAGER_METHOD.reset, second)
    const replayed = await env.client.call(MANAGER_METHOD.reset, first)
    assert.equal(replayed.operation.requestId, 'handover-1')
    assert.equal(replayed.manager.reset.operation.requestId, 'handover-2')
    assert.equal(env.current().reset?.operation?.requestId, 'handover-2')
  } finally {
    await env.close()
  }
})

for (const stage of ['startResultUnknown', 'commitIntent'] as const)
  test(`跨引擎 ${stage} 失败不改旧绑定；重复请求和恢复都不创建第二候选`, async () => {
    const env = await setup()
    let restored: ManagerResets | undefined
    try {
      if (stage === 'startResultUnknown') {
        const start = env.codex.handlers['thread/start']!
        env.codex.handlers['thread/start'] = (params, connection) => {
          start(params, connection)
          throw new Error('start response lost')
        }
      } else {
        const save = env.device.managers.store.saveReset.bind(env.device.managers.store)
        env.device.managers.store.saveReset = (record) => {
          if (record.committed) throw new Error('intent not persisted')
          save(record)
        }
      }
      const request = env.input(await env.preview())
      await env.client.call(MANAGER_METHOD.reset, request)
      await until(() => env.claude.running(env.oldId), '摘要')
      env.end('claude-code', env.oldId)
      await until(() => env.current().reset?.phase === 'failed', '故障停在提交前', 5000)
      assert.equal(env.current().threadId, env.oldId)
      assert.equal(env.device.managers.store.reset(env.manager.id)?.committed, undefined)
      const repeated = await env.client.call(MANAGER_METHOD.reset, request)
      assert.equal(repeated.manager.reset.phase, 'failed')
      await env.device.managers.resets.close()
      const record = env.device.managers.store.reset(env.manager.id)!
      if (stage === 'startResultUnknown') {
        record.phase = 'applying'
        env.device.managers.store.saveReset(record)
        restored = new ManagerResets(env.device.managers)
        restored.tick(env.manager.id)
        await until(() => env.current().reset?.phase === 'failed', '未知结果不盲重试', 5000)
      }
      assert.equal(env.codex.seen.filter((one) => one.method === 'thread/start').length, 1)
    } finally {
      await restored?.close()
      await env.close()
    }
  })

test('交接索引覆盖摘要遗漏、空闲待验收、已答未投递与待审批，旧旁问只交回原引擎释放', async () => {
  const env = await setup()
  try {
    const writer = env.device.managers.writer
    const decision = writer.tool(env.manager.id, 'add', {
      kind: 'decision',
      decision: { title: '已答未处理', background: '摘要没有记录的约束' },
    }) as { id: `D-${number}`; revision: number }
    const backgroundDecision = writer.tool(env.manager.id, 'add', {
      kind: 'decision',
      decision: { title: '旁问背景', background: '需要核对' },
    }) as { id: `D-${number}`; revision: number }
    const child = await startChild(
      env.tree,
      env.oldId,
      {
        kind: 'fresh',
        title: '空闲待验收',
        prompt: '工作',
        harness: 'claude-code',
        wakeParent: false,
        worktree: false,
      },
      'model',
    )
    env.claude.end(child.threadId, 'completed', '没验：需要实际界面核对')
    await until(() => !env.tree.isActive(child.threadId), '线空闲')
    const pending = await startChild(
      env.tree,
      env.oldId,
      {
        kind: 'fresh',
        title: '待审批线',
        prompt: '工作',
        harness: 'claude-code',
        wakeParent: false,
        worktree: false,
      },
      'model',
    )
    env.claude.approval(pending.threadId)
    await until(() => env.tree.pendingRequests(pending.threadId).length > 0, '待审批')
    await env.client.call(MANAGER_METHOD.questionAsk, {
      managerId: env.manager.id,
      decisionId: backgroundDecision.id,
      revision: 1,
      question: '依据？',
    })
    await until(
      () => !!env.device.managers.store.question(env.manager.id, backgroundDecision.id)?.threadId,
      '旧旁问创建',
    )
    const temporary = env.device.managers.store.question(env.manager.id, backgroundDecision.id)!
      .threadId!
    await until(() => env.claude.running(temporary), '旧旁问运行')
    env.claude.end(temporary, 'completed', '依据已记录')
    await until(() => !env.device.managers.questions.busy(env.manager.id), '旧旁问结束')
    const plan = await env.preview()
    await env.client.call(MANAGER_METHOD.reset, env.input(plan))
    await until(() => env.claude.running(env.oldId), '摘要')
    writer.answers(env.manager.id, [
      { decisionId: decision.id, revision: 1, optionId: null, text: '用户已答，但等待接班处理' },
    ])
    env.claude.end(env.oldId, 'completed', '只有一条简短摘要，遗漏验收和答复。')
    await until(() => env.current().threadId !== env.oldId, '提交', 5000)
    await until(() => env.running('codex', env.current().threadId), '首轮接班', 5000)
    const text = String(
      (env.turns.get(env.current().threadId)?.[0]?.items[0]?.content as any[])?.[0]?.text,
    )
    const json = text.split('\n').find((line) => line.startsWith('{"managerId"'))!
    const index = JSON.parse(json)
    assert.ok(
      index.sections.lines.entries.some(
        (one: any) => one.threadId === child.threadId && one.acceptance === '需核对',
      ),
    )
    assert.ok(
      index.sections.lines.entries.some(
        (one: any) => one.threadId === pending.threadId && one.pendingRequests > 0,
      ),
    )
    assert.ok(index.sections.answeredPending.entries.some((one: any) => one.id === decision.id))
    assert.ok(index.sections.decisions.entries.some((one: any) => one.id === backgroundDecision.id))
    assert.equal(text.includes('摘要可能过时'), true)
    assert.equal(JSON.stringify(index).includes('approve-'), false)
    assert.ok(
      env.claude.seen.some(
        (one) => one.method === 'thread/unsubscribe' && one.params.threadId === temporary,
      ),
    )
    assert.ok(
      !env.codex.seen.some(
        (one) => one.method === 'thread/unsubscribe' && one.params.threadId === temporary,
      ),
    )
    assert.equal(env.device.managers.questions.allowed(temporary, 'litch_manager', 'update'), false)
  } finally {
    await env.close()
  }
})

test('回报读取卡在 await 时跨引擎提交，读取完成后只投当前父线程且保留 reportEpoch', async () => {
  const env = await setup()
  let release: (() => void) | undefined
  try {
    const child = await startChild(
      env.tree,
      env.oldId,
      {
        kind: 'fresh',
        title: '在途回报',
        prompt: '工作',
        harness: 'claude-code',
        wakeParent: false,
        worktree: false,
      },
      'model',
    )
    const epoch = env.tree.store.parentOf(child.threadId)!.reportEpoch
    const read = env.tree.read.bind(env.tree)
    let captured = false
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const plan = await env.preview()
    await env.client.call(MANAGER_METHOD.reset, env.input(plan))
    await until(() => env.claude.running(env.oldId), '源摘要')
    env.tree.read = async (threadId, includeTurns, latest) => {
      if (threadId === child.threadId && !captured) {
        captured = true
        await gate
      }
      return read(threadId, includeTurns, latest)
    }
    env.claude.end(child.threadId, 'completed', '跨提交点的完整回报')
    await until(() => captured, '回报读取挂起')
    env.claude.end(env.oldId, 'completed', '交接')
    await until(() => env.current().threadId !== env.oldId, '跨引擎提交', 5000).catch((error) => {
      throw new Error(
        `${String(error)}\n${JSON.stringify(env.current().reset)}\n${env.logs.slice(-12).join('\n')}`,
      )
    })
    release?.()
    await until(
      () =>
        env.device.managers
          .board(env.manager.id)
          .lines.find((one) => one.threadId === child.threadId)?.report?.text ===
        '跨提交点的完整回报',
      '在途回报落新看板',
    )
    assert.equal(env.tree.store.parentOf(child.threadId)?.reportEpoch, epoch)
    assert.equal(env.tree.store.notes(env.oldId).length, 0)
    const currentId = env.current().threadId
    await until(
      () =>
        env.tree.store.notes(currentId).some((note) => note.threadId === child.threadId) ||
        JSON.stringify(env.turns.get(currentId)).includes('跨提交点的完整回报'),
      '回报在新经理队列/历史',
    )
  } finally {
    release?.()
    await env.close()
  }
})
