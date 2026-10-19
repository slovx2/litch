// 会话树（sessionTree 扩展，protocol/extensions/session-tree.json）在设备进程里的行为：派子会话（跨 harness、fork）、
// 父子关系挂在会话对象上、回报与唤醒及上限、提案、脱离、没声明的连接看不到扩展内容。上游是假引擎（fake-engine.mts）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSessionEvent } from '../../protocol/src/session-tree.mjs'
import { failureOf, resultOf } from './fake-engine.mjs'
import { settle } from './helpers.mjs'
import {
  got,
  litch,
  parent,
  plain,
  SESSIONS,
  startedOn,
  text,
  treeRig,
  until,
} from './tree-kit.mjs'

const LINEAGE = 'litch/thread/lineage/updated'
const PROPOSALS = 'litch/sessionProposal/changed'

/** 设备进程自己的连接替 pi 上的父会话开的回合（唤醒），按顺序 */
const wakesOf = (env: ReturnType<typeof treeRig>, threadId: string) =>
  env.pi
    .sent('turn/start')
    .filter((params) => params.threadId === threadId)
    .map((params) => parseSessionEvent(params.input[0].text).event)
    .filter((event) => event?.kind === 'wake')

test('SESSION-TREE-001：用户回合里模型派一个跨 harness 的子会话（pi 派 claude-code）：直接起，目录、权限、工具、简报照规矩，会话对象上挂着父子关系', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const other = await plain(env)
    const { threadId } = await parent(client)
    const call = await env.pi.callTool(threadId, SESSIONS, 'start', {
      title: '查一下构建为什么慢',
      prompt: '在 /work/app 里跑一遍构建，找出最慢的三步。',
      harness: 'claude-code',
      initiation: 'user_asked',
    })
    assert.ok(call, '调用应当落在发起回合的那条连接上')
    const result = resultOf(call.answer)
    assert.equal(result.thread_id, 'claude-code-t1')
    assert.match(result.note, /Started sub-session/)
    // 建子会话：目录跟父会话，审批和沙箱照父会话，客户端给父会话带的工具照样带上，再加 litch_sessions
    const [started] = env.claude.sent('thread/start')
    assert.equal(started.cwd, '/work/app')
    assert.equal(started.approvalPolicy, 'on-request')
    assert.equal(started.sandbox, 'workspace-write')
    assert.deepEqual(
      started.dynamicTools.map((spec: any) => spec.name),
      ['litch_echo', SESSIONS],
    )
    // 第一条消息：谁派的、任务、做完怎么回报
    const [brief] = env.claude.sent('turn/start')
    assert.equal(brief.threadId, 'claude-code-t1')
    assert.match(brief.input[0].text, new RegExp(threadId))
    assert.match(brief.input[0].text, /Task: 查一下构建为什么慢/)
    assert.match(brief.input[0].text, /找出最慢的三步/)
    assert.match(brief.input[0].text, /passes the beginning of your final answer back/)
    // 声明了 sessionTree 的连接：thread/started、父子关系的通知、列表和读取里都有 litchLineage
    const born = await startedOn(client, 'claude-code-t1')
    assert.equal(born.params.thread.harness, 'claude-code')
    assert.equal(born.params.thread.litchLineage.parentThreadId, threadId)
    assert.equal(born.params.thread.litchLineage.origin, 'model')
    assert.equal(born.params.thread.litchLineage.kind, 'fresh')
    assert.equal(born.params.thread.litchLineage.wakeParent, true)
    await until(() => got(client, LINEAGE).length === 1, '应当收到父子关系的通知')
    assert.equal(got(client, LINEAGE)[0].threadId, 'claude-code-t1')
    const listed = await client.call('thread/list', {})
    const child = listed.data.find((row: any) => row.id === 'claude-code-t1')
    assert.equal(child.litchLineage.parentThreadId, threadId)
    assert.equal(
      listed.data.find((row: any) => row.id === threadId).litchLineage,
      undefined,
      '父会话自己没有父会话',
    )
    const read = await client.call('thread/read', { threadId: 'claude-code-t1' })
    assert.equal(read.thread.litchLineage.title, '查一下构建为什么慢')
    // 没声明的连接：会话照常出现，但没有扩展字段、也收不到扩展的通知
    const seen = await startedOn(other, 'claude-code-t1')
    assert.equal(seen.params.thread.litchLineage, undefined)
    const plainList = await other.call('thread/list', {})
    assert.ok(plainList.data.every((row: any) => row.litchLineage === undefined))
    const plainRead = await other.call('thread/read', { threadId: 'claude-code-t1' })
    assert.equal(plainRead.thread.litchLineage, undefined)
    assert.equal(got(other, LINEAGE).length, 0)
  } finally {
    await env.close()
  }
})

