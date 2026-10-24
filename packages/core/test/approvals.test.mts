// 手机上批准（clientApprovals 扩展）：核心对着假的聚合面（fake-device.mts）和假的主进程跑。
// 桌面端：带桌面端号的登录卡片挂到设备上（摘要只有打码的用户名）、答了撤了都收掉、设备转来的答复只交给自己挂的那张；
// 没有桌面端号（主进程没装好验签）、设备没列这项扩展时不挂。手机：主题先取挂着的、跟着通知换，approval.answer 原样交给设备。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ApprovalAnswer, ApprovalCard } from '../../protocol/src/client-approvals.mjs'
import {
  type ApprovalsOp,
  type ApprovalsTopicView,
  CLIENT_TOOL,
  type ClientToolPort,
  createCore,
  type ToolToCore,
  type ToolToMain,
} from '../src/index.mjs'
import { fakeDevice, harness } from './fake-device.mjs'
import { fakeOpener } from './fake-server.mjs'
import { thread, turn } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'

const never = { aborted: false, addEventListener() {} }

const settled = async () => {
  for (let round = 0; round < 6; round++) await settle()
}

/** 登录卡片的编号、随机数（内置浏览器出的），主进程的桌面端号 */
const ticket = {
  id: '5f0c2a8e-7b1d-4c3a-9e6f-2d4b8a1c0e7f',
  nonce: 'Nq3vL8sD1fG5hJ0kWx2yZa',
  desktopId: 'Dz5yX2wV8uT1sR4q',
}

/** 主进程给的登录卡片（B1 的 signIn 那一种，界面拿到的有完整用户名） */
const signInAsk = (more: Record<string, unknown> = {}) => ({
  kind: 'signIn',
  id: ticket.id,
  origin: 'https://github.com',
  site: 'GitHub',
  reason: 'Push the branch',
  accounts: [
    { ref: 'a1', username: 'song@gmail.com', masked: 'so•••@gmail.com', lastUsed: 5 },
    { ref: 'a2', username: 'work@corp.com', masked: 'wo•••@corp.com', lastUsed: null },
  ],
  fillBlocked: null,
  taskId: null,
  expiresAt: null,
  nonce: ticket.nonce,
  desktopId: ticket.desktopId,
  ...more,
})

const answer: ApprovalAnswer = {
  id: ticket.id,
  ref: 'a1',
  decision: 'approve',
  remember: false,
  phoneId: 'f83898df0bef57a4',
  approvalKey: 'ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=',
  signature: `${'A'.repeat(86)}==`,
}

function world(extensions = ['harness', 'clientApprovals']) {
  const fake = fakeDevice([
    harness('pi', {
      threads: [thread({ id: 'p1', turns: [turn('t1', [], { status: 'inProgress' })] })],
    }),
  ])
  fake.device.extensions = extensions
  const peer = fakeOpener({
    ...fake.handlers,
    'litch/approval/open': () => ({}),
    'litch/approval/close': () => ({}),
    'litch/approval/answer': () => ({}),
    'litch/approval/list': () => ({
      data: [{ ...phoneCard(), openedAt: 7 }],
    }),
  })
  const sent: ToolToMain[] = []
  let inbox: ((message: ToolToCore) => void) | null = null
  const port: ClientToolPort = {
    namespaces: () => ['litch_echo'],
    post: (message) => sent.push(structuredClone(message)),
    listen(handler) {
      inbox = handler
    },
  }
  const time = fakeClock()
  const core = createCore({
    clock: time.clock,
    version: '9.9.9',
    log: () => {},
    clientTools: port,
    devices: [
      {
        id: 'dev',
        name: 'song-debian',
        host: 'song@debian',
        kind: 'ssh',
        target: { kind: 'alias', alias: 'song-debian' },
        wire: 'green',
        open: peer.open,
      },
    ],
  })
  const reply = (message: Record<string, unknown>) =>
    inbox?.({ type: CLIENT_TOOL, ...message } as ToolToCore)
  const seen = (method: string) =>
    peer.servers
      .flatMap((server) => server.seen)
      .filter((entry) => entry.method === method)
      .map((entry) => entry.params as Record<string, unknown>)
  const broadcast = (method: string, params: unknown) => {
    for (const server of peer.servers) server.notify(method, params)
  }
  /** 引擎调一次客户端工具，主进程出一张卡片 */
  const ask = async (cardAsk: unknown, askId = 'k1') => {
    peer.last().ask('item/tool/call', {
      threadId: 'p1',
      turnId: 't1',
      callId: 'c1',
      namespace: 'litch_echo',
      tool: 'echo',
      arguments: {},
    })
    await settled()
    const id = sent.filter((message) => message.op === 'call').at(-1)
    reply({ op: 'ask', id: id?.op === 'call' ? id.invocation.id : '', askId, ask: cardAsk })
    await settled()
  }
  return { core, peer, sent, reply, seen, broadcast, ask }
}

