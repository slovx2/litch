import assert from 'node:assert/strict'
import test from 'node:test'
import { validateSandboxDependencies } from '../src/sandbox-dependencies.mjs'

test('Linux 缺少 bwrap 时构建探测必须失败，不报告完整权限可用；不再要求 socat', () => {
  for (const missing of ['bwrap']) {
    const seen: string[] = []
    assert.throws(
      () =>
        validateSandboxDependencies('linux', (command) => {
          seen.push(command)
          if (command === missing) throw new Error('ENOENT')
        }),
      new RegExp(missing),
    )
    assert.ok(seen.includes(missing))
  }
  const seen: string[] = []
  validateSandboxDependencies('linux', (command) => {
    seen.push(command)
  })
  assert.deepEqual(seen, ['bwrap'])
  assert.doesNotThrow(() => validateSandboxDependencies('win32', () => {}))
  assert.throws(() => validateSandboxDependencies('freebsd', () => {}), /暂不支持/)
})
