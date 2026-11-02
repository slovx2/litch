import assert from 'node:assert/strict'
import { test } from 'node:test'
import { notarize, staple } from './notarize.mjs'

test('Accepted 只提交一次；Rejected/Invalid/超时均不重提', () => {
  for (const status of ['Accepted', 'Rejected', 'Invalid', 'In Progress']) {
    const calls = []
    const spawn = (_command, args) => {
      calls.push(args)
      return {
        status: status === 'Accepted' ? 0 : 1,
        stdout: JSON.stringify({ id: 'ticket', status }),
      }
    }
    if (status === 'Accepted') assert.equal(notarize('Litch.dmg', [], spawn), 'ticket')
    else assert.throws(() => notarize('Litch.dmg', [], spawn), /不重试提交/)
    assert.equal(calls.filter((args) => args[1] === 'submit').length, 1)
  }
})
test('staple 传播延迟最多试三次，成功后必须 validate', () => {
  const calls = []
  let attempts = 0
  staple('Litch.app', (command, args) => {
    calls.push([command, args])
    if (args[1] === 'staple') return { status: ++attempts === 3 ? 0 : 1 }
    return { status: 0 }
  })
  assert.equal(attempts, 3)
  assert.deepEqual(
    calls.filter(([command]) => command === 'sleep').map(([, args]) => args[0]),
    ['15', '30'],
  )
  assert.equal(calls.at(-1)[1][1], 'validate')
})
test('持续失败不能降级；validate 失败不因重试而放过', () => {
  let calls = 0
  assert.throws(
    () =>
      staple('Litch.dmg', (_command, args) => {
        if (args[1] === 'staple') calls++
        return { status: 1 }
      }),
    /三次 staple/,
  )
  assert.equal(calls, 3)
  assert.throws(
    () => staple('Litch.app', (_command, args) => ({ status: args[1] === 'staple' ? 0 : 1 })),
    /校验失败/,
  )
})