test('SESSION-TREE-002：fork 用同 harness 的 thread/fork；跨 harness 的 fork、不认识的 harness、空标题都是参数不对', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const fork = await env.pi.callTool(threadId, SESSIONS, 'start', {
      title: '另一条路',
      prompt: '换个办法试试。',
      kind: 'fork',
      initiation: 'user_asked',
    })
    const childId = resultOf(fork?.answer).thread_id
    assert.equal(env.pi.sent('thread/fork')[0].threadId, threadId)
    assert.equal(env.pi.sent('thread/fork')[0].approvalPolicy, 'on-request')
    assert.match(childId, /-fork/)
    const brief = env.pi.sent('turn/start').find((params) => params.threadId === childId)
    assert.match(brief.input[0].text, /fork of/)
    const listed = await client.call('thread/read', { threadId: childId })
    assert.equal(listed.thread.litchLineage.kind, 'fork')
    for (const args of [
      { title: 'x', prompt: 'y', kind: 'fork', harness: 'claude-code', initiation: 'user_asked' },
      { title: 'x', prompt: 'y', harness: 'gemini', initiation: 'user_asked' },
      { title: ' ', prompt: 'y', initiation: 'user_asked' },
      { title: 'x', prompt: 'y', kind: 'clone', initiation: 'user_asked' },
    ]) {
      const call = await env.pi.callTool(threadId, SESSIONS, 'start', args)
      assert.equal(failureOf(call?.answer), 'invalid', JSON.stringify(args))
    }
  } finally {
    await env.close()
  }
})

test('SESSION-TREE-003：不是用户发起的回合里说 user_asked 也只出提案；接受、不要、过期都通知声明过的连接', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const other = await plain(env)
    const { threadId } = await parent(client, false)
    // 引擎自己开的回合（没有发起的连接）：不算用户发起的
    env.pi.selfTurn(threadId)
    const asked = await env.pi.callTool(threadId, SESSIONS, 'start', {
      title: '整理日志',
      prompt: '把 logs 里的错误按类归一下。',
      harness: 'claude-code',
      initiation: 'user_asked',
    })
    const proposal = resultOf(asked?.answer)
    assert.ok(proposal.proposal_id)
    assert.equal(proposal.thread_id, undefined)
    assert.match(proposal.note, /not started by the user/)
    assert.equal(env.claude.sent('thread/start').length, 0, '提案不起任何东西')
    const second = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'start', {
          title: '再看看',
          prompt: '随便看看。',
        })
      )?.answer,
    )
    await until(() => got(client, PROPOSALS).length === 2, '两个提案各有一条通知')
    assert.equal(got(client, PROPOSALS)[1].proposals.length, 2)
    assert.equal(got(other, PROPOSALS).length, 0, '没声明的连接收不到')
    const listed = await client.call('litch/sessionProposal/list', { threadId })
    assert.deepEqual(
      listed.proposals.map((one: any) => [one.title, one.status, one.harness]),
      [
        ['整理日志', 'pending', 'claude-code'],
        ['再看看', 'pending', null],
      ],
    )
    assert.equal(
      listed.proposals[0].expiresAt - listed.proposals[0].createdAt,
      7 * 24 * 3600,
      '提案 7 天过期',
    )
    const accepted = await client.call('litch/sessionProposal/accept', {
      proposalId: proposal.proposal_id,
    })
    assert.equal(accepted.threadId, 'claude-code-t1')
    const child = await client.call('thread/read', { threadId: accepted.threadId })
    assert.equal(child.thread.litchLineage.origin, 'proposal')
    const again = await client.fails('litch/sessionProposal/accept', {
      proposalId: proposal.proposal_id,
    })
    assert.match(again.message, /已经开始了/)
    await client.call('litch/sessionProposal/dismiss', { proposalId: second.proposal_id })
    assert.deepEqual((await client.call('litch/sessionProposal/list', { threadId })).proposals, [])
    // 过期：库里放一个已经到期的
    env.device.sessionTree.store.addProposal({
      id: 'old',
      threadId,
      title: '早就过期',
      prompt: 'x',
      harness: null,
      model: null,
      cwd: null,
      kind: 'fresh',
      wakeParent: true,
      createdAt: 1,
      expiresAt: 2,
    })
    const before = got(client, PROPOSALS).length
    assert.deepEqual((await client.call('litch/sessionProposal/list', { threadId })).proposals, [])
    await until(() => got(client, PROPOSALS).length > before, '过期也要通知')
    assert.equal(env.device.sessionTree.store.proposal('old')?.status, 'expired')
    const late = await client.fails('litch/sessionProposal/accept', { proposalId: 'old' })
    assert.match(late.message, /过期了/)
  } finally {
    await env.close()
  }
})

