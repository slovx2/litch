import assert from 'node:assert/strict'
import test from 'node:test'
import type { ClientToolNamespaceSpec } from '../../protocol/src/client-tools.mjs'
import type { TaskTarget } from '../../protocol/src/device-tasks.mjs'
import {
  EXTERNAL_METHOD,
  EXTERNAL_SOURCES_EXTENSION,
  type ExternalSourceDraft,
} from '../../protocol/src/external-sources.mjs'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
  type ManagerResetPreview,
} from '../../protocol/src/manager.mjs'
import { MANAGER_ISSUE_METHOD, type ManagerIssue } from '../../protocol/src/manager-issues.mjs'
import { parseSessionEvent } from '../../protocol/src/session-tree.mjs'
import type { DeviceOptions } from '../src/device.mjs'
import { DeviceExternalRpc } from '../src/external/device-rpc.mjs'
import { ManagerResets } from '../src/manager-reset.mjs'
import { managerHandoverIndex, ruleSettings } from '../src/manager-rules.mjs'
import { startChild } from '../src/session-start.mjs'
import { openTaskDatabase, type TaskRow, TaskStore } from '../src/task-store.mjs'
import { codexThread, FakeCodex } from './fake-codex.mjs'
import { FakeControl, managed } from './fake-control.mjs'
import type { FakeTurn } from './fake-engine.mjs'
import { FakeEngine } from './fake-engine.mjs'
import {
  bot,
  githubMock,
  owner,
  repoPath,
  respond,
  subject,
  token,
} from './fixtures/external-d.mjs'
import { rig } from './helpers.mjs'
import { until } from './tree-kit.mjs'

/** 两个协议假引擎；HOME/凭据由 helpers 的隔离夹具接管，不调用个人 CLI 或模型入口。 */
async function setup(source = 'claude-code', external?: DeviceOptions['external']) {
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
      ...(external ? { external } : {}),
      dial: (socket) => fakes[socket.slice('fake://'.length) as keyof typeof fakes].connector,
      log: (line) => logs.push(line),
    },
  )
  const client = env.connect()
  await client.initialize([
    'harness',
    'litchManager',
    'litchManagerResetTarget',
    'sessionTree',
    EXTERNAL_SOURCES_EXTENSION,
  ])
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

test('Claude 刷新被引擎接受但工具未安装时，保留已应用指纹', async () => {
  const env = await setup()
  try {
    const { id } = env.manager
    const oldTools = env.tree.store.tools(env.oldId)
    const applied = env.device.managers.store.reset(id)?.applied
    assert.ok(oldTools && applied)
    await env.client.call(MANAGER_METHOD.update, { managerId: id, rules: '更新规则' })
    await until(() => env.running('claude-code', env.oldId), '规则回合')
    env.end('claude-code', env.oldId)
    await until(() => !env.tree.isActive(env.oldId), '等待回合结束')

    // 让恢复接口成功返回，但不安装带新规则的清单。
    const original = env.claude.handlers['thread/resume']
    assert.ok(original)
    env.claude.handlers['thread/resume'] = (params, connection) => {
      const { dynamicTools, ...rest } = params
      return original(
        (JSON.stringify(dynamicTools) ?? '').includes('更新规则') ? rest : params,
        connection,
      )
    }
    await env.client.call(MANAGER_METHOD.reset, env.input(await env.preview('claude-code')))
    await until(() => env.current().reset?.phase === 'failed', '未实际应用，刷新报错')
    assert.equal(env.device.managers.store.reset(id)?.applied, applied)
    assert.deepEqual(env.tree.store.tools(env.oldId), oldTools)
    assert.equal(env.current().threadId, env.oldId)
  } finally {
    await env.close()
  }
})

