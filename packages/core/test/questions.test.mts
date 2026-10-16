// 提问：一次请求里好几道题、带跳过的答案、选项之外自己填。对着假对端和模拟核心跑。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ToolRequestUserInputQuestion } from '../../protocol/src/index.mjs'
import {
  collectAnswers,
  createMockCore,
  type QuestionEntries,
  type QuestionView,
  questionState,
  reduceSession,
  type SessionOp,
  type SessionView,
} from '../src/index.mjs'
import { SAMPLE_TEXT } from '../src/mock/sample-text.mjs'
import { projectQuestion, settleAnswers } from '../src/projection/questions.mjs'
import { thread, turn, userText } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'
import { setup, watch, where } from './world.mjs'

const never = { aborted: false, addEventListener() {} }

const asked = (
  id: string,
  options: string[] | null,
  more: Partial<ToolRequestUserInputQuestion> = {},
): ToolRequestUserInputQuestion => ({
  id,
  header: id,
  question: `${id}？`,
  isOther: false,
  isSecret: false,
  options: options?.map((label) => ({ label, description: '' })) ?? null,
  ...more,
})

const labelsOf = (view: QuestionView) => view.options?.map((option) => option.label) ?? null

test('题目：能不能自己填只看对面给的 isOther；选项原样，叫 Other 的也只是一个选项', () => {
  // 对面说了能填别的：选项一个不少，另有“自己填”的入口
  const open = projectQuestion(asked('q0', ['甲', '乙'], { isOther: true }))
  assert.deepEqual(labelsOf(open), ['甲', '乙'])
  assert.equal(open.allowOther, true)
  // 没说的照原样：不许自己填
  const plain = projectQuestion(asked('q1', ['甲', '乙']))
  assert.deepEqual(labelsOf(plain), ['甲', '乙'])
  assert.equal(plain.allowOther, false)
  // 对面的选项里正好有一个叫 Other 的：它是对面写的一个选项，留在选项里，
  // 不是“自己填”的入口，题目也不因为它就许自己填
  const named = projectQuestion(asked('q2', ['Bug', 'Feature', 'Other']))
  assert.deepEqual(labelsOf(named), ['Bug', 'Feature', 'Other'])
  assert.equal(named.allowOther, false)
  // 又有叫 Other 的选项、又许自己填：两样都在，各是各的
  const both = projectQuestion(asked('q3', ['Bug', 'Other'], { isOther: true }))
  assert.deepEqual(labelsOf(both), ['Bug', 'Other'])
  assert.equal(both.allowOther, true)
  // 没有选项的题只能自己填
  assert.deepEqual(
    [asked('q4', null), asked('q5', [])].map((question) => {
      const view = projectQuestion(question)
      return [view.options, view.allowOther]
    }),
    [
      [null, true],
      [null, true],
    ],
  )
  assert.equal(projectQuestion(asked('q6', null, { isSecret: true })).secret, true)
})

const QUESTIONS: QuestionView[] = [
  projectQuestion(asked('scope', ['用户级', '系统级'])),
  projectQuestion(asked('name', null)),
  projectQuestion(asked('log', ['文件', '日志服务'], { isOther: true })),
]

test('交卷：每道题都得有个说法，答了或者明确跳过；有没答的给出第一道没答的排第几', () => {
  assert.equal(questionState(undefined), 'open')
  assert.equal(questionState({ kind: 'option', label: '甲' }), 'answered')
  assert.equal(questionState({ kind: 'skipped' }), 'skipped')
  // 选了“自己填”还没写出字来，不算答了
  assert.equal(questionState({ kind: 'other', text: '  ' }), 'open')
  assert.equal(questionState({ kind: 'other', text: ' 写了 ' }), 'answered')

  const entries: QuestionEntries = { log: { kind: 'option', label: '文件' } }
  assert.deepEqual(collectAnswers(QUESTIONS, entries), { open: 0 })
  entries.scope = { kind: 'option', label: '系统级' }
  assert.deepEqual(collectAnswers(QUESTIONS, entries), { open: 1 })
  entries.name = { kind: 'other', text: '' }
  assert.deepEqual(collectAnswers(QUESTIONS, entries), { open: 1 })
  entries.name = { kind: 'skipped' }
  assert.deepEqual(collectAnswers(QUESTIONS, entries), {
    answers: { scope: ['系统级'], name: [], log: ['文件'] },
  })
  // 自己填的去掉两头的空白
  entries.log = { kind: 'other', text: '  写到 syslog ' }
  assert.deepEqual(collectAnswers(QUESTIONS, entries), {
    answers: { scope: ['系统级'], name: [], log: ['写到 syslog'] },
  })
})

