import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { fixtureEnvironment } from './fixture-environment.mjs'

test('夹具子进程不继承真实设备的 socket 和路由', () => {
  const inherited = {
    ...process.env,
    LITCH_DEVICE_SOCKET: '/real-service/device.sock',
    LITCH_SESSION_ID: 'real-session',
    LITCH_FIXTURE_CODEX_ASK: '1',
  }
  const child = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '-e',
        'console.log(JSON.stringify({socket:process.env.LITCH_DEVICE_SOCKET,session:process.env.LITCH_SESSION_ID,fixture:process.env.LITCH_FIXTURE_CODEX_ASK}))',
      ],
      { env: fixtureEnvironment(inherited), encoding: 'utf8' },
    ),
  )
  assert.deepEqual(child, { fixture: '1' })
  assert.equal(inherited.LITCH_DEVICE_SOCKET, '/real-service/device.sock')
})
