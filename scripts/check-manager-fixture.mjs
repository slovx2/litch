// 经理的脚本验收：真实 CLI → 回环假模型 → 设备 → 看板，全程不用窗口。
// npm run check:manager-fixture（先安装各引擎依赖；命令会构建并跑脚本单测）。需要 Go。
// Claude 只用 CHA_CLAUDE_CLI 指定的隔离副本，没给就明确跳过；Codex 用 CHA_CODEX_CLI 或 PATH。
// 子进程显式使用临时 HOME、CODEX_HOME，OPENAI_API_KEY、OPENAI_BASE_URL 等个人凭据不进入环境。
// 流程：manager-open → 经理：add 决策 → answers/submit → manager-answers → 会话：start → 工作线回报 → end → 只读。
import assert from 'node:assert/strict'
import { accessSync, constants, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
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
import { managerClient, startManagerFixture, until } from './client-fixture-manager-check.mjs'
import { findCodex } from './client-fixture-responses.mjs'
import { SESSIONS_HEARD } from './client-fixture-sessions.mjs'

const text = (value) => [{ type: 'text', text: value, text_elements: [] }]
const itemText = (item) =>
  item.type === 'agentMessage'
    ? item.text
    : (item.content ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')

/** 直接读设备保存的完整回合，覆盖创建早于客户端订阅的开场事件，不依赖通知时序。 */
async function replied(client, threadId, expected, eventKind = null, turnId = null) {
  const target = (turn) =>
    turnId
      ? turn.id === turnId
      : turn.items.some(
          (item) => item.type === 'userMessage' && itemText(item).includes(`kind="${eventKind}"`),
        )
  const result = await until(
    `会话 ${threadId} 回复 ${expected}`,
    () => client.call('thread/read', { threadId, includeTurns: true }),
    ({ thread }) => thread.turns?.some((turn) => target(turn) && turn.status !== 'inProgress'),
  )
  const turn = result.thread.turns.find(target)
  assert.equal(turn.status, 'completed', JSON.stringify(turn))
  const answer = turn.items.find(
    (item) => item.type === 'agentMessage' && itemText(item).startsWith(expected),
  )
  assert.ok(answer, `没有收到 ${expected}；回合内容：${JSON.stringify(turn.items)}`)
  if (eventKind) {
    assert.ok(
      !turn.items.some((item) => /toolcall|commandexecution/i.test(item.type)),
      `${eventKind} 不应调用工具`,
    )
  }
  return answer.text
}

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
  const saved = (await board()).decisions.find((entry) => entry.id === added.id)
  assert.ok(saved, '工具返回的决策应出现在看板上')
  assert.equal(saved.title, decision.title)
  assert.equal(saved.status, 'open')
  const submitted = await client.call(MANAGER_METHOD.answersSubmit, {
    ...params,
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

  const ended = await client.call(MANAGER_METHOD.end, params)
  assert.equal(ended.manager.status, 'ended')
  await replied(client, threadId, MANAGER_ENDED, 'manager-end')
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
  const claude = process.env.CHA_CLAUDE_CLI?.trim()
  const codex = findCodex()
  assert.ok(
    codex,
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
    await t.test(harness, { skip: available ? false : reason }, async (t) => {
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
    })
  }
})