for (const [harness, rulesFirst] of [
  ['claude-code', true],
  ['claude-code', false],
  ['codex', true],
  ['codex', false],
] as const)
  test(`${harness}：${rulesFirst ? '改规则再重置' : '重置再改规则'}后 GitHub 请求仍送达`, {
    timeout: 20_000,
  }, async (t) => {
    let now = Math.floor(Date.now() / 1000)
    const iso = () => new Date(now * 1000).toISOString()
    const actor = { id: owner, type: 'User', login: 'owner' }
    let request: { [key: string]: unknown } | undefined
    const github = await githubMock(t, (_req, res, url) => {
      res.setHeader('date', iso())
      if (url.pathname === repoPath + '/issues') respond(res, request ? [request] : [])
      else if (url.pathname === repoPath + '/issues/8' && request) respond(res, request)
      else if (url.pathname === '/users/owner' || url.pathname === `/user/${owner}`)
        respond(res, actor)
      else if (
        [
          repoPath + '/issues/events',
          repoPath + '/issues/comments',
          repoPath + '/pulls/comments',
        ].includes(url.pathname)
      )
        respond(res, [])
      else return false
      return true
    })
    const env = await setup(harness, { fixture: { github: github.origin, now: () => now } })
    try {
      const external = env.device.external
      assert.ok(external)
      const { id } = env.manager
      let threadId = env.oldId
      external.store.config.setOwner(
        {
          provider: 'github',
          userId: owner,
          method: 'userId',
          loginCache: 'owner',
          profileUrl: 'https://github.com/owner',
        },
        'test',
        0,
        'owner',
      )
      const auth = await external.secrets.configure({
        token: token('dispatch'),
        operationId: 'broker',
        repoIds: [subject.repoId],
      })
      assert.equal(auth.outcome, 'applied')
      assert.ok(auth.record)
      const draft: ExternalSourceDraft = {
        sourceId: 'dispatch-fixture',
        provider: 'github',
        enabled: true,
        credentialRef: auth.record.credentialRef,
        botUserId: bot,
        triggers: {
          mention: true,
          assignment: true,
          reviewRequest: true,
          label: false,
          labelIds: [],
        },
        minRole: 'triage',
        interval: 60,
        repos: [
          {
            repoId: subject.repoId,
            owner: 'example',
            name: 'demo',
            url: 'https://github.com/example/demo',
            localRoot: env.stateDir,
            allowedBase: ['main'],
            headNamespace: 'litch/',
            pollIdentity: bot,
            immediateFeedback: false,
          },
        ],
        routes: [],
        writePolicy: { comment: false, draftPr: false, status: false, managedPush: false },
        unattended: { autoNotify: true },
      }
      const saved = external.store.config.saveSource(draft, 0, 'source', 'test', now)
      assert.equal(saved.outcome, 'applied')
      external.store.config.saveAssignment(
        { managerId: id, identityId: bot, repoIds: [subject.repoId] },
        0,
        'assign',
        () => {},
      )
      const source = external.store.config.source(draft.sourceId)
      assert.ok(source)
      await until(() => !!external.poll.status(source).lastSuccessAt, '空仓库的初始轮询', 5000)

      const editRules = async () => {
        await env.client.call(MANAGER_METHOD.update, {
          managerId: id,
          rules: '新文字规则，只在下一回合生效',
          name: '改名后的经理',
          scope: '新范围',
          contact: { desktopNotification: true, unanswered: 'wait' },
        })
        await until(() => env.running(harness, threadId), '现有规则更新回合')
        env.end(harness, threadId)
        await until(() => !env.tree.isActive(threadId), '规则回合结束')
      }
      if (rulesFirst) await editRules()
      const plan = await env.preview(harness)
      assert.equal(plan.mode, harness === 'claude-code' ? 'refresh' : 'replace')
      await env.client.call(MANAGER_METHOD.reset, env.input(plan))
      if (harness === 'codex') {
        await until(() => env.running(harness, threadId), '旧线程生成交接摘要')
        env.end(harness, threadId)
        await until(() => env.current().threadId !== threadId, '新线程已提交')
        threadId = env.current().threadId
        await until(() => env.running(harness, threadId), '新线程接班')
        env.end(harness, threadId)
        await until(() => !env.tree.isActive(threadId), '接班结束')
      }
      await until(() => env.current().reset?.phase === 'ready', '重置完成')
      const installed = (
        env.tree.store.tools(threadId) as { name: string; instructions?: string }[]
      ).find(({ name }) => name === 'litch_manager')
      assert.ok(installed?.instructions)
      assert.match(
        ruleSettings(installed.instructions)?.rules ?? '',
        rulesFirst ? /新文字规则/ : /保持约束/,
      )
      if (!rulesFirst) await editRules()
      const missingTools = harness === 'claude-code' && !rulesFirst
      assert.deepEqual(env.device.managers.externalReady(env.current()), { ready: true })
      assert.equal(env.current().reset?.outdated, false)
      if (harness === 'codex') {
        const latest = env.codex.seen
          .filter(({ method }) => method === 'thread/resume')
          .map(({ params }) => params)
          .findLast(({ developerInstructions }) => typeof developerInstructions === 'string')
        assert.match(String(latest?.developerInstructions), /新文字规则/)
      }

      // Claude 模拟工具确实少装一个；原来的文字规则不动，必须等待原地刷新。
      if (missingTools) {
        const old = env.tree.store.tools(threadId)
        assert.ok(old)
        const withoutTool = structuredClone(old) as { name: string; tools?: { name: string }[] }[]
        const bundle = withoutTool.find((row) => row.name === 'litch_manager')
        assert.ok(bundle?.tools)
        bundle.tools = bundle.tools.filter(({ name }) => name !== 'external_read')
        env.tree.store.setTools(threadId, withoutTool)
        const thread = env.claude.threads.find(({ id }) => id === threadId)
        assert.ok(thread)
        thread.dynamicTools = withoutTool
        assert.deepEqual(new DeviceExternalRpc(external).status(draft.sourceId).readiness.notify, {
          state: 'blocked',
          diagnostics: [
            {
              check: 'managerTools',
              state: 'blocked',
              code: 'manager_tools_outdated',
              recovery: { managerId: id, threadId, action: 'refresh' },
            },
          ],
        })
      }

      now += 8
      request = {
        id: '1008',
        number: 8,
        state: 'open',
        title: '新请求',
        body: '@litch-device please check this',
        user: actor,
        created_at: iso(),
        updated_at: iso(),
        url: `https://api.github.com${repoPath}/issues/8`,
        html_url: subject.url,
        labels: [],
        assignees: [],
      }
      now += 60
      const inbox = async () => {
        const { entries } = await env.client.call(EXTERNAL_METHOD.inboxList, { managerId: id })
        return entries.find((row: { subject: { number: string } }) => row.subject.number === '8')
      }
      try {
        await until(async () => !!(await inbox()), '回环 GitHub 请求入箱', 6000)
      } catch (error) {
        t.diagnostic(
          JSON.stringify({
            runtime: external.poll.status(source),
            requests: github.requests.map(({ path }) => path),
            inbox: external.store
              .inbox({})
              .entries.map(({ status, reason }) => ({ status, reason })),
          }),
        )
        throw error
      }
      if (missingTools) {
        const { delivery } = await inbox()
        assert.equal(delivery.state, 'queued')
        assert.equal(delivery.reason, 'manager_tools_outdated')
        assert.equal(delivery.recovery.action, 'refresh')
        assert.equal(env.running(harness, threadId), false)
      }
      now += 31
      await until(
        async () => (await inbox())?.delivery?.state === 'confirmed',
        '自动恢复并寄达经理回合',
        6000,
      )
      assert.equal(env.current().threadId, threadId)
      const engine = harness === 'claude-code' ? env.claude : env.codex
      assert.ok(
        engine.seen
          .filter(({ method }) => method === 'turn/start')
          .map(({ params }) => params)
          .some(
            ({ input }) =>
              parseSessionEvent(input[0].text).event?.kind === 'manager-external-triage',
          ),
      )
      assert.equal(env.current().reset?.phase, 'ready')
    } finally {
      await env.close()
    }
  })

