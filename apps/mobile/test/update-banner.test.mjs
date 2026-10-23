// 更新横条什么时候说失败（src/update/banner.ts）：人点了“更新”、下下来对不上才说，后台查失败不说
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bannerFailure } from '../src/update/banner.ts'

const failed = (reason) => ({ phase: 'failed', reason, message: '', checkedAt: 0 })

test('签名不同、不是新版本、大小或校验和不对、拉不起安装器：横条上说', () => {
  for (const reason of ['signature', 'package', 'size', 'checksum', 'install'])
    assert.equal(bannerFailure(failed(reason)), reason)
})

test('后台查的时候连不上、清单读不了，和别的状态：横条不说失败', () => {
  assert.equal(bannerFailure(failed('network')), null)
  assert.equal(bannerFailure(failed('feed')), null)
  assert.equal(bannerFailure({ phase: 'latest', version: '0.18.0', checkedAt: 0 }), null)
  assert.equal(bannerFailure({ phase: 'available', version: '0.19.0', notesUrl: '' }), null)
})
