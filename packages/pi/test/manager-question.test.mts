import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { MANAGER_TOOLS } from '../../protocol/src/client-tools-manager.mjs'
import { managerQuestionRules } from '../../protocol/src/manager-question.mjs'
import { approvalHarness, toolResults } from './approval-harness.mjs'

test('旁问即使关闭审批也拦写文件与命令，分叉替换经理工具', { timeout: 60000 }, async () => {
  const env = await approvalHarness({ approvals: false })
  try {
    const client = await env.connect('question')
    const { thread } = await client.ok('thread/start', {
      cwd: env.cwd,
      dynamicTools: [MANAGER_TOOLS],
    })
    await client.completed(await client.start(thread.id, '经理背景'))
    const dynamicTools = [
      {
        ...MANAGER_TOOLS,
        instructions: managerQuestionRules('D-1'),
        tools: MANAGER_TOOLS.tools.filter((tool) => ['summary', 'get'].includes(tool.name)),
      },
    ]
    const fork = await client.ok('thread/fork', {
      threadId: thread.id,
      ephemeral: true,
      dynamicTools,
    })
    const target = join(env.cwd, 'must-not-exist.txt')
    env.steps.push(
      { tools: [{ name: 'write', args: { path: target, content: '不可写' } }] },
      (body) => {
        assert.match(toolResults(body).join('\n'), /只允许/)
        return { tools: [{ name: 'bash', args: { command: 'touch must-not-exist.txt' } }] }
      },
      (body) => {
        assert.match(toolResults(body).join('\n'), /只允许/)
        return { text: '只能回答背景' }
      },
    )
    await client.completed(await client.start(fork.thread.id, '请解释背景'))
    assert.equal(existsSync(target), false)
    assert.equal(client.approvals().length, 0)
  } finally {
    await env.dispose()
  }
})