test('SESSION-TREE-004：子会话一回合结束进父会话的队列；父会话还在跑不唤醒，停下了才唤醒，回报取前 400 字', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const childId = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'start', {
          title: '跑测试',
          prompt: '跑一遍测试。',
          harness: 'claude-code',
          initiation: 'user_asked',
        })
      )?.answer,
    ).thread_id
    env.claude.end(childId, 'completed', `结果：${'好'.repeat(600)}`)
    await until(() => env.device.sessionTree.store.notes(threadId).length === 1, '回报进队列')
    await settle(50)
    assert.equal(wakesOf(env, threadId).length, 0, '父会话还在跑，不唤醒')
    env.pi.end(threadId, 'completed', '派出去了')
    await until(() => wakesOf(env, threadId).length === 1, '父会话停下后唤醒')
    const [wake] = wakesOf(env, threadId)
    assert.equal(wake?.notes.length, 1)
    assert.equal(wake?.notes[0]?.threadId, childId)
    assert.equal(wake?.notes[0]?.status, 'completed')
    assert.equal(wake?.notes[0]?.excerpt.length, 400)
    assert.equal(env.device.sessionTree.store.notes(threadId).length, 0, '交出去了就不再排队')
    // 同一个回合的结束通知从几条连接各来一份，只报一次
    env.claude.notify('turn/completed', {
      threadId: childId,
      turn: env.claude.turns.get(childId)?.[0],
    })
    await settle(30)
    assert.equal(env.device.sessionTree.store.notes(threadId).length, 0)
  } finally {
    await env.close()
  }
})

/** 在 pi 上的父会话里（用户回合）派一个 claude-code 的子会话，返回两个会话号 */
async function family(env: ReturnType<typeof treeRig>, wake = true) {
  const client = await litch(env)
  const { threadId } = await parent(client)
  const childId = resultOf(
    (
      await env.pi.callTool(threadId, SESSIONS, 'start', {
        title: '子任务',
        prompt: '做点事。',
        harness: 'claude-code',
        wake_parent: wake,
        initiation: 'user_asked',
      })
    )?.answer,
  ).thread_id as string
  return { client, threadId, childId }
}

