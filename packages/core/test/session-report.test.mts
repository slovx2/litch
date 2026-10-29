import assert from 'node:assert/strict'
import test from 'node:test'
import { lineageOf } from '../src/projection/session.mjs'
import { deviceWorld } from './device-world.mjs'
import { harness } from './fake-device.mjs'
import { thread } from './fixtures.mjs'
import { settle } from './helpers.mjs'

test('用户回报开关通过核心命令发送；新通知更新侧栏，保留父子关系和等待状态', async () => {
  const source = harness('codex', {
    threads: [
      thread({
        id: 'child',
        status: { type: 'active', activeFlags: ['waitingOnApproval'] },
        litchLineage: {
          parentThreadId: 'parent',
          kind: 'fresh',
          origin: 'model',
          title: '子任务',
          wakeParent: true,
          createdAt: 1,
          reportParent: true,
        },
      } as never),
    ],
  })
  const world = deviceWorld([source], {
    prepare: (d) => d.extensions.push('sessionTree', 'sessionReportControl'),
    extra: { 'litch/session/report/set': (params) => params },
  })
  try {
    world.core.start()
    await settle()
    assert.equal(world.device()?.reportControl, true)
    const before = world.side.sessions.get('child')
    assert.equal(before?.lineage?.reportParent, true)
    await world.command('session.report.set', { sessionId: 'child', reportParent: false })
    assert.deepEqual(world.sent('litch/session/report/set'), [
      { threadId: 'child', reportParent: false },
    ])
    for (const reportParent of [false, true]) {
      world.peer.last().notify('litch/thread/lineage/updated', {
        threadId: 'child',
        lineage: {
          parentThreadId: 'parent',
          kind: 'fresh',
          origin: 'model',
          title: '子任务',
          wakeParent: true,
          reportParent,
          createdAt: 1,
        },
      })
      await settle()
      const after = world.side.sessions.get('child')
      assert.equal(after?.lineage?.reportParent, reportParent)
      assert.equal(after?.lineage?.parentId, 'parent')
      assert.equal(after?.status, before?.status)
    }
    // 重新取得的快照也能恢复状态，不依赖上一次连接收到的通知。
    world.peer.last().notify('litch/thread/lineage/updated', {
      threadId: 'child',
      lineage: {
        parentThreadId: 'parent',
        kind: 'fresh',
        origin: 'model',
        title: '子任务',
        wakeParent: true,
        createdAt: 1,
        reportParent: false,
      },
    })
    await settle()
    assert.equal(world.side.sessions.get('child')?.lineage?.reportParent, false)
  } finally {
    world.core.stop()
  }
})

test('设备没有声明回报控制能力时不发送新方法', async () => {
  const world = deviceWorld([harness('codex')], {
    prepare: (d) => d.extensions.push('sessionTree'),
  })
  try {
    world.core.start()
    await settle()
    assert.equal(world.device()?.reportControl, false)
    await assert.rejects(
      world.command('session.report.set', { sessionId: 'c', reportParent: false }),
    )
    assert.equal(world.sent('litch/session/report/set').length, 0)
  } finally {
    world.core.stop()
  }
})

test('回报字段必填，缺失不按开启投影；明确关闭照实保留', () => {
  const lineage = {
    parentThreadId: 'p',
    kind: 'fresh',
    origin: 'model',
    title: '子任务',
    wakeParent: true,
    createdAt: 1,
  }
  assert.equal(lineageOf(lineage), null)
  assert.equal(lineageOf({ ...lineage, reportParent: false })?.reportParent, false)
  assert.equal(lineageOf({ ...lineage, reportParent: true })?.reportParent, true)
})
