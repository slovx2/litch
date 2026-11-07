// 手动压缩结束时后台命令也结束：续跑必须另建普通回合，不能借用压缩的只读权限与事件处理器。
import assert from 'node:assert/strict'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  backgroundBash,
  disposeScene,
  lastUserText,
  readTurns,
  runTurn,
  say,
  startScene,
  until,
} from './fixtures/background-scene.mjs'

test('冷启动恢复原生会话后可以完成手动压缩', { timeout: 60_000 }, async () => {
  const scene = await startScene('compact-cold', { CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS: '0' })
  try {
    scene.model.enqueue(say('保留此前的任务和检查结果。'))
    assert.equal((await runTurn(scene, '记住当前任务，稍后需要压缩。')).status, 'completed')
    scene.model.enqueue(say('摘要：用户要求保留任务和检查结果。'))
    await scene.client.request('thread/compact/start', { threadId: scene.threadId })
    await scene.client.notification('thread/compacted')
    const turns = await readTurns(scene)
    assert.equal(turns.at(-1).status, 'completed')
    assert.deepEqual(
      turns.at(-1).items.map((item: { type: string }) => item.type),
      ['contextCompaction'],
    )
  } finally {
    await disposeScene(scene)
  }
})

for (const mode of ['full', 'no-idle', 'read-only'] as const)
  test(`压缩后后台续跑恢复会话权限（${mode}）并完整记录工具`, { timeout: 90_000 }, async () => {
    const scene = await startScene(
      'compact-bg',
      mode === 'no-idle' ? { CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS: '0' } : {},
    )
    const gate = join(scene.workspace, 'release-background')
    const target = join(scene.workspace, 'background-write.txt')
    let attempted = false
    const results: string[] = []
    try {
      // 用文件明确控制结束时机，压缩模型请求到达前不会自行结束。
      const command = `i=0; while [ ! -f '${gate}' ] && [ "$i" -lt 600 ]; do sleep 0.1; i=$((i+1)); done; echo BACKGROUND_FINISHED`
      scene.model.enqueue(backgroundBash('toolu_compact_background', command))
      scene.model.enqueue(say('后台命令已启动'))
      assert.equal((await runTurn(scene, '启动后台命令')).status, 'completed')
      if (mode === 'read-only')
        await scene.client.request('thread/resume', {
          threadId: scene.threadId,
          approvalPolicy: 'never',
          sandbox: 'read-only',
        })
      scene.model.enqueue(async () => {
        await writeFile(gate, 'go')
        await until('后台命令结束', () =>
          scene.client.trace.some(
            (e) => e.method === 'item/completed' && e.params?.item?.type === 'commandExecution',
          ),
        )
        return [
          { type: 'text', text: '<summary>摘要：用户希望后台命令结束后写一个标记文件。</summary>' },
        ]
      })
      // CLI 的通知轮次可能合并，按请求内容响应，不依赖请求次数。
      scene.model.fallback = (request) => {
        if (!attempted) {
          assert.match(lastUserText(request), /task-notification/)
          attempted = true
          return [
            {
              type: 'tool_use',
              id: 'toolu_write_after_compact',
              name: 'Write',
              input: { file_path: target, content: 'WRITTEN' },
            },
          ]
        }
        results.push(lastUserText(request))
        return [{ type: 'text', text: '后台写入已处理。' }]
      }
      await scene.client.request('thread/compact/start', { threadId: scene.threadId })
      const compacted = await scene.client.notification('thread/compacted')
      await until(
        '后台普通回合完成',
        () => scene.client.trace.filter((e) => e.method === 'turn/completed').length >= 3,
      )
      const turns = await readTurns(scene)
      assert.equal(turns.length, 3)
      const compact = turns.find((turn) => turn.id === compacted.turnId)
      assert.ok(compact)
      assert.deepEqual(
        compact.items.map((item: { type: string }) => item.type),
        ['contextCompaction'],
      )
      const background = turns.at(-1)
      assert.equal(background.status, 'completed')
      assert.ok(background.items.some((item: { type: string }) => item.type === 'fileChange'))
      assert.ok(
        background.items.some(
          (item: { type: string; text?: string }) =>
            item.type === 'agentMessage' && item.text?.includes('后台写入已处理'),
        ),
      )
      if (mode === 'read-only') {
        await assert.rejects(access(target))
        assert.match(results.join('\n'), /超出授权目录|只允许读取|只读/)
      } else {
        assert.equal(await readFile(target, 'utf8'), 'WRITTEN')
        assert.doesNotMatch(results.join('\n'), /超出授权目录|只允许读取/)
      }
      const done = scene.client.trace.findIndex(
        (e) => e.method === 'turn/completed' && e.params.turn.id === compact.id,
      )
      const started = scene.client.trace.findIndex(
        (e) => e.method === 'turn/started' && e.params.turn.id === background.id,
      )
      assert.ok(done >= 0 && started > done, '先收尾压缩，再开始普通回合')
      scene.model.assertConsumed()
    } finally {
      await writeFile(gate, 'release').catch(() => {})
      await disposeScene(scene)
    }
  })
