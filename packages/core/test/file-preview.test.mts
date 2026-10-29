import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RpcError } from '../src/connection/rpc.mjs'
import { channelFailure } from '../src/device/faults.mjs'
import { createFiles, type FilesHost } from '../src/device/files.mjs'
import { PREVIEW_LIMIT } from '../src/model-preview.mjs'
import { explicitFileRef, fileRefOf } from '../src/projection/file-refs.mjs'
import { fakeClock } from './helpers.mjs'

function fixture(
  supported: boolean,
  handler: (params: any) => unknown = () => ({ dataBase64: 'IyBoaQ==' }),
) {
  const asked: unknown[] = []
  const host: FilesHost = {
    clock: fakeClock().clock,
    online: () => true,
    platform: () => 'linux',
    home: () => '/home/test',
    previewSupported: () => supported,
    knownRoot: (root) => root === '/work',
    request: async (_method, params) => {
      asked.push(params)
      return handler(params) as any
    },
    fail: channelFailure,
    log() {},
  }
  return { files: createFiles(host), asked }
}

test('预览只在声明能力后读取；native direct 无能力时零请求', async () => {
  const no = fixture(false)
  assert.equal((await no.files.preview('/work', '/work/a.md', 'markdown')).kind, 'unsupported')
  assert.equal(no.asked.length, 0)
  const yes = fixture(true)
  const result = await yes.files.preview('/work', '/work/a.md', 'markdown')
  assert.equal(result.kind, 'ready')
  assert.deepEqual(yes.asked, [
    { path: '/work/a.md', litchPreview: { root: '/work', maxBytes: PREVIEW_LIMIT.markdown } },
  ])
  await assert.rejects(yes.files.preview('/work', '/outside/a.md', 'markdown'))
  await assert.rejects(yes.files.preview('/unknown', '/unknown/a.md', 'markdown'))
  assert.equal(yes.asked.length, 1)
})

test('预览对后端错误和不可信响应再次核验', async () => {
  const tooBig = fixture(true, () => ({ dataBase64: 'YQ=='.repeat(PREVIEW_LIMIT.svg) }))
  assert.equal((await tooBig.files.preview('/work', '/work/a.svg', 'svg')).kind, 'tooLarge')
  const invalid = fixture(true, () => ({ dataBase64: '<script>' }))
  assert.equal((await invalid.files.preview('/work', '/work/a.md', 'markdown')).kind, 'invalid')
  for (const kind of ['outside', 'notFile', 'changed', 'busy', 'tooLarge']) {
    const failed = fixture(true, () => {
      throw new RpcError(-32004, kind, { litchPreview: { kind, bytes: 999999 } })
    })
    assert.equal((await failed.files.preview('/work', '/work/a.md', 'markdown')).kind, kind)
  }
  const missing = fixture(true, () => {
    throw new RpcError(-32603, 'ENOENT: no such file')
  })
  assert.equal((await missing.files.preview('/work', '/work/a.md', 'markdown')).kind, 'missing')
})

test('明确文件链接支持空格、图片、标题与编码井号，正文识别不扩宽', () => {
  const scope = { root: '/work', cwd: '/work/docs' }
  assert.equal(explicitFileRef('my%20file.png', scope)?.path, '/work/docs/my file.png')
  assert.equal(explicitFileRef('a%23b.md#中文', scope)?.path, '/work/docs/a#b.md')
  assert.equal(explicitFileRef('a.md#L12', scope)?.line, 12)
  assert.equal(explicitFileRef('a.md#中文', scope)?.fragment, '中文')
  assert.equal(explicitFileRef('%6aavascript:alert(1)', scope), null)
  assert.equal(explicitFileRef('../../outside.md', scope), null)
  assert.equal(fileRefOf('my file.png', scope), null)
})