test('核对答案：缺题、多题、一题多答、空白、不许自己填却答了选项之外的，都不认', () => {
  const good = { scope: ['用户级'], name: [], log: ['自己说的'] }
  assert.deepEqual(settleAnswers(QUESTIONS, good), good)
  assert.deepEqual(settleAnswers(QUESTIONS, { ...good, name: ['  litch '] })?.name, ['litch'])
  // 自己填的字是什么就发什么：填的正好是 Other，也是一个答案，不是“没答”
  assert.deepEqual(settleAnswers(QUESTIONS, { ...good, log: ['Other'] })?.log, ['Other'])
  // 对面的选项就叫 Other：不许自己填的题上也选得上它，选项之外的照样不认
  const named = [projectQuestion(asked('kind', ['Bug', 'Feature', 'Other']))]
  assert.deepEqual(settleAnswers(named, { kind: ['Other'] }), { kind: ['Other'] })
  assert.equal(settleAnswers(named, { kind: ['别的'] }), null)
  const bad: Record<string, unknown>[] = [
    // 跳过也得明说：少一项不行
    { scope: ['用户级'], log: ['文件'] },
    { ...good, extra: ['多出来的'] },
    { ...good, scope: ['用户级', '系统级'] },
    { ...good, name: ['   '] },
    { ...good, name: [7] },
    { ...good, name: '不是数组' },
    // scope 不许自己填
    { ...good, scope: ['别的'] },
  ]
  for (const given of bad)
    assert.equal(settleAnswers(QUESTIONS, given), null, JSON.stringify(given))
  assert.equal(settleAnswers(QUESTIONS, undefined), null)
})

test('提问：一次请求里三道题，跳过的那道回给对面的是空的；缺了哪道题不发', async () => {
  const running = turn('t1', [userText('u', '配服务')], { status: 'inProgress' })
  const { core, peer, command } = setup([thread({ id: 'a', turns: [running] })])
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  const server = peer.last()
  const reply = server.ask('item/tool/requestUserInput', {
    threadId: 'a',
    turnId: 't1',
    itemId: 'ask1',
    questions: [
      asked('q0', ['用户级', '系统级'], { isOther: true }),
      asked('q1', ['文件', '日志服务'], { isOther: true }),
      asked('q2', ['现在', '以后'], { isOther: true }),
    ],
    isBlocking: true,
    autoResolutionMs: null,
  })
  await settle()
  const request = session.seen.view?.requests[0]
  assert.equal(request?.kind, 'question')
  if (request?.kind !== 'question') return
  assert.deepEqual(
    request.questions.map((question) => [
      question.id,
      question.options?.map((option) => option.label),
      question.allowOther,
    ]),
    [
      ['q0', ['用户级', '系统级'], true],
      ['q1', ['文件', '日志服务'], true],
      ['q2', ['现在', '以后'], true],
    ],
  )
  const target = { ...where, requestId: request.id }
  // 少了一道题、多出一道不认识的题：不发，卡片还在
  await assert.rejects(command('session.respond', { ...target, answers: { q0: ['用户级'] } }), {
    code: 'rejected',
  })
  await assert.rejects(
    command('session.respond', {
      ...target,
      answers: { q0: ['用户级'], q1: [], q2: ['现在'], q9: ['谁'] },
    }),
    { code: 'rejected' },
  )
  assert.equal(session.seen.view?.requests.length, 1)
  // 第一题选了选项，第二题跳过，第三题自己填
  await command('session.respond', {
    ...target,
    answers: { q0: ['系统级'], q1: [], q2: ['等发版之后'] },
  })
  assert.deepEqual(((await reply) as { result: unknown }).result, {
    answers: {
      q0: { answers: ['系统级'] },
      q1: { answers: [] },
      q2: { answers: ['等发版之后'] },
    },
  })
  assert.deepEqual(session.seen.view?.requests, [])
})

