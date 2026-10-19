import assert from 'node:assert/strict'
import test from 'node:test'
import { toolItem } from '../src/projection.mjs'

test('Windows 上 dsh 的 pwsh 和 bash 一样投成命令条目，审批卡片上看得到命令', () => {
  const thread = { cwd: 'C:\\work' } as any
  for (const name of ['bash', 'pwsh']) {
    const item = toolItem(
      'c1',
      name,
      { command: 'Write-Output hi', workdir: 'C:\\work\\sub' },
      thread,
      undefined,
    )
    assert.equal(item.type, 'commandExecution', name)
    assert.equal(item.command, 'Write-Output hi')
    assert.equal(item.cwd, 'C:\\work\\sub')
  }
})
