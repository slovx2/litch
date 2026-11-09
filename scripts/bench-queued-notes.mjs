// 隔离设备与假引擎，量立即处理的 ACK；每个子会话状态读取固定延迟 100ms。
// 先构建 device。用同一脚本对比改动前后的产物，不代表真实模型冷启动耗时。
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { litch, parent, treeRig } from '../packages/device/dist/device/test/tree-kit.mjs'

for (let sample = 0; sample < 3; sample++) {
  const logs = []
  const env = treeRig({}, { log: (line) => logs.push(line) })
  try {
    const client = await litch(env)
    const { threadId } = await parent(client, false)
    const tree = env.device.sessionTree
    const children = []
    for (let i = 0; i < 12; i++) {
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
        title: `Fixture ${i}`,
        prompt: '虚构任务',
        wakeParent: false,
        createdAt: 1,
      })
    }
    tree.store.addNote(
      threadId,
      { threadId: children[0], title: 'Fixture', status: 'completed', excerpt: '完成' },
      false,
    )
    const read = tree.read.bind(tree)
    let active = 0
    let peak = 0
    tree.read = async (id, ...args) => {
      if (!children.includes(id)) return read(id, ...args)
      active++
      peak = Math.max(peak, active)
      try {
        await delay(100)
        return await read(id, ...args)
      } finally {
        active--
      }
    }
    const started = performance.now()
    assert.deepEqual(await client.call('litch/thread/queuedNotes/deliver', { threadId }), {
      delivered: 'woken',
    })
    console.log(
      JSON.stringify({
        sample,
        children: 12,
        delayMs: 100,
        ackMs: Math.round(performance.now() - started),
        peak,
        timing: logs.filter((line) => line.includes('queuedNotes.deliver.timing')),
      }),
    )
  } finally {
    await env.close()
  }
}
