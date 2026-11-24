// 无人值守（src/unattended.mts）：经理有生效的外部来源时，经理和它整棵子树里要人答的东西不挂起等人，
// 当场以拒绝或工具错误返回，并告诉 Agent 改走什么路。前两条测纯函数，后面用真实设备聚合面加假引擎走一遍。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { ExternalSourceDraft } from '../../protocol/src/external-sources.mjs'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import { TIMED_APPROVAL, TIMED_APPROVALS_EXTENSION } from '../../protocol/src/timed-approvals.mjs'
import { ExternalStore } from '../src/external-store.mjs'
import { ManagerStore, openManagerDatabase } from '../src/manager-store.mjs'
import { startChild } from '../src/session-start.mjs'
import {
  externalUnattended,
  unattendedAnswer,
  unattendedNotice,
  unattendedReply,
} from '../src/unattended.mjs'
import type { FakeEngine } from './fake-engine.mjs'
import { failureOf } from './fake-engine.mjs'
import { brief, SESSIONS, TREE, type TreeEnv, treeRig, until } from './tree-kit.mjs'

const REPO_ID = '4242'

function draft(overrides: Partial<ExternalSourceDraft> = {}): ExternalSourceDraft {
  return {
    sourceId: 'unattended-source',
    provider: 'github',
    enabled: true,
    credentialRef: 'missing-credential',
    botUserId: '120',
    triggers: { mention: true, assignment: true, reviewRequest: true, label: false, labelIds: [] },
    minRole: 'triage',
    interval: 3600,
    repos: [
      {
        repoId: REPO_ID,
        owner: 'example',
        name: 'demo',
        url: 'https://github.com/example/demo',
        localRoot: '/work',
        allowedBase: ['main'],
        headNamespace: 'litch/',
      },
    ],
    routes: [],
    writePolicy: { comment: false, draftPr: false, status: false, managedPush: false },
    unattended: { autoNotify: true },
    ...overrides,
  }
}

