// 绑上飞书应用后经理的飞书工具自动生效：Claude 经理空下来原地刷新（不打断在跑的回合），
// 飞书叫醒等刷新完再投；要换会话的引擎（Pi 等）不自动换，投递里照旧提示请用户重置。
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { FEISHU_TOOLS_NAMESPACE } from '../../protocol/src/client-tools-feishu.mjs'
import { FEISHU_METHOD as M } from '../../protocol/src/feishu.mjs'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import {
  DEFAULT_MANAGER_IDLE_COMPACT,
  IDLE_COMPACT_READ,
  type IdleCompactSnapshot,
} from '../../protocol/src/manager-idle-compact.mjs'
import { FakeEngine } from './fake-engine.mjs'
import { FeishuFakeHarness } from './feishu-harness.mjs'
import { until } from './tree-kit.mjs'

const APP = 'cli_0123456789abcdef'
const TEAM = 'oc_team'
const ALICE = 'ou_alice'
const HINT = /litch_feishu tools are not installed/

async function setup(t: TestContext, harness: 'claude-code' | 'pi') {
  let clock = Math.floor(Date.now() / 1000)
  const engine = new FakeEngine(harness)
  const h = await FeishuFakeHarness.start(t, {
    upstreams: { [harness]: engine },
    now: () => clock,
    managerIdleCompactClock: () => clock * 1000,
    wakeTickMs: 10,
  })
  const app = h.fake.addApp({ appId: APP })
  h.fake.addChat({
    chatId: TEAM,
    name: '示例项目群',
    bots: new Set([APP]),
    members: [{ openId: ALICE, name: '示例成员甲' }],
  })
  await h.configure(APP)
  await h.until(async () => (await h.admin.call(M.chatList, { appId: APP })).chats.length === 1)
  const client = h.env.connect()
  await client.initialize(['harness', 'litchManager'])
  t.after(() => client.close())
  const { manager, threadId } = await client.call(MANAGER_METHOD.create, {
    cwd: h.env.stateDir,
    harness,
    model: null,
    effort: null,
    name: '经理',
    scope: '测试',
    template: 'blank',
    dispatch: { ...MANAGER_DEFAULT_DISPATCH, worktree: false },
    contact: { ...MANAGER_DEFAULT_CONTACT },
    rules: '',
    firstTask: '',
  })
  await until(() => engine.running(threadId), '经理第一个回合')
  const managers = h.env.device.managers
  const feishuInstalled = () =>
    (h.env.device.sessionTree.store.tools(threadId) ?? []).some(
      (spec: any) => spec?.name === FEISHU_TOOLS_NAMESPACE,
    )
  const bind = async () => {
    const current = (await h.admin.call(M.appGet, { appId: APP })).app
    await h.admin.call(M.appUpdate, {
      appId: APP,
      expectedRevision: current.revision,
      managerId: manager.id,
    })
    const chat = (await h.admin.call(M.chatGet, { appId: APP, chatId: TEAM })).chat
    if (!chat.access)
      await h.admin.call(M.chatAccess, {
        appId: APP,
        chatId: TEAM,
        expectedRevision: chat.revision,
        speech: 'free',
        wakeBound: true,
        wakers: [ALICE],
        retentionDays: 90,
        reviewTtlHours: 24,
      })
  }
  const ask = async (text: string) => {
    const message = h.fake.postMessage({
      chatId: TEAM,
      sender: ALICE,
      text: `@_user_1 ${text}`,
      mentions: [{ openId: app.botOpenId, name: '测试机器人' }],
    })
    await h.fake.push(APP, 'im.message.receive_v1', h.fake.receiveEvent(message))
  }
  const turnStarts = () =>
    engine.sent('turn/start').filter((params) => params.threadId === threadId)
  const phase = () => managers.manager(manager.id).reset?.phase
  return {
    h,
    engine,
    manager,
    threadId,
    managers,
    feishuInstalled,
    bind,
    ask,
    turnStarts,
    phase,
    now: () => clock * 1000,
    advance: (seconds: number) => {
      clock += seconds
    },
  }
}

