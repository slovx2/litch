import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { planState } from '../src/runtime.mjs'
import { approvalHarness } from './approval-harness.mjs'

// 计划插件交了计划之后问的那一句（就绪菜单），每一项在协议层走到头。
// 真实 Pi SDK、随适配器分发的计划插件，加回环上的假模型。
// 入口问这一句，是对握手时声明了 planConfirmation 的客户端（Litch）；没声明的客户端（官方桌面端）
// 在回合结束后自己问，入口不问，见本文件最后一个用例。

const PLAN = '# Plan\n写 a.txt。'
// 插件的菜单是六项，“Start fresh and implement”要扩展自己开会话，入口不支持，不列出来（ui.mts）
const READY = [
  'Implement here',
  'Export plan…',
  'Save for later',
  'Stay in Plan mode',
  'Discard plan and exit',
]
const FRESH = 'Start fresh and implement'
/** 菜单的题目里讲到“新开会话去实施”的地方（那行说明跟着拿掉了） */
const mentionsFresh = (request: any) => /Start fresh/.test(request.params.questions[0].question)

async function setup(extensions: string[] = ['planConfirmation']) {
  const h = await approvalHarness({ approvals: false })
  const c = await h.connect('desktop', extensions)
  const taken = new Set<unknown>()
  /** 这个会话里下一条还没取过的提问 */
  const next = async (threadId: string): Promise<any> => {
    const found = await c.until(
      '提问',
      (m) =>
        m.method === 'item/tool/requestUserInput' &&
        m.params.threadId === threadId &&
        !taken.has(m.id),
    )
    taken.add(found.id)
    return found
  }
  /** 新开一个会话（各用一个工作目录），在计划模式里交一份计划，带回交了计划之后的那一问 */
  const planned = async (name: string) => {
    const cwd = join(h.cwd, name)
    await mkdir(cwd)
    const threadId = (await c.ok('thread/start', { cwd, model: 'gate/gate' })).thread.id
    h.steps.push({ tools: [{ name: 'plan_mode_complete', args: { plan: PLAN } }] })
    const turnId = await c.start(threadId, '做个计划', { collaborationMode: { mode: 'plan' } })
    return { cwd, threadId, turnId, menu: await next(threadId) }
  }
  /** 答一问：选的项或填的字，什么都不给是不答 */
  const pick = (request: any, ...answers: string[]) =>
    c.answer(request, { answers: { [request.params.questions[0].id]: { answers } } })
  const labels = (request: any): string[] =>
    request.params.questions[0].options?.map((option: any) => option.label) ?? []
  const state = (threadId: string) => planState(h.server.sessions.get(threadId)!.session)
  /** 客户端最后一次收到的这个会话的协作模式 */
  const mode = (threadId: string) =>
    c.notifications('thread/settings/updated').findLast((m) => m.params.threadId === threadId)
      ?.params.threadSettings.collaborationMode.mode
  return { h, c, next, planned, pick, labels, state, mode }
}