test('SESSION-TREE-005：每条用户消息之后最多唤醒 10 次；用户再说话时攒着的回报附在用户消息前面，计数清零', async () => {
  const env = treeRig()
  try {
    const { client, threadId, childId } = await family(env)
    env.claude.end(childId, 'completed', '第 0 次')
    env.pi.end(threadId)
    await until(() => wakesOf(env, threadId).length === 1, '第一次唤醒')
    for (let round = 1; round <= 10; round++) {
      // 唤醒回合结束；子会话自己又跑了一回合（引擎自己续跑的，不是用户在子会话里说的话）
      await until(() => env.pi.running(threadId) || round > 9, '唤醒回合在跑')
      if (env.pi.running(threadId)) env.pi.end(threadId)
      env.claude.selfTurn(childId)
      env.claude.end(childId, 'completed', `第 ${round} 次`)
      if (round < 10)
        await until(() => wakesOf(env, threadId).length === round + 1, `第 ${round + 1} 次唤醒`)
    }
    await until(
      () => env.device.sessionTree.store.notes(threadId).length === 1,
      '第 11 次的回报排着',
    )
    await settle(60)
    assert.equal(wakesOf(env, threadId).length, 10, '到 10 次就不再唤醒')
    // 用户说话：回报包成 notes 放在前面，用户自己的话在后面
    await client.call('turn/start', { threadId, input: text('接着来') })
    const sent = env.pi.sent('turn/start').at(-1)
    const parsed = parseSessionEvent(sent.input[0].text)
    assert.equal(parsed.event?.kind, 'notes')
    assert.equal(parsed.event?.notes[0]?.excerpt, '第 10 次')
    assert.equal(parsed.rest, '接着来')
    assert.equal(env.device.sessionTree.store.notes(threadId).length, 0)
    assert.equal(env.device.sessionTree.store.wakes(threadId), 0, '用户说话之后重新计数')
  } finally {
    await env.close()
  }
})

test('SESSION-TREE-006：不要唤醒的子会话、用户自己在子会话里说的那一回合：只回报不唤醒；没有回报时用户消息原样交出去', async () => {
  const env = treeRig()
  try {
    const { client, threadId, childId } = await family(env, false)
    env.claude.end(childId, 'completed', '安静地做完了')
    env.pi.end(threadId)
    await until(() => env.device.sessionTree.store.notes(threadId).length === 1, '回报进队列')
    await settle(60)
    assert.equal(wakesOf(env, threadId).length, 0)
    await client.call('turn/start', { threadId, input: text('那个怎么样了') })
    const first = env.pi.sent('turn/start').at(-1)
    assert.equal(parseSessionEvent(first.input[0].text).event?.notes[0]?.excerpt, '安静地做完了')
    env.pi.end(threadId)
    await client.call('turn/start', { threadId, input: text('好') })
    assert.deepEqual(env.pi.sent('turn/start').at(-1).input, text('好'), '没有回报就原样')
    // 要唤醒的子会话，但这一回合是用户自己在子会话里发起的：回报照进，不唤醒
    env.pi.end(threadId)
    const other = await env.pi.callTool(threadId, SESSIONS, 'start', {
      title: '另一个',
      prompt: '做点别的。',
      harness: 'claude-code',
      initiation: 'propose',
    })
    const proposalId = resultOf(other?.answer).proposal_id
    const { threadId: second } = await client.call('litch/sessionProposal/accept', { proposalId })
    env.claude.end(second, 'completed', '设备发的第一回合')
    await until(() => wakesOf(env, threadId).length === 1, '设备发的回合结束了要唤醒')
    env.pi.end(threadId)
    await client.call('turn/start', { threadId: second, input: text('我亲自问一句') })
    env.claude.end(second, 'completed', '答用户的')
    await until(() => env.device.sessionTree.store.notes(threadId).length === 1, '用户回合也回报')
    await settle(60)
    assert.equal(wakesOf(env, threadId).length, 1, '用户自己驱动的回合不唤醒')
  } finally {
    await env.close()
  }
})

test('SESSION-TREE-007：没有客户端连着时只攒着不唤醒，有客户端连上来再唤醒', async () => {
  const env = treeRig()
  try {
    const { client, threadId, childId } = await family(env)
    env.pi.end(threadId)
    client.close()
    await settle(20)
    env.claude.end(childId, 'completed', '没人看着的时候做完了')
    await until(
      () => env.device.sessionTree.store.notes(threadId).length === 1,
      '没人连着也照样回报',
    )
    await settle(60)
    assert.equal(wakesOf(env, threadId).length, 0, '没人连着不唤醒')
    await litch(env)
    await until(() => wakesOf(env, threadId).length === 1, '连上来之后唤醒')
  } finally {
    await env.close()
  }
})