function ledger(t: TestContext): ManagerStore {
  const dir = mkdtempSync(join(tmpdir(), 'unattended-'))
  const store = new ManagerStore(openManagerDatabase(dir))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

const QUESTIONS = [
  {
    id: 'q1',
    header: '范围',
    question: '改哪些目录？',
    isOther: true,
    isSecret: false,
    options: [],
  },
  { id: 'q2', header: '确认', question: '继续吗？', isOther: false, isSecret: false, options: [] },
]

test('UNATTENDED-001：各种要人答的请求的替人答复；对面列了 declineWithNote 才带说明', () => {
  const notice = unattendedNotice('line')
  assert.match(notice, /unattended/)
  assert.match(notice, /report to your manager/)
  assert.match(unattendedNotice('manager'), /litch_manager add, kind=decision/)
  const command = { threadId: 't', command: 'rm -rf build' }
  assert.deepEqual(unattendedAnswer('item/commandExecution/requestApproval', command, notice), {
    decision: 'decline',
  })
  assert.deepEqual(
    unattendedAnswer(
      'item/fileChange/requestApproval',
      { ...command, availableDecisions: ['accept', 'decline', 'declineWithNote'] },
      notice,
    ),
    { decision: { declineWithNote: { note: notice } } },
  )
  assert.deepEqual(unattendedAnswer('item/permissions/requestApproval', command, notice), {
    permissions: {},
    scope: 'turn',
  })
  assert.deepEqual(
    unattendedAnswer('item/tool/requestUserInput', { threadId: 't', questions: QUESTIONS }, notice),
    { answers: { q1: { answers: [notice] }, q2: { answers: [notice] } } },
  )
  assert.deepEqual(unattendedAnswer('mcpServer/elicitation/request', { threadId: 't' }, notice), {
    action: 'decline',
    content: null,
    _meta: null,
  })
  // 不归这里管的、判定说不是无人值守的、没有会话号的：照常
  assert.equal(unattendedAnswer('item/tool/call', command, notice), null)
  assert.equal(
    unattendedReply(() => null, 'item/commandExecution/requestApproval', command),
    null,
  )
  assert.equal(
    unattendedReply(() => 'line', 'item/commandExecution/requestApproval', { command: 'x' }),
    null,
  )
  assert.deepEqual(
    unattendedReply(() => 'manager', 'item/commandExecution/requestApproval', command),
    { decision: 'decline' },
  )
})

test('UNATTENDED-002：判定只认分给经理、采集开着且自动提醒开着的来源', (t) => {
  const store = new ExternalStore(ledger(t))
  const config = store.config
  assert.equal(externalUnattended(config, 'mgr'), false)
  assert.equal(config.saveSource(draft(), 0, 'save', 'admin').outcome, 'applied')
  // 来源开着但没分给这位经理
  assert.equal(externalUnattended(config, 'mgr'), false)
  config.saveAssignment(
    { managerId: 'mgr', identityId: null, repoIds: [REPO_ID] },
    0,
    'a',
    () => {},
  )
  assert.equal(externalUnattended(config, 'mgr'), true)
  assert.equal(externalUnattended(config, 'other'), false)
  // 关了自动提醒：外部事件不会自己唤醒经理，不算
  config.saveSource(draft({ unattended: { autoNotify: false } }), 1, 'quiet', 'admin')
  assert.equal(externalUnattended(config, 'mgr'), false)
  config.saveSource(draft({ unattended: { autoNotify: true } }), 2, 'loud', 'admin')
  assert.equal(externalUnattended(config, 'mgr'), true)
  // 采集暂停
  config.saveSource(draft({ enabled: false }), 3, 'pause', 'admin')
  assert.equal(externalUnattended(config, 'mgr'), false)
})

/** 引擎往会话的每条连接发一条要人答的请求，返回请求号 */
function ask(engine: FakeEngine, id: string, method: string, params: Record<string, unknown>) {
  for (const connection of engine.live) connection.send({ id, method, params })
  return id
}

/** 等引擎收到某个请求的答复 */
async function answerOf(engine: FakeEngine, id: string): Promise<any> {
  const find = () =>
    engine.live.flatMap((connection) => connection.answers).find((frame) => frame.id === id)
  await until(() => find() !== undefined, `${id} 有答复`, 2000)
  return find()
}

async function managerTree(env: TreeEnv) {
  env.pi.handlers['model/list'] = () => ({
    data: [
      {
        id: 'fake',
        model: 'fake',
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
      },
    ],
  })
  const client = env.connect()
  await client.initialize([...TREE, 'litchManager', TIMED_APPROVALS_EXTENSION], {
    litchClientTools: { namespaces: ['litch_echo'] },
  })
  const { manager, threadId } = await client.call(MANAGER_METHOD.create, {
    cwd: env.stateDir,
    harness: 'pi',
    model: 'fake',
    effort: 'high',
    name: '无人值守经理',
    scope: '',
    rules: '',
    template: 'blank',
    firstTask: '',
    dispatch: { ...MANAGER_DEFAULT_DISPATCH, worktree: false, maxRunningLines: 3 },
    contact: { ...MANAGER_DEFAULT_CONTACT },
  })
  const tree = env.device.sessionTree
  const line = await startChild(
    tree,
    threadId,
    {
      title: '工作线',
      ...brief('改代码'),
      harness: 'claude-code',
      kind: 'fresh',
      wakeParent: false,
      worktree: false,
    },
    'user',
  )
  const nested = await startChild(
    tree,
    line.threadId,
    {
      title: '工作线派的子会话',
      ...brief('查一处'),
      harness: 'pi',
      kind: 'fresh',
      wakeParent: false,
      worktree: false,
    },
    'user',
  )
  return {
    client,
    managerId: manager.id as string,
    threadId,
    line: line.threadId,
    nested: nested.threadId,
  }
}

test('UNATTENDED-E2E-001：无人值守经理、工作线、工作线的子会话遇到提问和审批都不挂起，收到无人值守的说明', async () => {
  const env = treeRig({}, { external: { fixture: { github: 'http://127.0.0.1:9' } } })
  try {
    const { client, managerId, threadId, line, nested } = await managerTree(env)
    const tree = env.device.sessionTree
    const external = env.device.external
    assert.ok(external)

    // 还没配外部来源：照常，工作线的提问进待答登记、没人替它答
    assert.equal(tree.unattended(line), null)
    ask(env.claude, 'q-before', 'item/tool/requestUserInput', {
      threadId: line,
      turnId: env.claude.current(line)?.id,
      itemId: 'question',
      questions: QUESTIONS,
    })
    await until(() => tree.pending.list(line).length === 1, '有人值守时提问进待答登记')

    external.store.config.saveSource(draft(), 0, 'save', 'admin')
    external.store.config.saveAssignment(
      { managerId, identityId: null, repoIds: [REPO_ID] },
      0,
      'assign',
      () => {},
    )
    assert.equal(tree.unattended(threadId), 'manager')
    assert.equal(tree.unattended(line), 'line')
    assert.equal(tree.unattended(nested), 'line')

    // 工作线（Claude）提问：设备连接当场答，每道题的答案都是那句话
    const question = ask(env.claude, 'q-line', 'item/tool/requestUserInput', {
      threadId: line,
      turnId: env.claude.current(line)?.id,
      itemId: 'question',
      questions: QUESTIONS,
    })
    const answered = await answerOf(env.claude, question)
    assert.deepEqual(answered.result, {
      answers: {
        q1: { answers: [unattendedNotice('line')] },
        q2: { answers: [unattendedNotice('line')] },
      },
    })
    // 只剩无人值守前那一条在等
    assert.equal(tree.pending.list(line).length, 1)

    // 子会话（Pi）的审批：列了 declineWithNote 的带说明拒绝，没列的普通拒绝
    const noted = ask(env.pi, 'a-nested', 'item/commandExecution/requestApproval', {
      threadId: nested,
      turnId: env.pi.current(nested)?.id,
      itemId: 'cmd',
      command: 'rm -rf build',
      availableDecisions: ['accept', 'decline', 'cancel', 'declineWithNote'],
    })
    assert.deepEqual((await answerOf(env.pi, noted)).result, {
      decision: { declineWithNote: { note: unattendedNotice('line') } },
    })
    const plainApproval = ask(env.pi, 'f-nested', 'item/fileChange/requestApproval', {
      threadId: nested,
      turnId: env.pi.current(nested)?.id,
      itemId: 'patch',
    })
    assert.deepEqual((await answerOf(env.pi, plainApproval)).result, { decision: 'decline' })
    assert.equal(tree.pending.list(nested).length, 0)

    // 限时授权在前：工作线授权内的命令审批照常放行，授权管不到的（提问、改文件）仍当场拒绝
    await client.call(TIMED_APPROVAL.grant, { threadId: line, category: 'command', hours: 1 })
    const timedCommand = ask(env.claude, 'a-line-timed', 'item/commandExecution/requestApproval', {
      threadId: line,
      turnId: env.claude.current(line)?.id,
      itemId: 'cmd',
      command: 'make',
      availableDecisions: ['accept', 'decline', 'declineWithNote'],
    })
    assert.deepEqual((await answerOf(env.claude, timedCommand)).result, { decision: 'accept' })
    const untimedFile = ask(env.claude, 'f-line-timed', 'item/fileChange/requestApproval', {
      threadId: line,
      turnId: env.claude.current(line)?.id,
      itemId: 'patch',
      availableDecisions: ['accept', 'decline', 'declineWithNote'],
    })
    assert.deepEqual((await answerOf(env.claude, untimedFile)).result, {
      decision: { declineWithNote: { note: unattendedNotice('line') } },
    })

    // MCP 征询同样是限时授权在前：授权的服务（tracker）的审批性质征询只允许这一次，不带“记住”；
    // 别的服务当场拒绝。征询的答复没有放说明的位置，只能普通拒绝（unattendedAnswer）
    await client.call(TIMED_APPROVAL.grant, {
      threadId: line,
      category: 'mcp',
      scope: 'tracker',
      hours: 1,
    })
    const elicit = (id: string, serverName: string) =>
      ask(env.claude, id, 'mcpServer/elicitation/request', {
        threadId: line,
        turnId: env.claude.current(line)?.id,
        serverName,
        mode: 'form',
        message: '允许运行 create_issue？',
        requestedSchema: { type: 'object', properties: {} },
        _meta: { codex_approval_kind: 'mcp_tool_call' },
      })
    const timedMcp = elicit('m-line-timed', 'tracker')
    assert.deepEqual((await answerOf(env.claude, timedMcp)).result, {
      action: 'accept',
      content: {},
      _meta: null,
    })
    const untimedMcp = elicit('m-line-other', 'other-server')
    assert.deepEqual((await answerOf(env.claude, untimedMcp)).result, {
      action: 'decline',
      content: null,
      _meta: null,
    })
    assert.equal(tree.pending.list(line).length, 1, 'MCP 征询都没进待答登记')

    // 经理自己：客户端订阅着时请求不转给客户端，经客户端那条上游当场答掉
    await client.call('thread/resume', { threadId })
    const managerQuestion = ask(env.pi, 'q-manager', 'item/tool/requestUserInput', {
      threadId,
      turnId: env.pi.current(threadId)?.id,
      itemId: 'question',
      questions: QUESTIONS.slice(0, 1),
    })
    assert.deepEqual((await answerOf(env.pi, managerQuestion)).result, {
      answers: { q1: { answers: [unattendedNotice('manager')] } },
    })
    assert.equal(
      client.requests.some((frame) => frame.id === managerQuestion),
      false,
      '客户端没收到提问',
    )

    // offer 卡要等人选：无人值守时直接失败，说明里带着无人值守的那句话
    const offer = (
      await env.pi.callTool(threadId, SESSIONS, 'start', { initiation: 'offer', title: '新任务' })
    )?.answer
    assert.equal(failureOf(offer), 'unattended')
    assert.match(offer.result.contentItems[0].text, /unattended/)

    // 客户端工具：转给执行方的那份带着标记，执行方据此不弹卡（桌面端核心的用例另测）
    const echo = env.pi.callTool(threadId, 'litch_echo', 'echo', { text: 'hi' })
    const call = await client.waitFor((frame) => frame.method === 'item/tool/call')
    assert.deepEqual((call.params as any).litchUnattended, { notice: unattendedNotice('manager') })
    client.answer(call.id, { success: true, contentItems: [] })
    await echo

    // 关掉自动提醒：回到有人值守，提问照常进待答登记
    external.store.config.saveSource(draft({ unattended: { autoNotify: false } }), 1, 'q', 'a')
    assert.equal(tree.unattended(line), null)
    ask(env.claude, 'q-after', 'item/tool/requestUserInput', {
      threadId: line,
      turnId: env.claude.current(line)?.id,
      itemId: 'question',
      questions: QUESTIONS,
    })
    await until(() => tree.pending.list(line).length === 2, '恢复有人值守后提问照常等人')
    assert.equal(
      env.claude.live.flatMap((c) => c.answers).some((frame) => frame.id === 'q-after'),
      false,
    )
  } finally {
    await env.close()
  }
})
