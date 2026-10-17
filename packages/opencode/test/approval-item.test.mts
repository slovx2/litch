import assert from 'node:assert/strict'
import test from 'node:test'
import { client, isolate, skip, text, violations } from './client.mjs'
import { scripted } from './mock-model.mjs'

// 模型一上来就调工具（这一步没有别的话）时，OpenCode 的权限请求（permission.asked）会抢在工具部件进入
// running 之前到：适配器那时还没画命令条目。审批的 itemId 仍得是之后那个条目的标识（工具部件号），
// 不能拿权限请求号顶替，不然客户端对不上是哪一条命令在等审批。端到端检查（scripts/check-opencode-e2e.mjs）
// 里假模型就是这样调的，每次都对不上；包里原来的用例在调工具之前先说了几句话，碰不到。
test('OpenCode：权限请求抢在条目开始之前到时，审批的 itemId 仍是那个命令条目', {
  skip,
  timeout: 120000,
}, async () => {
  const env = await isolate(
    scripted({
      RUN: [
        [{ type: 'tool', name: 'bash', input: { command: 'printf ran', description: '跑' } }],
        [{ type: 'text', chunks: ['跑完了。'] }],
      ],
    }),
    { permission: { bash: 'ask' } },
  )
  try {
    const desktop = client(env.server)
    await desktop.initialize()
    desktop.onRequest(() => ({ decision: 'accept' }))
    const { thread } = await desktop.call('thread/start', {
      cwd: env.cwd,
      permissions: ':workspace',
    })
    // 连着跑几个回合：赶上的先后是时序决定的，一次对上不说明问题
    for (let round = 0; round < 3; round += 1) {
      const { turn } = await desktop.call('turn/start', {
        threadId: thread.id,
        input: text(`RUN 第 ${round + 1} 次`),
      })
      const done = (await desktop.until('turn/completed', (p) => p.turn.id === turn.id, 60000)).turn
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      const command = done.items.find((item: any) => item.type === 'commandExecution')
      assert.equal(command?.status, 'completed')
      const asked = desktop.requests.filter(
        (request) =>
          request.method === 'item/commandExecution/requestApproval' &&
          request.params.turnId === turn.id,
      )
      assert.equal(asked.length, 1)
      assert.equal(asked[0].params.itemId, command.id, '审批的 itemId 应是命令条目的标识')
    }
  } finally {
    await env.restore()
  }
  assert.deepEqual([...violations], [])
})