test('SESSION-TREE-008：子会话里的审批没人答：设备进程不替它答，挂满一阵算它停下在等用户，回报 needsUser 并唤醒父会话', async () => {
  const env = treeRig()
  try {
    const { threadId, childId } = await family(env)
    env.pi.end(threadId)
    const request = env.claude.approval(childId)
    await until(() => wakesOf(env, threadId).length === 1, '在等用户的子会话算停下')
    const [wake] = wakesOf(env, threadId)
    assert.equal(wake?.notes[0]?.status, 'needsUser')
    const answered = env.claude.connections.flatMap((connection) => connection.answers)
    assert.ok(
      answered.every((frame) => frame.id !== request),
      '审批只由用户答，设备进程不答',
    )
  } finally {
    await env.close()
  }
})

test('SESSION-TREE-009：脱离成独立会话：父子关系没了、通知 null，之后的回合不再回报；不是子会话的脱离报错', async () => {
  const env = treeRig()
  try {
    const { client, threadId, childId } = await family(env)
    await client.call('litch/session/detach', { threadId: childId })
    await until(
      () =>
        got(client, LINEAGE).some(
          (params) => params.threadId === childId && params.lineage === null,
        ),
      '脱离的通知',
    )
    const read = await client.call('thread/read', { threadId: childId })
    assert.equal(read.thread.litchLineage, undefined)
    env.claude.end(childId, 'completed', '已经独立了')
    env.pi.end(threadId)
    await settle(60)
    assert.equal(env.device.sessionTree.store.notes(threadId).length, 0)
    assert.equal(wakesOf(env, threadId).length, 0)
    const failure = await client.fails('litch/session/detach', { threadId })
    assert.match(failure.message, /不是谁的子会话/)
  } finally {
    await env.close()
  }
})

test('SESSION-TREE-010：用户在界面上派子会话（litch/session/start）：权限收紧到不宽于父会话，跟父会话在同一个工作区', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const project = await client.call('project/create', {
      idempotencyKey: 'tree-010',
      name: 'app',
      roots: [{ path: '/work/app' }],
    })
    const created = await client.call('thread/start', {
      harness: 'pi',
      cwd: '/work/app',
      projectId: project.project.id,
    })
    const threadId = created.thread.id
    env.pi.config = { approvalPolicy: 'untrusted', sandbox: { type: 'readOnly' } }
    const { threadId: childId } = await client.call('litch/session/start', {
      parentThreadId: threadId,
      harness: 'claude-code',
      kind: 'fresh',
      title: '手动派的',
      prompt: '看看 README。',
      wakeParent: false,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      effort: 'high',
    })
    const [started] = env.claude.sent('thread/start')
    assert.equal(started.approvalPolicy, 'untrusted')
    assert.equal(started.sandbox, 'read-only')
    assert.equal(env.claude.sent('turn/start')[0].effort, 'high')
    const read = await client.call('thread/read', { threadId: childId })
    assert.equal(read.thread.projectId, project.project.id)
    assert.equal(read.thread.litchLineage.origin, 'user')
    assert.equal(read.thread.litchLineage.wakeParent, false)
    // 没给工具的父会话：子会话只带 litch_sessions
    assert.deepEqual(
      started.dynamicTools.map((spec: any) => spec.name),
      [SESSIONS],
    )
  } finally {
    await env.close()
  }
})

test('SESSION-TREE-011：设备进程到子会话所在 harness 的连接断了：隔一阵重开、重新订阅在跑的子会话，之后的回合照样回报', async () => {
  const env = treeRig()
  try {
    const { threadId, childId } = await family(env)
    const own = () =>
      [...env.claude.greetings.entries()]
        .filter(([, greeting]) => greeting.clientInfo.name === 'litch-device')
        .map(([connection]) => connection)
    assert.equal(own().length, 1)
    own()[0]?.drop()
    await until(
      () => own().filter((connection) => connection.open).length === 1,
      '重开了连接',
      4000,
    )
    await until(
      () => env.claude.sent('thread/resume').some((params) => params.threadId === childId),
      '重新订阅在跑的子会话',
    )
    env.claude.end(childId, 'completed', '断线之后做完的')
    await until(() => env.device.sessionTree.store.notes(threadId).length === 1, '照样回报')
  } finally {
    await env.close()
  }
})

