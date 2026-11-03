import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RpcError } from '../src/connection/rpc.mjs'
import { channelFailure } from '../src/device/faults.mjs'
import { createFiles, type FilesHost } from '../src/device/files.mjs'
import { explicitFileRef, sessionFileScope } from '../src/projection/file-refs.mjs'
import { textToBase64 } from '../src/text/bytes.mjs'
import { fakeClock } from './helpers.mjs'

function fixture(home: string | null = '/remote/home') {
  const data = new Map<string, string>()
  const seen: string[] = []
  let online = true
  const host: FilesHost = {
    clock: fakeClock().clock,
    online: () => online,
    platform: () => 'linux',
    home: () => home,
    knownRoot: () => false,
    previewSupported: () => false,
    fail: channelFailure,
    log() {},
    request: async (method, params) => {
      const path = (params as { path: string }).path
      seen.push(path)
      if (path.includes('denied')) throw new RpcError(-32603, 'EACCES: permission denied')
      if (!data.has(path)) throw new RpcError(-32603, 'ENOENT: no such file')
      return (
        method === 'fs/getMetadata'
          ? { isFile: true, isDirectory: false, isSymlink: false, createdAtMs: 0, modifiedAtMs: 0 }
          : { dataBase64: textToBase64(data.get(path) ?? '') }
      ) as never
    },
  }
  const files = createFiles(host)
  const scope = { root: '/repo', cwd: '/repo/pkg', roots: ['/repo', '/second'] }
  const resolve = (href: string) => {
    const ref = explicitFileRef(href, scope)
    assert.ok(ref)
    return files.resolve(scope.root, ref, href)
  }
  return {
    data,
    seen,
    files,
    resolve,
    offline() {
      online = false
    },
  }
}

test('同设备根外、home 与旧服务：只用标准 fs；不读取客户端 home', async () => {
  const f = fixture()
  f.data.set('/outside/result.md', 'done')
  f.data.set('/remote/home/result.md', 'home')
  assert.equal((await f.resolve('/outside/result.md')).candidates[0]?.root, '/outside')
  assert.equal((await f.resolve('~/result.md')).candidates[0]?.path, '/remote/home/result.md')
  assert.equal(
    (await f.files.preview('/outside', '/outside/result.md', 'markdown')).kind,
    'unsupported',
  )
  assert.deepEqual((await fixture(null).resolve('~/result.md')).failures, [
    { path: '~/result.md', reason: 'home' },
  ])
})

test('cwd → 全部项目根；内容不同要求选择，相同文本用 cwd；缺失不拦其他候选', async () => {
  const f = fixture()
  f.data.set('/second/a.ts', 'two')
  const found = await f.resolve('a.ts:12')
  assert.equal(found.status, 'ready')
  assert.deepEqual(found.attempted, ['/repo/pkg/a.ts', '/repo/a.ts', '/second/a.ts'])
  f.data.set('/repo/pkg/a.ts', 'one')
  assert.equal((await f.resolve('a.ts')).status, 'choose')
  f.data.set('/repo/pkg/a.ts', 'two')
  assert.equal((await f.resolve('a.ts')).status, 'ready')
  assert.equal((await f.resolve('a.ts')).candidates[0]?.path, '/repo/pkg/a.ts')
})

test('不存在、权限和离线各有原因，不把权限错误当不存在', async () => {
  const f = fixture()
  assert.equal((await f.resolve('/outside/a.ts')).failures[0]?.reason, 'missing')
  assert.equal((await f.resolve('/denied/a.ts')).failures[0]?.reason, 'permission')
  f.offline()
  assert.equal((await f.resolve('/outside/a.ts')).failures[0]?.reason, 'offline')
})

test('工作树决定默认文件树，项目的全部根仍保留', () => {
  const scope = sessionFileScope(
    { cwd: '/tree/sub', worktree: { state: 'ready', path: '/tree' } },
    ['/repo', '/second'],
  )
  assert.equal(scope?.root, '/tree')
  assert.deepEqual(scope?.roots, ['/repo', '/second'])
  assert.deepEqual(explicitFileRef('a.ts', scope!)?.candidates, [
    '/tree/sub/a.ts',
    '/repo/a.ts',
    '/second/a.ts',
  ])
})
