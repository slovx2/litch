import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectRequest } from '../src/projection/requests.mjs'

test('命令审批去掉重复标题，保留独立理由与原命令', () => {
  for (const [command, reason, expected] of [
    [
      'ls -la /root/.gemini/antigravity-cli/mcp/litch',
      'ls -la /root/.gemini/antigravity-cli/mcp/litch',
      null,
    ],
    ['  ls -la\n', 'ls -la', null],
    ['ls -la', '需要查看 MCP 安装目录', '需要查看 MCP 安装目录'],
    [null, '运行工具', '运行工具'],
    ['ls -la', null, null],
  ]) {
    const projected = projectRequest(
      'item/commandExecution/requestApproval',
      { threadId: 'agy:acp:1', turnId: 't1', itemId: 'c1', command, reason },
      'r1',
    )
    assert.equal(projected?.view.kind, 'approval')
    if (projected?.view.kind !== 'approval') throw new Error('审批投影缺失')
    assert.equal(projected.view.command, command)
    assert.equal(projected.view.reason, expected)
    assert.deepEqual(projected.answer({ optionId: 'accept' }), { decision: 'accept' })
  }
})
