import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TURN_NOTICE, type TurnNotice } from '../../protocol/src/turn-notices.mjs'
import { TurnNotices } from '../src/turn-notices.mjs'
import { FakeUpstream } from './fake-upstream.mjs'
import { rig } from './helpers.mjs'

for (const harness of ['codex', 'claude-code', 'pi', 'dsh', 'opencode', 'acp']) {
  test(`${harness}：摘要按最后回答截断，完成事件去重，各种结局不串正文`, () => {
    const notices: TurnNotice[] = []
    const tracker = new TurnNotices((notice) => notices.push(notice))
    const answer = `${harness}：${'😀'.repeat(600)}`
    tracker.observe('item/completed', {
      threadId: 's',
      turnId: 't',
      item: { type: 'agentMessage', text: answer },
    })
    const completed = {
      threadId: 's',
      turn: {
        id: 't',
        status: 'completed',
        itemsView:
          harness === 'claude-code' ? 'notLoaded' : harness === 'codex' ? 'summary' : 'full',
        items: harness === 'claude-code' ? [] : [{ type: 'agentMessage', text: answer }],
      },
    }
    tracker.observe('turn/completed', completed)
    tracker.observe('turn/completed', completed)
    assert.equal(notices.length, 1)
    assert.equal(Array.from(notices[0]?.body ?? '').length, 500)
    assert.ok(notices[0]?.body?.startsWith(`${harness}：`))
    assert.ok(notices[0]?.body?.endsWith('…'))
    tracker.observe('turn/completed', {
      threadId: 's',
      turn: { id: 'tools', status: 'completed', itemsView: 'full', items: [] },
    })
    assert.deepEqual(notices[1], {
      threadId: 's',
      turnId: 'tools',
      outcome: 'completed',
      body: null,
    })
    tracker.observe('turn/completed', {
      threadId: 's',
      turn: {
        id: 'error',
        status: 'failed',
        itemsView: 'notLoaded',
        error: { message: '请求失败' },
      },
    })
    assert.deepEqual(notices[2], {
      threadId: 's',
      turnId: 'error',
      outcome: 'failed',
      body: '请求失败',
    })
    tracker.observe('turn/completed', {
      threadId: 's',
      turn: { id: 'stop', status: 'interrupted', items: [] },
    })
    assert.deepEqual(notices[3], {
      threadId: 's',
      turnId: 'stop',
      outcome: 'interrupted',
      body: null,
    })
  })
}

test('设备自己的引擎连接收到正文：只向声明扩展的桌面和手机投递，不向旧客户端泄漏，不重放', async () => {
  const upstream = new FakeUpstream('pi')
  const env = rig({ pi: upstream })
  try {
    const desktop = env.connect()
    const phone = env.connect()
    const old = env.connect()
    await desktop.initialize(['harness', 'turnNotices'])
    await phone.initialize(['harness', 'turnNotices'])
    await old.initialize(['harness'])
    const link = await env.device.openEngineLink('pi')
    // 仅设备编排连接收到标准事件；三个客户端都未 resume 这个会话。
    const source = upstream.live.at(-1)
    assert.ok(source)
    const event = {
      method: 'turn/completed',
      params: {
        threadId: 'background-line',
        turn: {
          id: 't',
          status: 'completed',
          itemsView: 'summary',
          items: [{ type: 'agentMessage', text: '**后台完成**' }],
        },
      },
    }
    const notices = (client: typeof desktop, turnId: string) =>
      client.notifications.filter(
        (n) => n.method === TURN_NOTICE && (n.params as TurnNotice | undefined)?.turnId === turnId,
      )
    // 通知经 setImmediate 广播，固定等 20ms 不保证广播已执行。
    // 同一上游连接再发一个独立回合，等客户端实际收到它，才检查前面的去重和不投递。
    const through = async (turnId: string, clients = [desktop, phone]) => {
      source.send({
        ...event,
        params: { ...event.params, turn: { ...event.params.turn, id: turnId } },
      })
      await Promise.all(
        clients.map((client) =>
          client.waitFor(
            (n) =>
              n.method === TURN_NOTICE && (n.params as TurnNotice | undefined)?.turnId === turnId,
          ),
        ),
      )
    }
    source.send(event)
    source.send(event)
    await through('after-duplicates')
    for (const client of [desktop, phone]) {
      assert.equal(notices(client, 't').length, 1)
      assert.deepEqual(notices(client, 't')[0]?.params, {
        threadId: 'background-line',
        turnId: 't',
        outcome: 'completed',
        body: '**后台完成**',
      })
      assert.equal(client.notifications.filter((n) => n.method === 'turn/completed').length, 0)
    }
    assert.equal(old.notifications.filter((n) => n.method === TURN_NOTICE).length, 0)
    assert.equal(
      upstream.seen.filter((n) => n.method === 'thread/turns/list' || n.method === 'thread/resume')
        .length,
      0,
    )
    const reconnect = env.connect()
    await reconnect.initialize(['harness', 'turnNotices'])
    source.send(event)
    await through('after-reconnect', [desktop, phone, reconnect])
    assert.equal(notices(reconnect, 't').length, 0)
    for (const client of [desktop, phone]) assert.equal(notices(client, 't').length, 1)
    assert.equal(old.notifications.filter((n) => n.method === TURN_NOTICE).length, 0)
    link.close()
  } finally {
    await env.close()
  }
})
