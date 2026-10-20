import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { readerForPlatform } from '../reader.mjs'
import { fixture } from './fixtures.mjs'

const library = process.env.LITCH_TEST_NSS_LIBRARY
test('可选：真正的 NSS 生成全新测试资料，与本读取器交叉核对', { skip: !library }, async () => {
  const f = await fixture('firefox')
  try {
    const generated = spawnSync(
      'uv',
      [
        'run',
        '--no-project',
        '--offline',
        'python',
        resolve('apps/desktop/src/browser-import/protected/test/make-nss-fixture.py'),
        library ?? '',
        f.input.profileDir,
        ...(process.env.LITCH_TEST_NSS_AES === '1' ? ['--aes'] : []),
      ],
      { stdio: 'pipe', timeout: 30_000 },
    )
    assert.equal(generated.status, 0, 'NSS 样本生成未成功；需要本机 NSS 和 uv 的 Python 运行时')
    const result = await readerForPlatform('darwin').read(f.input)
    assert.equal(result.passwords?.status, 'ok')
    assert.equal(result.passwords?.items[0]?.username, 'native fixture user')
    assert.equal(result.passwords?.items[0]?.password, 'native fixture password')
  } finally {
    await f.dispose()
  }
})