for (const harness of ['claude-code', 'codex']) {
  test(`${harness}：旧结果回帖工具先升级，收尾提醒不投给旧形状`, async (t) => {
    const github = await githubMock(t)
    const env = await setup(harness, { fixture: { github: github.origin } })
    try {
      const id = env.manager.id
      const external = env.device.external
      assert.ok(external)
      const old = structuredClone(env.tree.store.tools(env.oldId)) as ClientToolNamespaceSpec[]
      const write = old
        .find((row) => row.name === 'litch_manager')
        ?.tools.find((tool) => tool.name === 'external_write')
      assert.ok(write)
      const properties = (
        write.inputSchema as {
          properties: { intent: { oneOf: { properties: Record<string, unknown> }[] } }
        }
      ).properties.intent.oneOf[0]?.properties
      assert.ok(properties?.purpose)
      delete properties.purpose
      env.tree.store.setTools(env.oldId, old)
      const engine = harness === 'codex' ? env.codex : env.claude
      const thread = engine.threads.find((row) => row.id === env.oldId)
      assert.ok(thread)
      thread.dynamicTools = old
      assert.deepEqual(env.device.managers.externalReady(env.current()), {
        ready: false,
        reason: 'manager_tools_outdated',
        action: harness === 'claude-code' ? 'refresh' : 'replace',
      })
      const { issue } = env.device.managers.issues.call(
        MANAGER_ISSUE_METHOD.create,
        { managerId: id, title: '旧工具待升级', body: '', followUp: 'off' },
        'manager',
      ) as { issue: ManagerIssue }
      assert.equal(issue.id, 'X-1')
      const at = Math.floor(Date.now() / 1000)
      external.store.bindRef({
        ...subject,
        managerId: id,
        issueId: 'X-1',
        origin: 'intake',
        createdAt: at,
      })
      external.store.resultReplies.accepted(id, 'X-1', 'fixture', subject, at)
      external.store.resultReplies.finish(id, 'X-1')
      external.store.resultReplies.queueReminders()
      const reminders = () =>
        engine.seen.filter(
          ({ method, params }) =>
            ['turn/start', 'turn/steer'].includes(method) &&
            parseSessionEvent(params.input?.[0]?.text ?? '').event?.externalResultReplies?.length,
        )
      // 直接等这一轮持久队列投递结束，不能用短暂等待断言“没有发送”。
      await (env.device.managers as unknown as { drain(managerId: string): Promise<void> }).drain(
        id,
      )
      assert.equal(reminders().length, 0, '旧 schema 不应收到 purpose=result 的提醒')
      assert.equal(external.store.resultReplies.pendingManagerIds().includes(id), true)
      if (harness === 'codex') {
        assert.equal(env.current().threadId, env.oldId, '不能自动换掉 Codex 经理')
        const plan = await env.preview(harness)
        assert.equal(plan.mode, 'replace')
        await env.client.call(MANAGER_METHOD.reset, env.input(plan))
        await until(() => env.running(harness, env.oldId), '用户确认后生成交接摘要')
        env.end(harness, env.oldId)
        await until(() => env.current().threadId !== env.oldId, '确认接班后才换线程')
      }
      await until(
        () => env.device.managers.externalReady(env.current()).ready,
        '实际新工具已安装',
        5000,
      )
      await until(
        () => {
          env.device.managers.kick(id)
          return reminders().length === 1
        },
        '升级后送达保留的收尾提醒',
        5000,
      )
      assert.equal(reminders()[0]?.params.threadId, env.current().threadId)
      if (harness === 'claude-code') assert.equal(env.current().threadId, env.oldId)
    } finally {
      await env.close()
    }
  })

  test(`${harness}：回报提示按已绑定的工作投递，队列和去重使用实时回执`, async (t) => {
    const github = await githubMock(t)
    const env = await setup(harness, { fixture: { github: github.origin } })
    try {
      const { id } = env.manager
      const external = env.device.external
      assert.ok(external)
      const store = external.store
      const replies = store.resultReplies
      const at = Math.floor(Date.now() / 1000)
      const sourceId = 'fixture'
      const seen = () => (harness === 'codex' ? env.codex : env.claude).seen
      const parentEvents = (method: string) =>
        seen()
          .filter((call) => call.method === method && call.params.threadId === env.oldId)
          .map((call) => parseSessionEvent(call.params.input[0].text).event)
      const bind = (idNumber: number) => {
        const { issue } = env.device.managers.issues.call(
          MANAGER_ISSUE_METHOD.create,
          {
            managerId: id,
            title: `请求 ${idNumber}`,
            body: '测试',
            followUp: 'off',
          },
          'manager',
        ) as { issue: ManagerIssue }
        const issueId = `X-${idNumber}` as const
        assert.equal(issue.id, issueId)
        const origin = {
          ...subject,
          number: String(idNumber),
          url: `https://github.com/example/demo/issues/${idNumber}`,
        }
        store.bindRef({ ...origin, managerId: id, issueId, origin: 'intake', createdAt: at })
        replies.accepted(id, issueId, sourceId, origin, at)
        return { issueId, origin }
      }
      const relate = (
        from: { kind: 'issue' | 'item'; target: string },
        to: { kind: 'item' | 'thread'; target: string },
      ) =>
        env.device.managers.store.saveRelation(id, {
          id: JSON.stringify([from, to]),
          kind: 'related',
          from,
          to,
          at,
          by: 'manager',
        })
      const first = bind(1)
      const answered = bind(2)
      const queued = bind(3)
      const acceptReceipt = (
        result: ReturnType<typeof bind>,
        action: 'comment' | 'ack_comment_create',
        purpose: boolean,
      ) =>
        replies.confirmed({
          seq: 1,
          operationId: 'fixture-receipt',
          sourceId,
          managerId: id,
          issueId: result.issueId,
          targetRef: result.origin,
          action,
          state: 'confirmed',
          revision: 1,
          attempts: 1,
          idempotencyKey: 'fixture',
          actorThreadId: env.oldId,
          policyRevision: 1,
          payloadHash: 'fixture',
          payloadRef: 'fixture',
          receipt: {
            objectId: '12',
            botUserId: '22',
            at,
            url: result.origin.url,
            verifiedBy: 'response',
          },
          ...(purpose ? { resultReply: true } : {}),
        })
      acceptReceipt(first, 'ack_comment_create', false)
      acceptReceipt(answered, 'comment', true)
      const textInput = (text: string) => [{ type: 'text', text, text_elements: [] }]
      const startLine = () =>
        startChild(
          env.tree,
          env.oldId,
          {
            kind: 'fresh',
            title: 'GitHub 工作线',
            prompt: '做测试',
            harness: 'claude-code',
            wakeParent: false,
            worktree: false,
          },
          'model',
        )
      const child = await startLine()
      for (const entry of [first, answered])
        relate({ kind: 'issue', target: entry.issueId }, { kind: 'thread', target: child.threadId })
      await env.client.call('turn/start', { threadId: env.oldId, input: textInput('继续核对') })
      await until(() => env.running(harness, env.oldId), '经理正在运行')
      await until(() => env.claude.running(child.threadId), '工作线正在运行')
      env.end('claude-code', child.threadId, '真实工作线回报')
      await until(
        () =>
          parentEvents('turn/steer').some((event) => event?.notes[0]?.excerpt === '真实工作线回报'),
        '工作线回报实时插话',
      )
      const sent = parentEvents('turn/steer').find(
        (event) => event?.notes[0]?.excerpt === '真实工作线回报',
      )
      assert.deepEqual(
        sent?.externalResultReplies?.map(({ issueId }) => issueId),
        ['X-1'],
      )
      assert.equal(replies.reportHint(id, first.issueId), null, '同一 X-n 的回报不再重复提醒')

      env.end(harness, env.oldId)
      await until(() => !env.tree.isActive(env.oldId), '经理回合结束')
      const later = await startLine()
      relate({ kind: 'item', target: 'I-1' }, { kind: 'thread', target: later.threadId })
      env.device.managers.store.saveRelation(id, {
        id: 'work-for-x3',
        kind: 'derived',
        from: { kind: 'item', target: 'I-1' },
        to: { kind: 'issue', target: queued.issueId },
        at,
        by: 'manager',
      })
      env.tree.store.addNote(
        env.oldId,
        {
          threadId: later.threadId,
          title: 'GitHub 工作线',
          status: 'completed',
          turnId: 'queued-turn',
          excerpt: '排队等待的回报',
        },
        false,
      )
      await env.client.call('turn/start', { threadId: env.oldId, input: textInput('取排队回报') })
      const pending = parentEvents('turn/start').find(
        (event) => event?.notes[0]?.excerpt === '排队等待的回报',
      )
      assert.deepEqual(
        pending?.externalResultReplies?.map(({ issueId }) => issueId),
        ['X-3'],
      )
      assert.equal(replies.reportHint(id, queued.issueId), null)

      const close = (status: 'resolved' | 'closed') => {
        const current = env.device.managers.issues.get(id, first.issueId)
        env.device.managers.issues.call(
          MANAGER_ISSUE_METHOD.update,
          {
            managerId: id,
            id: first.issueId,
            revision: current.revision,
            patch: { status },
            why: '测试收尾',
          },
          'manager',
        )
      }
      close('resolved')
      close('closed')
      replies.queueReminders()
      replies.queueReminders()
      const reminders = () =>
        env.device.managers.store
          .deliveries(id)
          .filter(({ text }) => parseSessionEvent(text).event?.externalResultReplies?.length)
      assert.equal(reminders().length, 1)
      assert.equal(replies.missing(id, first.issueId)?.subject.url, first.origin.url)
      acceptReceipt(first, 'comment', true)
      assert.equal(reminders().length, 0, '补回后移除还没送达的提醒')
      assert.equal(replies.missing(id, first.issueId), null)

      // 发出后丢应答，从引擎历史确认已收到，不能再发第二次。
      const lost = bind(4)
      replies.finish(id, lost.issueId)
      replies.queueReminders()
      const engine = harness === 'codex' ? env.codex : env.claude
      const steer = engine.handlers['turn/steer']
      assert.ok(steer)
      let attempts = 0
      engine.handlers['turn/steer'] = (params, connection) => {
        const result = steer(params, connection)
        if (
          parseSessionEvent(params.input[0].text).event?.externalResultReplies?.[0]?.issueId ===
          lost.issueId
        ) {
          attempts++
          throw new Error('应答丢失，消息已提交')
        }
        return result
      }
      await until(() => {
        env.device.managers.kick(id)
        return attempts === 1
      }, '第一次已发送')
      await until(() => {
        env.device.managers.kick(id)
        return reminders().length === 0
      }, '历史已确认，出队时不重发')
      assert.equal(attempts, 1)
      engine.handlers['turn/steer'] = steer

      const waking = bind(5)
      relate({ kind: 'issue', target: waking.issueId }, { kind: 'thread', target: later.threadId })
      env.end(harness, env.oldId)
      await until(() => !env.tree.isActive(env.oldId), '等待空闲，核对唤醒入口')
      env.tree.store.addNote(
        env.oldId,
        {
          threadId: later.threadId,
          title: 'GitHub 工作线',
          status: 'completed',
          turnId: 'wake-turn',
          excerpt: '通过立即处理唤醒',
        },
        false,
      )
      assert.equal(await env.tree.deliver(env.oldId), 'woken')
      const wake = parentEvents('turn/start').find(
        (event) => event?.kind === 'wake' && event.notes[0]?.turnId === 'wake-turn',
      )
      assert.deepEqual(
        wake?.externalResultReplies?.map(({ issueId }) => issueId),
        ['X-5'],
      )
    } finally {
      await env.close()
    }
  })
}
