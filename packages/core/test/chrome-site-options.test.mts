import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clientAskOptions } from '../src/device/tool-calls.mjs'

test('Chrome 站点提供持久许可，用户标签仅提供单次认领', () => {
  assert.deepEqual(
    clientAskOptions({
      kind: 'site',
      origin: 'https://example.com',
      url: 'https://example.com',
      browser: 'chrome',
    }).map((option) => option.id),
    ['once', 'session', 'always', 'decline'],
  )
  assert.deepEqual(
    clientAskOptions({ kind: 'chromeTab', url: 'https://example.com', title: 'Page' }).map(
      (option) => option.id,
    ),
    ['once', 'decline'],
  )
  assert.deepEqual(
    clientAskOptions({ kind: 'chromeInstance', instanceId: 'id', name: 'Chrome' }).map(
      (option) => option.id,
    ),
    ['once', 'session', 'decline'],
  )
})
