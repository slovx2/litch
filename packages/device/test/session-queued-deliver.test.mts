import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSessionEvent } from '../../protocol/src/session-tree.mjs'
import { litch, parent, treeRig, until } from './tree-kit.mjs'

test('立即处理有界并发读子线元数据，ACK 前保留回报，失败可重试并记录分段', async () => {
  const logs: string[] = []
  const env = treeRig({}, { log: (line) => logs.push(line) })
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    const client = await litch(env)
    const { threadId } = await parent(client, false)
    const tree = env.device.sessionTree
    const children: string[] = []
    for (let i = 0; i < 9; i++) {
      const { thread } = await client.call('thread/start', {
        harness: 'claude-code',
        cwd: '/work/fixture',
      })
      children.push(thread.id)
      tree.store.addLineage({
        threadId: thread.id,
        parentThreadId: threadId,
        harness: 'claude-code',
        kind: 'fresh',
        origin: 'user',
        title: '虚构子线',
        prompt: '虚构任务',
        wakeParent: false,
        createdAt: 1,
      })
      if (i > 5) env.claude.selfTurn(thread.id)
    }
    const first = children[0]
    assert.ok(first)
    tree.store.addNote(
      threadId,
      { threadId: first, title: '回报', status: 'completed', excerpt: '不应出现在计时日志' },
      false,
    )
    const read = tree.read.bind(tree)
    let active = 0
    let peak = 0
    let reads = 0
    tree.read = async (id, includeTurns, latest) => {
      if (!children.includes(id)) return read(id, includeTurns, latest)
      assert.equal(includeTurns, false, '子线状态只读元数据')
      reads++
      active++
      peak = Math.max(peak, active)
      try {
        await gate
        return await read(id, includeTurns, latest)
      } finally {
        active--
      }
    }
    const link = await tree.link('pi')
    const request = link.request.bind(link)
    let reject = true
    link.request = async (method, params, options) => {
      if (method === 'turn/start' && reject) throw new Error('模拟投递失败')
      return request(method, params, options)
    }
    const delivery = tree.deliver(threadId)
    await until(() => active === 4, '四条并发读取')
    assert.equal(reads, 4, '其余子线排队，不一次性打满引擎')
    assert.equal(tree.store.notes(threadId).length, 1, 'ACK 前保留回报')
    release()
    await assert.rejects(delivery, /模拟投递失败/)
    assert.equal(peak, 4)
    assert.equal(reads, 9)
    assert.equal(tree.store.notes(threadId).length, 1, '失败不丢回报')
    reject = false
    assert.equal(await tree.deliver(threadId), 'woken')
    assert.equal(tree.store.notes(threadId).length, 0)
    const sent = env.pi.sent('turn/start').at(-1)
    assert.equal(parseSessionEvent(sent.input[0].text).event?.working, 3)
    const timing = logs
      .filter((line) => line.startsWith('queuedNotes.deliver.timing '))
      .map((line) => JSON.parse(line.slice(line.indexOf(' ') + 1)))
    assert.equal(timing.length, 2)
    assert.equal(timing[0].ok, false)
    assert.equal(timing[1].outcome, 'woken')
    assert.deepEqual(Object.keys(timing[1].stages), [
      'queue',
      'idle',
      'children',
      'watch',
      'questions',
      'startAck',
    ])
    assert.ok(timing[1].totalMs >= 0)
    assert.ok(!JSON.stringify(timing).includes('不应出现在计时日志'))
  } finally {
    release()
    await env.close()
  }
})
