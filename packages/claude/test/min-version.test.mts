import assert from 'node:assert/strict'
import test from 'node:test'
import { isVersionAtLeast } from '../../shared/src/min-version.mjs'

test('版本下限接受相同或更高的稳定版，拒绝更低、预发布与非法格式', () => {
  for (const actual of ['2.1.282', '2.1.283', '2.2.0', '3.0.0', '2.1.1000'])
    assert.equal(isVersionAtLeast(actual, '2.1.282'), true, actual)
  for (const actual of ['2.1.281', '2.0.999', '1.9.9', '2.1.283-beta.1', 'v2.1.283', '', undefined])
    assert.equal(isVersionAtLeast(actual, '2.1.282'), false, String(actual))
})
