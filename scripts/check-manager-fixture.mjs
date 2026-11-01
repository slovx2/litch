// 经理的脚本验收：真实 CLI → 回环假模型 → 设备 → 看板，全程不用窗口。
// npm run check:manager-fixture（先安装各引擎依赖；命令会构建并跑脚本单测）。需要 Go。
// 单路重复验收：npm run check:manager-fixture -- --harness codex --repeat 8。
// 收尾读取竞态：追加 --poll-ms 1 高频检查，不能把瞬时 interrupted 快照当作真实中断。
// Claude 只用 CHA_CLAUDE_CLI 指定的隔离副本，没给就明确跳过；Codex 用 CHA_CODEX_CLI 或 PATH。
// 子进程显式使用临时 HOME、CODEX_HOME，OPENAI_API_KEY、OPENAI_BASE_URL 等个人凭据不进入环境。
// 流程：manager-open → 经理：add 决策 → answer 记录与修改 → answers/submit → manager-answers → 会话：start → 工作线回报 → end → 只读。
import assert from 'node:assert/strict'
import { accessSync, constants, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { parseArgs } from 'node:util'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../packages/device/dist/protocol/src/manager.mjs'
import {
  MANAGER_ANSWERS_HEARD,
  MANAGER_ENDED,
  MANAGER_HEARD,
  MANAGER_OPENED,
} from './client-fixture-manager.mjs'
import {
  managerClient,
  managerReply,
  startManagerFixture,
  until,
} from './client-fixture-manager-check.mjs'
import { findCodex } from './client-fixture-responses.mjs'
import { SESSIONS_HEARD } from './client-fixture-sessions.mjs'

const text = (value) => [{ type: 'text', text: value, text_elements: [] }]
const { values } = parseArgs({
  options: {
    harness: { type: 'string' },
    repeat: { type: 'string', default: '1' },
    'poll-ms': { type: 'string', default: '100' },
  },
})
const repeat = Number(values.repeat)
const pollMs = Number(values['poll-ms'])
assert.ok(Number.isSafeInteger(repeat) && repeat > 0, '--repeat 必须为正整数')
assert.ok(Number.isSafeInteger(pollMs) && pollMs > 0, '--poll-ms 必须为正整数')
assert.ok(
  !values.harness || ['claude-code', 'codex', 'pi'].includes(values.harness),
  '未知 harness',
)
const replied = (client, threadId, expected, eventKind = null, turnId = null) =>
  managerReply(client, threadId, expected, eventKind, turnId, { pollMs })

async function say(client, threadId, said, expected) {
  const { turn } = await client.call('turn/start', { threadId, input: text(said) })
  return replied(client, threadId, expected, null, turn.id)
}

async function checkManager(t, client, cwd, harness) {
  const { manager, threadId } = await client.call(MANAGER_METHOD.create, {
    cwd,
    harness,
    model: null,
    effort: null,
    name: `${harness} 夹具经理`,
    scope: '验证经理工具、决策答复与工作线回报',
    template: 'blank',
    dispatch: { ...MANAGER_DEFAULT_DISPATCH, worktree: false },
    contact: { ...MANAGER_DEFAULT_CONTACT, desktopNotification: false },
    rules: '只在隔离目录里验收，模型全部使用回环夹具。',
    firstTask: '',
  })
  const params = { managerId: manager.id }
  const board = async () => (await client.call(MANAGER_METHOD.boardRead, params)).board
  // 和打开经理页一样订阅会话，真实中断由 turn/completed 通知确认；早于订阅的开场仍读快照。
  await client.call('thread/resume', { threadId })
  await replied(client, threadId, MANAGER_OPENED, 'manager-open')
  t.diagnostic(`${harness}：收到 manager-open，未调工具`)
  const decision = {
    title: '是否开始验收工作线？',
    background: '隔离夹具需要一条线完成回报，等待看板答复后开线。',
    options: [{ id: 'go', label: '开始', description: '在当前隔离目录里完成验收。' }],
    recommend: 'go',
  }
  const heard = await say(
    client,
    threadId,
    `经理：add ${JSON.stringify({ kind: 'decision', decision })}`,
    MANAGER_HEARD,
  )
  const added = JSON.parse(heard.slice(MANAGER_HEARD.length).trim())
  let saved = (await board()).decisions.find((entry) => entry.id === added.id)
  assert.ok(saved, '工具返回的决策应出现在看板上')
  assert.equal(saved.title, decision.title)
  assert.equal(saved.status, 'open')
  // 工具说明变更不能只靠脚本识别测试；经真实 CLI 调用 answer 并核对设备写入。
  for (const answerText of ['对话中确认开始', '对话中补充：先核对夹具']) {
    const result = await say(
      client,
      threadId,
      `经理：answer ${JSON.stringify({ id: saved.id, optionId: 'go', text: answerText })}`,
      MANAGER_HEARD,
    )
    const recorded = JSON.parse(result.slice(MANAGER_HEARD.length).trim()).object
    const current = (await board()).decisions.find((entry) => entry.id === saved.id)
    assert.equal(recorded.id, saved.id)
    assert.equal(recorded.status, 'answered')
    assert.equal(recorded.answer.text, answerText)
    assert.equal(recorded.answer.by, 'user-conversation')
    assert.equal(recorded.revision, saved.revision + 1)
    assert.deepEqual(current, recorded)
    saved = current
  }
  t.diagnostic(`${harness}：answer 工具完成记录与修改，结果与看板一致`)
  const submitted = await client.call(MANAGER_METHOD.feedbackSubmit, {
    ...params,
    questions: [{ decisionId: saved.id, revision: saved.revision, question: '请核对实现范围' }],
    answers: [
      { decisionId: saved.id, revision: saved.revision, optionId: 'go', text: '按此方案执行' },
    ],
  })
  assert.deepEqual(submitted.rejected, [])
  assert.deepEqual(
    submitted.accepted.map((entry) => entry.id),
    [saved.id],
  )
  assert.equal(submitted.delivery, 'queued')
  await replied(client, threadId, `${MANAGER_ANSWERS_HEARD}${saved.id}`, 'manager-answers')
  assert.equal((await board()).decisions[0].answer.text, '按此方案执行')
  t.diagnostic(`${harness}：决策入看板，答复入库并收到 manager-answers`)
  const current = (await board()).decisions.find((entry) => entry.id === saved.id)
  const reply = await say(
    client,
    threadId,
    `经理：reply ${JSON.stringify({ id: saved.id, revision: current.revision, text: '已核对，范围是隔离夹具' })}`,
    MANAGER_HEARD,
  )
  assert.equal(
    JSON.parse(reply.slice(MANAGER_HEARD.length).trim()).object.discussion.messages.at(-1).answer,
    '已核对，范围是隔离夹具',
  )
  assert.equal(
    (await board()).decisions.find((entry) => entry.id === saved.id).discussion.messages.at(-1)
      .status,
    'completed',
  )
  t.diagnostic(`${harness}：混合提交后 reply 写回追问记录`)

  const temporaryAdded = await say(
    client,
    threadId,
    `经理：add ${JSON.stringify({ kind: 'decision', decision: { title: '待追问修正', background: '旧背景' } })}`,
    MANAGER_HEARD,
  )
  const temporaryId = JSON.parse(temporaryAdded.slice(MANAGER_HEARD.length).trim()).id
  for (const [operation, args] of [
    [
      'update',
      {
        kind: 'decision',
        id: temporaryId,
        patch: { background: '临时对话核实的新背景' },
        why: '已核对',
      },
    ],
    [
      'close',
      { kind: 'decision', id: temporaryId, status: 'withdrawn', reason: '追问后不再需要决定' },
    ],
  ]) {
    const before = (await board()).decisions.find((entry) => entry.id === temporaryId)
    await client.call(MANAGER_METHOD.questionAsk, {
      ...params,
      decisionId: temporaryId,
      revision: before.revision,
      question: `经理：${operation} ${JSON.stringify(args)}`,
    })
    const updated = await until(
      `${harness} 临时对话 ${operation}`,
      board,
      (value) =>
        value.decisions.find((entry) => entry.id === temporaryId)?.discussion?.messages.at(-1)
          ?.status !== 'running',
    )
    const after = updated.decisions.find((entry) => entry.id === temporaryId)
    assert.equal(
      after.discussion.messages.at(-1).status,
      'completed',
      JSON.stringify(after.discussion),
    )
    assert.equal(after.revision, before.revision + 1, JSON.stringify(after.discussion))
    assert.ok(
      updated.changes.some((change) => change.objectId === temporaryId && change.by === 'question'),
    )
    if (operation === 'update') assert.equal(after.background, '临时对话核实的新背景')
    else assert.equal(after.status, 'withdrawn')
  }
  t.diagnostic(`${harness}：临时对话 update/close 仅修改目标决策，历史记录来源`)

  const invoke = async (tool, args) =>
    JSON.parse(
      (await say(client, threadId, `经理：${tool} ${JSON.stringify(args)}`, MANAGER_HEARD))
        .slice(MANAGER_HEARD.length)
        .trim(),
    )
  const published = (
    await invoke('report', {
      title: '阶段报告',
      body: '## 已验收\n- 工具注册',
      why: '阶段汇报',
      source: [{ kind: 'issue', target: saved.id }],
    })
  ).post
  assert.equal(published.unread, true)
  await client.call(MANAGER_METHOD.read, {
    ...params,
    id: published.id,
    revision: published.revision,
  })
  await client.call(MANAGER_METHOD.question, {
    ...params,
    id: published.id,
    revision: published.revision,
    question: '报告还缺哪些内容？',
    mode: 'manager',
  })
  const questionTurn = await until(
    `${harness} 通用追问实际进入经理回合`,
    () => client.call('thread/read', { threadId, includeTurns: true }),
    ({ thread }) =>
      thread.turns.some((turn) =>
        turn.items.some(
          (item) =>
            item.type === 'userMessage' &&
            JSON.stringify(item.content).includes('报告还缺哪些内容'),
        ),
      ),
  )
  const receivedTurn = questionTurn.thread.turns.find((turn) =>
    turn.items.some(
      (item) =>
        item.type === 'userMessage' && JSON.stringify(item.content).includes('报告还缺哪些内容'),
    ),
  )
  await replied(client, threadId, MANAGER_ANSWERS_HEARD, 'manager-answers', receivedTurn.id)
  const rewritten = (
    await invoke('post_reply', {
      id: published.id,
      revision: 1,
      patch: { body: '## 已验收\n- 通用议题' },
      text: '已补范围',
      why: '澄清',
    })
  ).post
  assert.equal(rewritten.unread, true)
  assert.equal(rewritten.discussion.messages.at(-1).answer, '已补范围')
  assert.equal(
    (await invoke('post_get', { id: published.id })).post.versions[0].body,
    published.body,
  )
  await invoke('relate', {
    id: published.id,
    related: [{ kind: 'file', target: 'README.md' }],
    why: '补充依据',
  })
  assert.ok(
    (await board()).relations.some(
      (r) => r.from.target === published.id && r.to.target === 'README.md',
    ),
  )
  await client.call(MANAGER_METHOD.question, {
    ...params,
    id: published.id,
    revision: 2,
    mode: 'temporary',
    question: `经理：post_reply ${JSON.stringify({ id: published.id, revision: 2, patch: { body: '临时对话核对后的范围' }, why: '追问核对' })}`,
  })
  const revised = await until(
    `${harness} 临时更新报告`,
    board,
    (value) =>
      value.posts.find((p) => p.id === published.id)?.discussion.messages.at(-1)?.status !==
      'running',
  )
  const reportPost = revised.posts.find((p) => p.id === published.id)
  assert.equal(reportPost.body, '临时对话核对后的范围', JSON.stringify(reportPost.discussion))
  assert.equal(reportPost.revision, 3)
  assert.ok(revised.changes.some((c) => c.objectId === published.id && c.by === 'question'))
  t.diagnostic(`${harness}：报告发布/已阅/经理回复/临时原帖更新与关系工具通过`)

  const requestAdded = await say(
    client,
    threadId,
    `经理：add ${JSON.stringify({ kind: 'request', revision: 0, why: '需要真机验证', request: { title: '请复验界面', description: '**核对**实际窗口' } })}`,
    MANAGER_HEARD,
  )
  const requestId = JSON.parse(requestAdded.slice(MANAGER_HEARD.length).trim()).id
  const requestUpdated = await say(
    client,
    threadId,
    `经理：update ${JSON.stringify({ kind: 'request', id: requestId, revision: 1, patch: { buttonLabel: '已复验' }, why: '明确交付文案' })}`,
    MANAGER_HEARD,
  )
  assert.equal(
    JSON.parse(requestUpdated.slice(MANAGER_HEARD.length).trim()).object.buttonLabel,
    '已复验',
  )
  for (const [revision, delivered, response] of [
    [2, false, '暂时无法复验'],
    [3, true, '已完成核对'],
  ]) {
    const feedback = await client.call(MANAGER_METHOD.feedbackSubmit, {
      ...params,
      answers: [],
      questions: [],
      requests: [{ requestId, revision, delivered, text: response }],
    })
    assert.equal(feedback.acceptedRequests[0].status, delivered ? 'delivered' : 'replied')
    await replied(client, threadId, MANAGER_ANSWERS_HEARD, 'manager-answers')
    await until(
      `${harness} 收到用户请求回应`,
      () => client.call('thread/read', { threadId, includeTurns: true }),
      ({ thread }) =>
        thread.turns.some(
          (turn) =>
            turn.status === 'completed' &&
            turn.items.some(
              (item) =>
                item.type === 'userMessage' && JSON.stringify(item.content).includes(response),
            ),
        ),
    )
  }
  await say(
    client,
    threadId,
    `经理：close ${JSON.stringify({ kind: 'request', id: requestId, revision: 4, status: 'cancelled', reason: '无需进一步复验' })}`,
    MANAGER_HEARD,
  )
  assert.equal((await board()).requests.find((entry) => entry.id === requestId).status, 'cancelled')
  t.diagnostic(`${harness}：请你做新建/更新/文字回复/交付/取消及事件均通过`)

  const ownProposal = await say(
    client,
    threadId,
    `会话：start ${JSON.stringify({ title: '经理建议检查', background: '这是经理自己的建议，只有用户点击才开始，工作仅在隔离环境内进行。检查样例的字段和边界，完成后汇报，不修改真实项目、不访问个人配置、不执行外部发布。', prompt: '检查样例字段', initiation: 'propose', worktree: false })}`,
    SESSIONS_HEARD,
  )
  const ownProposalId = JSON.parse(ownProposal.slice(SESSIONS_HEARD.length).trim()).proposal_id
  const ownRow = (await client.call('litch/suggestions/list', {})).suggestions.find(
    (entry) => entry.proposal.id === ownProposalId,
  )
  assert.equal(ownRow.managerReview.state, 'endorsed')
  assert.equal((await board()).lines.length, 0, '经理建议在用户点击前不启动工作线')
  t.diagnostic(`${harness}：经理可创建提案卡，默认已审核且不自动开线`)

  const reportMark = '经理夹具工作线回报'
  const prompt = `${reportMark}：这是回环假模型的隔离验收，所有工作只在当前临时目录内完成。请核对任务背景、汇报完成情况和检查结果，不改任何真实项目文件，不访问个人配置，不执行外部发布。\n没验：真实窗口由集成验收执行。`
  const start = await say(
    client,
    threadId,
    `会话：start ${JSON.stringify({
      title: '夹具工作线',
      prompt,
      background:
        '这是经理功能的隔离验收。经理已通过看板询问是否开始，用户已选择开始；本条工作线验证回报能自动进入经理看板，不修改真实项目、不访问个人配置、不发布任何内容。',
      initiation: 'user_asked',
      kind: 'fresh',
    })}`,
    SESSIONS_HEARD,
  )
  assert.doesNotMatch(start, /\[litch:/, `开线工具失败：${start}`)
  const reported = await until(
    `${harness} 工作线回报写入看板`,
    board,
    (value) =>
      value.lines.length === 1 &&
      !value.lines[0].running &&
      value.lines[0].report?.text.includes(reportMark),
  )
  const line = reported.lines[0]
  assert.equal(line.harness, harness, '未指定 harness 时继承经理的派活默认值')
  assert.equal(line.parentThreadId, threadId)
  assert.ok(line.unverified.includes('没验：真实窗口由集成验收执行。'))
  const read = await client.call('thread/read', { threadId: line.threadId })
  assert.deepEqual(read.thread.litchManager, { managerId: manager.id, role: 'line' })
  t.diagnostic(`${harness}：开线完成，工作线页数据含回报及“没验”项`)
  // 实际工作线出卡，经理审核；用户默认列表才计入它。
  const proposalBrief = {
    title: '值得用户开始的后续检查',
    background:
      '这是经理夹具中的后续检查建议。任务只在隔离临时目录执行，不修改真实项目，不访问用户配置，不发布任何内容。完成时核对隔离数据并给出简短结果。',
    prompt: '检查隔离样例并报告',
    initiation: 'propose',
    worktree: false,
  }
  const proposed = await say(
    client,
    line.threadId,
    `会话：start ${JSON.stringify(proposalBrief)}`,
    SESSIONS_HEARD,
  )
  const proposalId = JSON.parse(proposed.slice(SESSIONS_HEARD.length).trim()).proposal_id
  const suggestion = async () =>
    (await client.call('litch/suggestions/list', {})).suggestions.find(
      (entry) => entry.proposal.id === proposalId,
    )
  assert.equal((await suggestion()).managerReview.state, 'pending')
  // 工作线出卡会触发经理回报；等这轮处理停稳再发审核指令。
  await until(
    `${harness} 经理处理线卡通知`,
    () => client.call('thread/read', { threadId, includeTurns: true }),
    ({ thread }) =>
      thread.status.type !== 'active' && !thread.turns.some((turn) => turn.status === 'inProgress'),
  )
  await say(
    client,
    threadId,
    `经理：endorse ${JSON.stringify({ proposalId, reason: '值得用户发起' })}`,
    MANAGER_HEARD,
  )
  assert.equal((await suggestion()).managerReview.state, 'endorsed')
  t.diagnostic(`${harness}：工作线提案经 endorse 进入默认展示`)

  const ended = await client.call(MANAGER_METHOD.end, params)
  assert.equal(ended.manager.status, 'ending')
  assert.equal(ended.manager.endedAt, null)
  // 收尾回合可以写总结；客户端在 ending 期间不能改设置或提交看板答复。
  await assert.rejects(
    client.call(MANAGER_METHOD.update, { ...params, name: '结束中不能改' }),
    (error) => error.data?.litch === 'managerEnded' && /is ending/.test(error.message),
  )
  await assert.rejects(
    client.call(MANAGER_METHOD.answersSubmit, {
      ...params,
      answers: [
        { decisionId: saved.id, revision: saved.revision, optionId: 'go', text: '结束中不能写' },
      ],
    }),
    (error) => error.data?.litch === 'managerEnded' && /is ending/.test(error.message),
  )
  await replied(client, threadId, MANAGER_ENDED, 'manager-end')
  await until(
    `${harness} 收尾完成后进入 ended`,
    () => client.call(MANAGER_METHOD.list),
    ({ managers }) => managers.find((entry) => entry.id === manager.id)?.status === 'ended',
  )
  await assert.rejects(
    client.call(MANAGER_METHOD.update, { ...params, name: '不应写入' }),
    (error) => error.data?.litch === 'managerEnded',
  )
  await assert.rejects(
    client.call(MANAGER_METHOD.answersSubmit, {
      ...params,
      answers: [
        { decisionId: saved.id, revision: saved.revision, optionId: 'go', text: '不应写入' },
      ],
    }),
    (error) => error.data?.litch === 'managerEnded',
  )
  assert.equal((await board()).decisions[0].answer.text, '按此方案执行')
  assert.equal(
    (await client.call(MANAGER_METHOD.list)).managers.find((entry) => entry.id === manager.id)
      .status,
    'ended',
  )
  t.diagnostic(`${harness}：manager-end 不调工具，经理已结束且看板只读`)
}

test('经理真实 CLI 的隔离脚本验收', { timeout: 600_000 }, async (t) => {
  const claude =
    !values.harness || values.harness === 'claude-code' ? process.env.CHA_CLAUDE_CLI?.trim() : null
  const codex = !values.harness || values.harness === 'codex' ? findCodex() : null
  if (values.harness === 'claude-code') assert.ok(claude, 'Claude 单路验收必须提供 CHA_CLAUDE_CLI')
  assert.ok(
    codex || (values.harness && values.harness !== 'codex'),
    '未找到 Codex：请设置 CHA_CODEX_CLI 或把 codex 放入 PATH；本检查必须覆盖原生 Codex',
  )
  if (claude) accessSync(claude, constants.X_OK)
  const engines = {
    ...(claude ? { CHA_CLAUDE_CLI: claude } : {}),
    ...(codex ? { CHA_CODEX_CLI: codex } : {}),
  }
  // Pi 始终随夹具启动，也走完整链路；只有 Claude 未给隔离副本时允许跳过。
  const info = await startManagerFixture(t, engines)
  const client = await managerClient(t, info.socket)
  const runtime = await client.call('runtime/info')
  assert.ok(runtime.device.extensions.includes('litchManager'))
  if (codex) {
    const settings = JSON.parse(
      readFileSync(join(info.root, 'h/device/settings.json'), 'utf8'),
    ).values
    const vars = settings['harness.codex.env']
    assert.equal(vars.find((entry) => entry.name === 'CODEX_HOME')?.value, join(info.root, 'cx'))
    assert.ok(!vars.some((entry) => ['OPENAI_API_KEY', 'OPENAI_BASE_URL'].includes(entry.name)))
  }
  for (const [harness, available, reason] of [
    ['claude-code', claude, '没验：未给 CHA_CLAUDE_CLI 隔离副本，跳过 Claude'],
    ['codex', true, ''],
    ['pi', true, ''],
  ]) {
    if (values.harness && values.harness !== harness) continue
    for (let iteration = 1; iteration <= repeat; iteration++) {
      await t.test(
        `${harness} ${iteration}/${repeat}`,
        { skip: available ? false : reason },
        async (t) => {
          assert.equal(runtime.harnesses.find((entry) => entry.id === harness)?.available, true)
          try {
            await checkManager(t, client, info.engines.cwd, harness)
          } catch (error) {
            // Claude 的工具可能在 CLI 处理 MCP 定义时消失；失败时保留实际请求里的名单，收场仍删除原始请求。
            const requests = existsSync(info.modelDump)
              ? readdirSync(info.modelDump)
                  .filter((file) => file.endsWith(`-${harness}.json`))
                  .sort()
              : []
            if (requests.length) {
              const { request } = JSON.parse(
                readFileSync(join(info.modelDump, requests.at(-1)), 'utf8'),
              )
              const tools = (request.tools ?? []).flatMap(
                (tool) => tool.description?.match(/\[litch_manager\.\w+\]/g) ?? [],
              )
              t.diagnostic(`模型实际收到的经理工具：${tools.join('、') || '无'}`)
            }
            throw error
          }
        },
      )
    }
  }
})
