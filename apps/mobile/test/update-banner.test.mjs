// 更新横条什么时候说失败（src/update/banner.ts）：人点了“更新”之后失败的才说，后台查失败不说，关掉的那一份不再说
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bannerFailure } from '../src/update/banner.ts'

const failed = (reason, download) => ({
  phase: 'failed',
  reason,
  message: '',
  checkedAt: 0,
  download,
})
const shown = (state, dismissed = null) => bannerFailure({ state, dismissed })

test('人点了“更新”之后失败（下载断了、签名不同、不是新版本、大小或校验和不对、拉不起安装器）：横条上说', () => {
  for (const reason of ['download', 'signature', 'package', 'size', 'checksum', 'install'])
    assert.equal(shown(failed(reason, 'sha-a')), reason)
})

test('后台查的时候连不上、清单读不了，和别的状态：横条不说失败', () => {
  assert.equal(shown(failed('network')), null)
  assert.equal(shown(failed('feed')), null)
  assert.equal(shown({ phase: 'latest', version: '0.18.0', checkedAt: 0 }), null)
  assert.equal(shown({ phase: 'available', version: '0.19.0', notesUrl: '' }), null)
})

test('关掉之后这一份不再说，换了新包再失败照样说', () => {
  assert.equal(shown(failed('signature', 'sha-a'), 'sha-a'), null)
  assert.equal(shown(failed('signature', 'sha-b'), 'sha-a'), 'signature')
})