test('提问：叫 Other 的选项选得上，自己填的字原样回给对面，计划确认里写的话也一样', async () => {
  const running = turn('t1', [userText('u', '分个类')], { status: 'inProgress' })
  const { core, peer, command } = setup([thread({ id: 'a', turns: [running] })])
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  const server = peer.last()
  /** 对面问一次，这边按题作答，返回对面收到的应答 */
  const round = async (
    itemId: string,
    questions: ToolRequestUserInputQuestion[],
    answers: Record<string, string[]>,
  ) => {
    const reply = server.ask('item/tool/requestUserInput', {
      threadId: 'a',
      turnId: 't1',
      itemId,
      questions,
      isBlocking: true,
      autoResolutionMs: null,
    })
    await settle()
    const request = session.seen.view?.requests[0]
    assert.equal(request?.kind, 'question')
    if (request?.kind !== 'question') throw new Error('不是提问')
    const view = request.questions.map((question) => [labelsOf(question), question.allowOther])
    await command('session.respond', { ...where, requestId: request.id, answers })
    assert.deepEqual(session.seen.view?.requests, [])
    return { view, result: ((await reply) as { result: unknown }).result }
  }

  // 对面的选项里自己写了一个 Other；两道题都另外许自己填
  const named = await round(
    'ask1',
    [
      asked('q0', ['Bug', 'Feature', 'Other'], { isOther: true }),
      asked('q1', ['要', '不要'], { isOther: true }),
    ],
    // 第一题选的是对面那个叫 Other 的选项；第二题是自己填的，填的字正好也是 Other
    { q0: ['Other'], q1: ['Other'] },
  )
  assert.deepEqual(named.view, [
    [['Bug', 'Feature', 'Other'], true],
    [['要', '不要'], true],
  ])
  assert.deepEqual(named.result, {
    answers: { q0: { answers: ['Other'] }, q1: { answers: ['Other'] } },
  })

  // 计划确认（Claude Code 引擎在模型要退出计划模式时问的那道题）：在这边就是一道普通的题，
  // 自己写的话原样发回去，算不算确认、怎么交给模型是对面的事
  const plan = await round(
    'ask2',
    [asked('execute_plan', ['执行计划', '继续规划'], { isOther: true })],
    { execute_plan: ['  先把第二步改成只读检查 '] },
  )
  assert.deepEqual(plan.view, [[['执行计划', '继续规划'], true]])
  assert.deepEqual(plan.result, {
    answers: { execute_plan: { answers: ['先把第二步改成只读检查'] } },
  })
})

/** 模拟核心里的一个会话，像界面那样落成一份视图 */
function mockSession(sessionId: string, deviceId = 'local') {
  const time = fakeClock()
  const core = createMockCore({ clock: time.clock, chunkMs: 0 })
  let view: SessionView | null = null
  core.subscribe(
    { kind: 'session', deviceId, sessionId },
    {
      snapshot: (data) => {
        view = structuredClone(data as SessionView)
      },
      delta: (delta) => {
        for (const op of delta as SessionOp[]) if (view) reduceSession(view, structuredClone(op))
      },
      error() {},
    },
  )
  const now = () => view as SessionView | null
  const target = { deviceId, sessionId }
  const question = () => {
    const request = now()?.requests[0]
    assert.equal(request?.kind, 'question')
    if (request?.kind !== 'question') throw new Error('不是提问')
    return request
  }
  /** 最后一个回合里最后一条回话。回话是定时出来的，先让时间走一段 */
  const lastReply = () => {
    time.advance(10)
    const state = now()
    const ids = state?.turns.at(-1)?.itemIds ?? []
    const item = state?.items[ids.at(-1) ?? '']
    return item?.kind === 'agentMessage' ? item.text : ''
  }
  const send = (text: string) => core.command('session.send', { ...target, text }, never)
  const respond = (requestId: string, answers: Record<string, string[]>) =>
    core.command('session.respond', { ...target, requestId, answers }, never)
  return { core, now, target, question, lastReply, send, respond }
}

