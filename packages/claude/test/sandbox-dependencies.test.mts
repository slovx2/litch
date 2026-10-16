import assert from 'node:assert/strict'
import test from 'node:test'
import { validateSandboxDependencies } from '../src/sandbox-dependencies.mjs'

test('Linux 缺少 socat 或 bwrap 时构建探测必须失败，不报告完整权限可用', () => {
  for (const missing of ['bwrap', 'socat']) {
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
  assert.deepEqual(seen, ['bwrap', 'socat'])
  assert.doesNotThrow(() => validateSandboxDependencies('win32', () => {}))
  assert.throws(() => validateSandboxDependencies('freebsd', () => {}), /暂不支持/)
})
