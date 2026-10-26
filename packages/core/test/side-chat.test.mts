// 侧聊（session.sideChat）：从一个会话临时分出一段对话。只给声明了 ephemeralFork 的 harness；
// 分叉带 ephemeral，没在跑时带到最后一个回合、在跑时截在它之前；分出来的不进侧栏；
// 第一条消息开头拼上给模型的边界说明，对话里认回来时去掉
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Thread } from '../../protocol/src/index.mjs'
import { projectItem } from '../src/projection/items.mjs'
import { stripSideChatNote, withSideChatNote } from '../src/projection/side-chat.mjs'
import { deviceWorld, features } from './device-world.mjs'
import { harness } from './fake-device.mjs'
import { agentText, thread, turn, userText } from './fixtures.mjs'
import { settle } from './helpers.mjs'
import { watchSession } from './wire.mjs'

const settleMany = async (times = 4) => {
  for (let i = 0; i < times; i++) await settle()
}

const main = () =>
  thread({
    id: 'a',
    turns: ['t1', 't2'].map((id) =>
      turn(id, [userText(`${id}-u`, `问 ${id}`), agentText(`${id}-m`, `答 ${id}`)], {
        status: 'completed',
      }),
    ),
  })

/** 一台设备上一个 harness，fork 照对面的样子回一个临时会话（带着源会话的回合） */
function world(declared: boolean) {
  const pi = harness('pi', {
    declaration: { features: features(declared ? { ephemeralFork: true } : {}) },
    threads: [main()],
  })
  let seq = 0
  const made = deviceWorld([pi], {
    extra: {
      'thread/fork': (params) => {
        const { threadId } = params as { threadId: string }
        const source = pi.threads.find((entry) => entry.id === threadId) as Thread
        const side: Thread = {
          ...thread({ id: `side-${++seq}`, turns: source.turns }),
          ephemeral: true,
          forkedFromId: threadId,
        }
        pi.threads.push(side)
        return { thread: { ...side, turns: [], harness: 'pi' } }
      },
    },
  })
  return { ...made, pi }
}

test('SIDE-CORE-001 边界说明拼在正文前面，认回来时去掉；不是这一段开头的原样', () => {
  const sent = withSideChatNote('这是什么意思？')
  assert.ok(sent.startsWith('<litch-side-chat>\n'))
  assert.equal(stripSideChatNote(sent), '这是什么意思？')
  assert.equal(stripSideChatNote(withSideChatNote('')), '')
  assert.equal(stripSideChatNote('<litch-side-chat>\n没有收尾'), '<litch-side-chat>\n没有收尾')
  assert.equal(stripSideChatNote('普通的话'), '普通的话')
  // 对面回显的用户消息：对话里只剩用户自己打的字
  const echoed = projectItem(userText('u1', withSideChatNote('旁边问一句')))
  assert.equal(echoed.kind === 'userMessage' ? echoed.text : null, '旁边问一句')
})

test('SIDE-CORE-002 声明了 ephemeralFork：临时分叉带到最后一个回合，不进侧栏；第一条消息带边界说明，显示时去掉', async () => {
  const { core, command, sent, side } = world(true)
  core.start()
  await settleMany()
  const parent = watchSession(core, 'a')
  await settleMany()
  assert.equal(parent.seen.view?.can.sideChat, true)

  const { sessionId } = (await command('session.sideChat', { sessionId: 'a' })) as {
    sessionId: string
  }
  assert.equal(sessionId, 'side-1')
  assert.deepEqual(sent('thread/fork'), [
    { threadId: 'a', lastTurnId: 't2', ephemeral: true, excludeTurns: true },
  ])
  await settleMany()
  assert.ok(!side.sessions.has(sessionId), '临时会话不进侧栏')

  const aside = watchSession(core, sessionId)
  await settleMany()
  assert.deepEqual(
    aside.seen.view?.turns.map((entry) => entry.id),
    ['t1', 't2'],
  )
  await command('session.send', { sessionId, text: '旁边问一句', images: [], extras: [] })
  await command('session.send', { sessionId, text: '第二句', images: [], extras: [] })
  const starts = sent('turn/start') as { input: { type: string; text?: string }[] }[]
  assert.equal(starts.length >= 1, true)
  const first = starts[0]?.input.find((part) => part.type === 'text')?.text ?? ''
  assert.ok(first.startsWith('<litch-side-chat>'), '第一条带边界说明')
  assert.equal(stripSideChatNote(first), '旁边问一句')
  const shown = aside.seen.view?.turns.at(-1)?.itemIds.map((id) => aside.seen.view?.items[id])
  const said = shown?.find((item) => item?.kind === 'userMessage')
  assert.equal(said?.kind === 'userMessage' ? said.text : null, '旁边问一句')
  aside.close()
  parent.close()
})

test('SIDE-CORE-003 主会话有回合在跑：截在它之前分叉，主会话照常', async () => {
  const { core, command, sent, peer } = world(true)
  core.start()
  await settleMany()
  const parent = watchSession(core, 'a')
  await settleMany()
  peer.last().notify('turn/started', {
    threadId: 'a',
    turn: turn('t3', [], { status: 'inProgress' }),
  })
  await settle()
  await command('session.sideChat', { sessionId: 'a' })
  assert.deepEqual(sent('thread/fork'), [
    { threadId: 'a', beforeTurnId: 't3', ephemeral: true, excludeTurns: true },
  ])
  assert.equal(parent.seen.view?.turns.at(-1)?.status, 'running')
  parent.close()
})

test('SIDE-CORE-004 没声明 ephemeralFork 的 harness：不出侧聊，命令报不支持，不去分叉', async () => {
  const { core, command, sent } = world(false)
  core.start()
  await settleMany()
  const parent = watchSession(core, 'a')
  await settleMany()
  assert.equal(parent.seen.view?.can.sideChat, false)
  await assert.rejects(command('session.sideChat', { sessionId: 'a' }), { code: 'unsupported' })
  assert.equal(sent('thread/fork').length, 0)
  parent.close()
})