test('Claude 经理绑上应用：等在跑的回合结束后原地刷新装上飞书工具，叫醒等刷新完再投', async (t) => {
  const s = await setup(t, 'claude-code')
  assert.equal(s.feishuInstalled(), false)
  const resumesBefore = s.engine.sent('thread/resume').length
  await s.bind()
  assert.equal(s.phase(), 'waiting', '绑定后自动排入刷新')
  assert.equal(s.managers.manager(s.manager.id).reset?.mode, 'refresh')
  // 在跑的回合不被打断：回合结束前不换工具
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(s.engine.running(s.threadId), true)
  assert.equal(s.engine.sent('thread/resume').length, resumesBefore)
  assert.equal(s.feishuInstalled(), false)

  // 回合还在跑时有人 @：留队
  const before = s.turnStarts().length
  await s.ask('看一下')
  s.advance(30)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(s.turnStarts().length, before)

  s.engine.end(s.threadId, 'completed', '好')
  await until(() => s.phase() === 'ready', '刷新完成', 5000)
  assert.equal(s.feishuInstalled(), true)
  assert.equal(s.managers.manager(s.manager.id).reset?.outdated, false)
  assert.equal(s.managers.manager(s.manager.id).threadId, s.threadId, '原地刷新不换会话')
  const engineTools = s.engine.thread(s.threadId).dynamicTools as unknown[] | undefined
  assert.ok(engineTools?.some((spec: any) => spec?.name === FEISHU_TOOLS_NAMESPACE))
  await until(() => s.turnStarts().length === before + 1, '刷新后投递')
  assert.doesNotMatch(String(s.turnStarts().at(-1)?.input?.[0]?.text ?? ''), HINT)
})

test('只绑定飞书应用的经理：飞书回合忙时不压缩，闲置超阈值后默认压缩', async (t) => {
  const s = await setup(t, 'claude-code')
  const { device } = s.h.env
  const { sessionTree: tree } = device
  assert.equal(device.external, null)
  assert.deepEqual(s.managers.manager(s.manager.id).idleCompact, DEFAULT_MANAGER_IDLE_COMPACT)
  await s.bind()
  const first = s.engine.end(s.threadId)
  await until(() => s.phase() === 'ready', '飞书工具刷新完成')
  const sample: IdleCompactSnapshot = {
    idle: true,
    lastTurnId: first.id,
    lastTurnActivityAt: s.now(),
    usageTurnId: first.id,
    usedTokens: 80_000,
    windowTokens: 100_000,
  }
  s.engine.handlers[IDLE_COMPACT_READ] = () => ({
    ...sample,
    idle: !s.engine.running(s.threadId),
  })
  let compactTurnId: string | undefined
  s.engine.handlers['thread/compact/start'] = (params) => {
    assert.deepEqual(params.litchIdleCompact, sample)
    compactTurnId = s.engine.selfTurn(s.threadId).id
    return { turnId: compactTurnId }
  }
  await s.ask('处理飞书通知')
  s.advance(30)
  await until(() => s.engine.running(s.threadId), '飞书回合启动')
  s.advance(51 * 60)
  s.managers.idleCompact.tick(s.manager.id)
  await tree.settleIdleCompacts()
  assert.equal(compactTurnId, undefined, '忙时不压缩')
  const ended = s.engine.end(s.threadId)
  await until(() => !tree.isActive(s.threadId), '飞书回合结束')
  sample.lastTurnId = ended.id
  sample.lastTurnActivityAt = s.now()
  s.advance(51 * 60)
  s.managers.idleCompact.tick()
  await until(() => compactTurnId !== undefined, '全设备定时扫描启动压缩')
  sample.usedTokens = 25_000
  sample.usageTurnId = s.engine.end(s.threadId).id
  await tree.settleIdleCompacts()
  assert.equal(s.managers.manager(s.manager.id).idleCompactLast?.after, 25)
})

test('Claude 经理的自动刷新被用户输入取消：下次飞书叫醒前再排一次，装好再投', async (t) => {
  const s = await setup(t, 'claude-code')
  await s.bind()
  assert.equal(s.phase(), 'waiting')
  s.managers.resets.cancel(s.manager.id)
  assert.equal(s.phase(), 'idle')
  s.engine.end(s.threadId, 'completed', '好')
  await until(() => !s.h.env.device.sessionTree.isActive(s.threadId), '空闲')
  assert.equal(s.feishuInstalled(), false)

  const before = s.turnStarts().length
  await s.ask('在吗')
  s.advance(30)
  await until(() => s.phase() === 'ready', '叫醒前自动刷新', 5000)
  assert.equal(s.feishuInstalled(), true)
  await until(() => s.turnStarts().length === before + 1, '刷新后投递')
  assert.doesNotMatch(String(s.turnStarts().at(-1)?.input?.[0]?.text ?? ''), HINT)
})

test('Pi 经理绑上应用：不自动换会话，投递里提示请用户重置', async (t) => {
  const s = await setup(t, 'pi')
  await s.bind()
  assert.equal(s.phase() ?? 'idle', 'idle', '要换会话的重置不自动做')
  assert.equal(s.managers.manager(s.manager.id).reset?.outdated, true)
  s.engine.end(s.threadId, 'completed', '好')
  const before = s.turnStarts().length
  await s.ask('看一下')
  s.advance(30)
  await until(() => s.turnStarts().length === before + 1, '照常投递')
  assert.match(String(s.turnStarts().at(-1)?.input?.[0]?.text ?? ''), HINT)
  assert.equal(s.phase() ?? 'idle', 'idle')
  assert.equal(s.managers.manager(s.manager.id).threadId, s.threadId)
})