test('交了计划之后那一问的每一项都走得到头，不列“新开会话去实施”', async () => {
  const { h, c, next, planned, pick, labels, state, mode } = await setup()
  try {
    // 就地实施：插件退出计划模式，让模型照计划做
    {
      const { threadId, turnId, menu } = await planned('here')
      assert.deepEqual(labels(menu), READY)
      assert.match(menu.params.questions[0].question, /^Proposed plan ready\. What next\?\n/)
      assert.ok(!mentionsFresh(menu), menu.params.questions[0].question)
      const asked = h.requests.length
      await pick(menu, 'Implement here')
      assert.equal((await c.completed(turnId)).status, 'completed')
      assert.match(JSON.stringify(h.requests.slice(asked).at(-1).messages), /Implement the plan\./)
      assert.equal(state(threadId).enabled, false)
      assert.equal(mode(threadId), 'default')
    }
    // 导出：再问一句写到哪（填字，不填是默认的 PLAN.md），写进工作目录，计划模式关掉
    for (const [name, typed, file] of [
      ['export', '', 'PLAN.md'],
      ['exportTo', 'out/plan.md', 'out/plan.md'],
    ] as const) {
      const { cwd, threadId, turnId, menu } = await planned(name)
      await pick(menu, 'Export plan…')
      const where = await next(threadId)
      assert.equal(where.params.questions[0].options, null)
      assert.match(where.params.questions[0].question, /Export plan/)
      await pick(where, typed)
      assert.equal((await c.completed(turnId)).status, 'completed')
      assert.equal(readFileSync(join(cwd, file), 'utf8'), `${PLAN}\n`)
      assert.equal(state(threadId).enabled, false)
      assert.equal(mode(threadId), 'default')
    }
    // 留着以后用：计划存进插件的状态，计划模式关掉
    {
      const { threadId, turnId, menu } = await planned('save')
      await pick(menu, 'Save for later')
      assert.equal((await c.completed(turnId)).status, 'completed')
      assert.equal(state(threadId).savedPlan?.plan, PLAN)
      assert.equal(state(threadId).enabled, false)
      assert.equal(mode(threadId), 'default')
    }
    // 留在计划模式，和不答一样：还在计划模式，计划等着处理
    for (const [name, answers] of [
      ['stay', ['Stay in Plan mode']],
      ['silent', []],
    ] as const) {
      const { threadId, turnId, menu } = await planned(name)
      await pick(menu, ...answers)
      assert.equal((await c.completed(turnId)).status, 'completed')
      assert.deepEqual(
        [state(threadId).enabled, state(threadId).awaitingAction, state(threadId).latestPlan],
        [true, true, PLAN],
      )
      assert.equal(mode(threadId), 'plan')
    }
    // 丢掉计划退出
    {
      const { threadId, turnId, menu } = await planned('discard')
      await pick(menu, 'Discard plan and exit')
      assert.equal((await c.completed(turnId)).status, 'completed')
      assert.equal(state(threadId).enabled, false)
      assert.equal(state(threadId).latestPlan, undefined)
      assert.equal(state(threadId).savedPlan, undefined)
      assert.equal(mode(threadId), 'default')
    }
    // 哪一问都没有卡住：回合都结束了
    assert.equal(c.notifications('turn/started').length, c.notifications('turn/completed').length)
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})

test('/plan 打开的菜单里也不列“新开会话去实施”，就地实施照样能用', async () => {
  const { h, c, next, planned, pick, labels, state } = await setup()
  try {
    const { threadId, turnId, menu } = await planned('slash')
    await pick(menu, 'Stay in Plan mode')
    await c.completed(turnId)
    const opened = await c.start(threadId, '/plan', { collaborationMode: { mode: 'plan' } })
    const again = await next(threadId)
    assert.match(again.params.questions[0].question, /^Plan mode/)
    assert.ok(labels(again).includes('Implement here'), JSON.stringify(labels(again)))
    assert.ok(!labels(again).includes(FRESH))
    assert.ok(!mentionsFresh(again), again.params.questions[0].question)
    const asked = h.requests.length
    await pick(again, 'Implement here')
    assert.equal((await c.completed(opened)).status, 'completed')
    assert.match(JSON.stringify(h.requests.slice(asked).at(-1).messages), /Implement the plan\./)
    assert.equal(state(threadId).enabled, false)
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})

test('存着一份“留着以后用”的计划时插件不让进计划模式：这个回合不跑，不拿默认模式顶替', async () => {
  const { h, c, next, planned, pick, labels, state, mode } = await setup()
  try {
    const { threadId, turnId, menu } = await planned('saved')
    await pick(menu, 'Save for later')
    await c.completed(turnId)
    // 再要计划模式：插件不肯进，此前照默认模式跑了下去，模型能改文件
    const asked = h.requests.length
    const refused = await c.completed(
      await c.start(threadId, '再做个计划', { collaborationMode: { mode: 'plan' } }),
    )
    assert.equal(refused.status, 'failed')
    assert.match(refused.error.message, /A plan is saved for later/)
    assert.deepEqual(refused.items, [])
    assert.equal(h.requests.length, asked, '没进计划模式，模型却被请求了')
    assert.equal(mode(threadId), 'default')
    // 发 /plan 打开存着计划时的菜单（同样不列“新开会话去实施”），清掉它
    const opened = await c.start(threadId, '/plan', { collaborationMode: { mode: 'default' } })
    const saved = await next(threadId)
    assert.match(saved.params.questions[0].question, /^Saved plan/)
    assert.ok(labels(saved).includes('Clear saved plan'), JSON.stringify(labels(saved)))
    assert.ok(!labels(saved).includes(FRESH))
    assert.ok(!mentionsFresh(saved), saved.params.questions[0].question)
    await pick(saved, 'Clear saved plan')
    assert.equal((await c.completed(opened)).status, 'completed')
    assert.equal(state(threadId).savedPlan, undefined)
    // 清掉之后计划模式照常
    h.steps.push({ tools: [{ name: 'plan_mode_complete', args: { plan: PLAN } }] })
    const again = await c.start(threadId, '再做个计划', { collaborationMode: { mode: 'plan' } })
    await pick(await next(threadId), 'Stay in Plan mode')
    assert.equal((await c.completed(again)).status, 'completed')
    assert.equal(state(threadId).enabled, true)
    assert.equal(mode(threadId), 'plan')
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})

test('没声明 planConfirmation 的客户端（官方桌面端）：交了计划不弹那一问，回合正常结束；选执行发来的回合交给插件实施', async () => {
  const { h, c, state, mode } = await setup([])
  try {
    const cwd = join(h.cwd, 'desktop')
    await mkdir(cwd)
    const threadId = (await c.ok('thread/start', { cwd, model: 'gate/gate' })).thread.id
    const asked = () =>
      c.messages.filter(
        (m) => m.method === 'item/tool/requestUserInput' && m.params.threadId === threadId,
      )
    h.steps.push({ tools: [{ name: 'plan_mode_complete', args: { plan: PLAN } }] })
    const planned = await c.start(threadId, '做个计划', { collaborationMode: { mode: 'plan' } })
    const done = await c.completed(planned)
    // 回合带着计划正常结束，入口没问：桌面端只在 completed 的回合里找计划条目来问
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.deepEqual(asked(), [])
    const plan = c.messages
      .filter(
        (m) =>
          m.method === 'item/completed' &&
          m.params.turnId === planned &&
          m.params.item.type === 'plan',
      )
      .at(-1)?.params.item.text
    assert.equal(plan, PLAN)
    // 和用户把那一问关掉一样：计划留着，计划模式没退出
    assert.deepEqual(
      [state(threadId).enabled, state(threadId).awaitingAction, state(threadId).latestPlan],
      [true, true, PLAN],
    )
    assert.notEqual(mode(threadId), 'default')

    // 选执行：协作模式切回 default，话是固定的一行加计划全文（桌面端的做法），入口交给插件去实施
    const before = h.requests.length
    const implementing = await c.start(threadId, `PLEASE IMPLEMENT THIS PLAN:\n${plan}`, {
      collaborationMode: { mode: 'default' },
    })
    assert.equal((await c.completed(implementing)).status, 'completed')
    assert.match(JSON.stringify(h.requests.slice(before).at(-1).messages), /Implement the plan\./)
    assert.equal(state(threadId).enabled, false)
    assert.equal(mode(threadId), 'default')
    assert.deepEqual(asked(), [])

    // 用户自己发 /plan 打开的菜单照常问：那是用户要的。官方桌面端发来的字结尾带一个换行
    const opened = await c.start(threadId, '/plan\n', { collaborationMode: { mode: 'plan' } })
    await c.until('/plan 的菜单', () => asked().length === 1)
    assert.match(asked()[0].params.questions[0].question, /^Plan mode/)
    await c.answer(asked()[0], {
      answers: { [asked()[0].params.questions[0].id]: { answers: [] } },
    })
    assert.equal((await c.completed(opened)).status, 'completed')
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})