function phoneCard(): ApprovalCard {
  return {
    id: ticket.id,
    threadId: 'p1',
    kind: 'browserSignIn',
    summary: {
      origin: 'https://github.com',
      site: 'GitHub',
      reason: 'Push the branch',
      device: 'song-debian',
      accounts: [
        { ref: 'a1', masked: 'so•••@gmail.com' },
        { ref: 'a2', masked: 'wo•••@corp.com' },
      ],
      task: null,
      fillBlocked: null,
    },
    desktopId: ticket.desktopId,
    nonce: ticket.nonce,
    expiresAt: null,
  }
}

test('桌面端：带桌面端号的登录卡片挂到设备上，只有打码的用户名；答复交给主进程；主进程撤了卡片就收掉', async () => {
  const w = world()
  w.core.start()
  await settled()
  const init = w.seen('initialize')[0] as { capabilities: { litchExtensions: string[] } }
  assert.ok(init.capabilities.litchExtensions.includes('clientApprovals'))
  await w.ask(signInAsk())
  const opened = w.seen('litch/approval/open')
  assert.deepEqual(opened, [phoneCard()])
  assert.doesNotMatch(JSON.stringify(opened), /song@gmail\.com|work@corp\.com/)

  // 别的卡片的答复、形状不对的不交
  w.broadcast('litch/approval/answered', { ...answer, id: 'Other0card000000' })
  w.broadcast('litch/approval/answered', { ...answer, signature: 'x' })
  w.broadcast('litch/approval/answered', answer)
  await settled()
  assert.deepEqual(
    w.sent.filter((message) => message.op === 'phoneAnswer'),
    [{ type: CLIENT_TOOL, op: 'phoneAnswer', answer }],
  )
  // 主进程验过、答完了：askDone 撤掉卡片，设备上一起收
  w.reply({ op: 'askDone', askId: 'k1' })
  await settled()
  assert.deepEqual(w.seen('litch/approval/close'), [{ id: ticket.id }])
  // 收掉之后再来的答复不交
  w.broadcast('litch/approval/answered', answer)
  await settled()
  assert.equal(w.sent.filter((message) => message.op === 'phoneAnswer').length, 1)
})

test('桌面端：人在桌面端答了也收掉；没有桌面端号、不是登录卡片、设备没列 clientApprovals 都不挂', async () => {
  const w = world()
  w.core.start()
  await settled()
  await w.ask(signInAsk({ taskId: 'task-1', expiresAt: 99 }))
  const [card] = w.seen('litch/approval/open') as unknown as ApprovalCard[]
  assert.deepEqual(card?.summary.task, { id: 'task-1', name: '' })
  assert.equal(card?.expiresAt, 99)
  // 在对话里答这张卡片（界面的 session.respond）
  await w.core.command(
    'session.respond',
    { deviceId: 'dev', sessionId: 'p1', requestId: 'litch-ask:k1', optionId: 'decline' },
    never,
  )
  await settled()
  assert.deepEqual(
    w.sent.filter((message) => message.op === 'answer').map((message) => message.op),
    ['answer'],
  )
  assert.deepEqual(w.seen('litch/approval/close'), [{ id: ticket.id }])

  await w.ask(signInAsk({ desktopId: null }), 'k2')
  await w.ask({ kind: 'site', origin: 'https://a.example', url: 'https://a.example/' }, 'k3')
  assert.equal(w.seen('litch/approval/open').length, 1)

  const old = world(['harness'])
  old.core.start()
  await settled()
  await old.ask(signInAsk())
  assert.equal(old.seen('litch/approval/open').length, 0)
})

test('手机：主题先取挂着的卡片，跟着通知换；approval.answer 原样交给设备', async () => {
  const w = world()
  w.core.start()
  await settled()
  const snapshots: ApprovalsTopicView[] = []
  const ops: ApprovalsOp[] = []
  const close = w.core.subscribe(
    { kind: 'approvals', deviceId: 'dev' },
    {
      snapshot: (data) => snapshots.push(structuredClone(data as ApprovalsTopicView)),
      delta: (more) => ops.push(...structuredClone(more as ApprovalsOp[])),
      error() {},
    },
  )
  await settled()
  assert.equal(snapshots[0]?.available, true)
  assert.equal(w.seen('litch/approval/list').length, 1)
  assert.deepEqual(ops.at(-1)?.view.cards, [{ ...phoneCard(), openedAt: 7 }])
  w.broadcast('litch/approval/changed', { threadId: 'p1', data: [] })
  await settled()
  assert.deepEqual(ops.at(-1)?.view.cards, [])
  w.broadcast('litch/approval/changed', {
    threadId: 'p2',
    data: [{ ...phoneCard(), threadId: 'p2', openedAt: 9 }],
  })
  await settled()
  assert.deepEqual(
    ops.at(-1)?.view.cards.map((card: ApprovalCard) => card.threadId),
    ['p2'],
  )
  await w.core.command('approval.answer', { deviceId: 'dev', answer }, never)
  assert.deepEqual(w.seen('litch/approval/answer'), [answer])
  close()
})