test('模拟核心：话里带“提问”就问三道（单选、自己写、单选），答完的回话里逐题带着收到的回答', async () => {
  const sample = SAMPLE_TEXT['zh-CN']
  const mock = mockSession('s4')
  await mock.send('先提问再动手')
  const request = mock.question()
  assert.deepEqual(
    request.questions.map((question) => [question.options?.length ?? 0, question.allowOther]),
    [
      [sample.questions[0]?.options?.length, true],
      [0, true],
      [sample.questions[2]?.options?.length, true],
    ],
  )
  const [first, second, third] = request.questions
  if (!first || !second || !third) throw new Error('不是三道题')
  // 少一道题不认
  await assert.rejects(mock.respond(request.id, { [first.id]: ['随便'] }), { code: 'rejected' })
  const picked = third.options?.[1]?.label ?? ''
  await mock.respond(request.id, {
    [first.id]: ['自己说的范围'],
    [second.id]: [],
    [third.id]: [picked],
  })
  assert.deepEqual(mock.now()?.requests, [])
  assert.equal(
    mock.lastReply(),
    [
      sample.answersHeard,
      '',
      `- ${first.question} → 自己说的范围`,
      `- ${second.question} → ${sample.answerSkipped}`,
      `- ${third.question} → ${picked}`,
      '',
      sample.mockReply,
    ].join('\n'),
  )
  // 收到的回答只带一次：下一个回合照常回话
  await mock.send('接着说')
  assert.equal(mock.lastReply(), sample.mockReply)
})

test('模拟核心：话里带“问一句”只问一道单选题，不许自己填', async () => {
  const sample = SAMPLE_TEXT['zh-CN']
  const mock = mockSession('s4')
  await mock.send('问一句再说')
  const request = mock.question()
  assert.equal(request.questions.length, 1)
  const only = request.questions[0]
  if (!only) throw new Error('没有题')
  assert.equal(only.question, sample.singleQuestion.question)
  assert.equal(only.allowOther, false)
  await assert.rejects(mock.respond(request.id, { [only.id]: ['选项之外的'] }), {
    code: 'rejected',
  })
  const label = only.options?.[0]?.label ?? ''
  await mock.respond(request.id, { [only.id]: [label] })
  assert.ok(mock.lastReply().includes(`- ${only.question} → ${label}`))
})

test('模拟核心：示例里那张提问卡片是三道题，后面还排着请求时回答先记着，轮到回话再说', async () => {
  const sample = SAMPLE_TEXT['zh-CN']
  const mock = mockSession('b1', 'build')
  const request = mock.question()
  assert.deepEqual(
    request.questions.map((question) => question.question),
    sample.questions.map((question) => question.question),
  )
  const answers: Record<string, string[]> = {}
  for (const question of request.questions) answers[question.id] = []
  const first = request.questions[0]
  if (!first) throw new Error('没有题')
  answers[first.id] = [first.options?.[0]?.label ?? '']
  await mock.respond(request.id, answers)
  // 后面排着一张表单：回合还停着
  const form = mock.now()?.requests[0]
  assert.equal(form?.kind, 'form')
  if (form?.kind !== 'form') return
  await mock.core.command(
    'session.respond',
    { ...mock.target, requestId: form.id, optionId: 'accept', values: {} },
    never,
  )
  const said = mock.lastReply()
  assert.ok(said.startsWith(sample.answersHeard), said)
  assert.ok(said.includes(`- ${first.question} → ${answers[first.id]?.[0]}`))
  assert.equal(said.split(sample.answerSkipped).length - 1, 2)
})
