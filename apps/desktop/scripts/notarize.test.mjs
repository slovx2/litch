import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isStaplerNetworkFailure, notarize, staple, validateTicket } from './notarize.mjs'

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
const network = {
  status: 68,
  stdout: 'CloudKit response lookup failed\n',
  stderr:
    'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."\nThe validate action failed! Error 68.\n',
}

test('分发包只读 validate 同样有界恢复，不对原包重新 staple', () => {
  const calls = []
  let attempts = 0
  validateTicket('readonly/Litch.app', (command, args) => {
    calls.push([command, args])
    if (args[1] === 'validate' && ++attempts < 3) return network
    return { status: 0 }
  })
  assert.equal(attempts, 3)
  assert.ok(calls.every(([, args]) => !args.includes('staple') && !args.includes('submit')))
})

test('TCP 模式只把票据命令交给临时规则包装器，网络恢复仍有界', () => {
  const calls = []
  let attempts = 0
  staple(
    'path with spaces/Litch.app',
    (command, args) => {
      calls.push([command, args])
      if (command === 'bash' && args[1] === 'staple' && ++attempts < 2) return network
      return { status: 0 }
    },
    { tcp: true },
  )
  const wrapped = calls.filter(([command]) => command === 'bash')
  assert.equal(wrapped.length, 3)
  assert.ok(
    wrapped.every(
      ([, args]) =>
        args[0].endsWith('/scripts/ci/stapler-tcp.sh') && args[2] === 'path with spaces/Litch.app',
    ),
  )
  assert.deepEqual(
    calls.filter(([command]) => command === 'sleep').map(([, args]) => args),
    [['30']],
  )
  assert.ok(calls.every(([command]) => command !== 'xcrun'))
})

test('仅日志明确 -1005 或 Error 68 可重试，其他码/未知错误/超时不重试', () => {
  assert.equal(isStaplerNetworkFailure(network), true)
  assert.equal(
    isStaplerNetworkFailure({ status: 68, stderr: 'CloudKit lookup failed! Error 68.' }),
    true,
  )
  assert.equal(isStaplerNetworkFailure({ status: 68, stderr: 'Error 68.' }), true)
  for (const failure of [
    { status: 68, stderr: '' },
    { status: 1, stderr: 'invalid signature' },
    { status: 1, stderr: 'Error 68.\nLITCH_PF_CLEANUP_FAILED' },
    { status: 65, stderr: 'CloudKit lookup failed! Error 65.' },
    { status: 1, stderr: 'NSURLErrorDomain Code=-1001 timeout' },
    { ...network, status: null, error: new Error('ETIMEDOUT') },
  ])
    assert.equal(isStaplerNetworkFailure(failure), false)
})

for (const operation of ['staple', 'validate']) {
  test(`${operation} 网络失败最多三次并退避 30/60 秒，每次原输出进入 summary`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'litch-stapler-test-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const summary = join(dir, 'summary.md')
    const calls = []
    let attempts = 0
    staple(
      'Litch.app',
      (command, args) => {
        calls.push([command, args])
        if (args[1] === operation && ++attempts < 3) return network
        return { status: 0 }
      },
      { summary },
    )
    assert.equal(attempts, 3)
    assert.deepEqual(
      calls.filter(([command]) => command === 'sleep').map(([, args]) => args[0]),
      ['30', '60'],
    )
    assert.equal(
      calls.filter(([, args]) => args[1] === (operation === 'staple' ? 'validate' : 'staple'))
        .length,
      1,
    )
    assert.equal(calls.filter(([, args]) => args[0] === 'notarytool').length, 0)
    const output = readFileSync(summary, 'utf8')
    assert.equal(output.split(network.stdout).length - 1, 2)
    assert.equal(output.split(network.stderr).length - 1, 2)
  })

  test(`${operation} 三次网络失败仍失败；非网络错误首次失败，不降级`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'litch-stapler-exhausted-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    for (const [failure, count] of [
      [network, 3],
      [{ status: 65, stderr: 'Error 65. invalid ticket' }, 1],
    ]) {
      let attempts = 0
      const summary = join(dir, `summary-${count}.md`)
      assert.throws(
        () =>
          staple(
            'Litch.dmg',
            (_command, args) => {
              if (args[1] === operation) {
                attempts++
                return failure
              }
              return { status: 0 }
            },
            { summary },
          ),
        /不分发/,
      )
      assert.equal(attempts, count)
      assert.equal((readFileSync(summary, 'utf8').match(/第 \d 次失败/g) ?? []).length, count)
    }
  })
}