test('SESSION-TREE-012：子会话上挂的定时任务跑出来的回合只进回报、不唤醒父会话', async () => {
  const env = treeRig()
  try {
    const { threadId, childId } = await family(env)
    env.claude.end(childId, 'completed', '派出时的那一回合')
    env.pi.end(threadId)
    await until(() => wakesOf(env, threadId).length === 1, '设备发的回合结束了要唤醒')
    await until(() => env.pi.running(threadId), '唤醒回合在跑')
    env.pi.end(threadId)
    const tasks = env.connect()
    await tasks.initialize(['harness', 'deviceTasks'])
    const { task } = await tasks.call('litch/task/create', {
      name: '看一眼子任务',
      prompt: '定时看一眼。',
      schedule: { type: 'interval', minutes: 60 },
      timezone: 'Asia/Shanghai',
      status: 'paused',
      target: { kind: 'thread', harness: 'claude-code', threadId: childId },
    })
    await tasks.call('litch/task/runNow', { id: task.id })
    await until(() => env.claude.running(childId), '任务的回合在子会话里跑')
    env.claude.end(childId, 'completed', '任务跑完了')
    const queued = () =>
      env.device.sessionTree.store.notes(threadId).find((note) => note.excerpt === '任务跑完了')
    await until(() => queued() !== undefined, '任务回合也回报')
    assert.equal(queued()?.wake, false)
    await settle(60)
    assert.equal(wakesOf(env, threadId).length, 1, '任务回合不唤醒')
  } finally {
    await env.close()
  }
})

test('SESSION-TREE-013：目标 harness 收不到父会话那么严：用户回合里说 user_asked 也变成提案，带 widerSandbox；接受后子会话的 litchLineage 带 proposalId', async () => {
  const env = treeRig()
  try {
    // claude-code 这边只声明“完全访问”一档（像没有沙箱的 Pi），父会话（pi）报的是 workspaceWrite
    env.claude.declaration = {
      extensions: ['clientTools'],
      permissionPresets: [{ id: ':danger-full-access' }],
    }
    const client = await litch(env)
    const { threadId } = await parent(client)
    const asked = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'start', {
          title: '没沙箱的',
          prompt: '做点事。',
          harness: 'claude-code',
          initiation: 'user_asked',
        })
      )?.answer,
    )
    assert.ok(asked.proposal_id)
    assert.match(asked.note, /cannot be sandboxed as tightly as this session/)
    assert.equal(env.claude.sent('thread/start').length, 0, '没起任何东西')
    const listed = await client.call('litch/sessionProposal/list', { threadId })
    assert.equal(listed.proposals[0].widerSandbox, 'danger-full-access')
    // 同 harness（pi 没声明预设，当作收得紧）照常直接起，提案上也没有 widerSandbox
    const same = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'start', {
          title: '同一家的',
          prompt: '也做点事。',
          initiation: 'user_asked',
        })
      )?.answer,
    )
    assert.ok(same.thread_id)
    // 用户点了开始：照常起，子会话记着是哪个提案
    const { threadId: childId } = await client.call('litch/sessionProposal/accept', {
      proposalId: asked.proposal_id,
    })
    const born = await startedOn(client, childId)
    assert.equal(born.params.thread.litchLineage.origin, 'proposal')
    assert.equal(born.params.thread.litchLineage.proposalId, asked.proposal_id)
    const read = await client.call('thread/read', { threadId: childId })
    assert.equal(read.thread.litchLineage.proposalId, asked.proposal_id)
    const direct = await client.call('thread/read', { threadId: same.thread_id })
    assert.equal(direct.thread.litchLineage.proposalId, undefined, '不是从提案开始的没有')
  } finally {
    await env.close()
  }
})
