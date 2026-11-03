import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RpcError } from '../src/connection/rpc.mjs'
import { channelFailure } from '../src/device/faults.mjs'
import { createFiles, type FilesHost } from '../src/device/files.mjs'
import { createCore, type FileContent, type FileLinkResolution } from '../src/index.mjs'
import { explicitFileRef, sessionFileScope } from '../src/projection/file-refs.mjs'
import { textToBase64 } from '../src/text/bytes.mjs'
import { fakeOpener, INIT } from './fake-server.mjs'
import { fakeClock, settle } from './helpers.mjs'

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
  f.data.set('/repo/pkg/a.ts', 'a\rb\n')
  f.data.set('/second/a.ts', 'a\nb\r')
  assert.equal((await f.resolve('a.ts')).status, 'choose', '显示文字相同但原始换行不同仍有歧义')
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
  assert.ok(scope)
  assert.deepEqual(explicitFileRef('a.ts', scope)?.candidates, [
    '/tree/sub/a.ts',
    '/repo/a.ts',
    '/second/a.ts',
  ])
})

test('核心按 deviceId 分派同一个根外路径；SSH 会话不会尝试本机', async () => {
  const peers = ['local', 'remote'].map((id) =>
    fakeOpener({
      initialize: () => INIT,
      'runtime/info': () => ({
        engine: 'pi',
        protocolVersion: '0.163.0',
        cliBuild: '0.99.1',
        capabilities: [],
        releaseReady: true,
      }),
      'thread/list': () => ({ data: [], nextCursor: null }),
      'project/list': () => ({ data: [], nextCursor: null }),
      'fs/getMetadata': () => ({
        isFile: true,
        isDirectory: false,
        isSymlink: false,
        createdAtMs: 0,
        modifiedAtMs: 0,
      }),
      'fs/readFile': () => ({ dataBase64: textToBase64(id) }),
    }),
  )
  const local = peers[0],
    remote = peers[1]
  assert.ok(local && remote)
  const core = createCore({
    clock: fakeClock().clock,
    version: '9.9.9',
    devices: [
      {
        id: 'local',
        name: '本机',
        host: 'local',
        kind: 'local',
        target: null,
        wire: 'green',
        open: local.open,
      },
      {
        id: 'remote',
        name: '远程',
        host: 'fixture',
        kind: 'ssh',
        target: { kind: 'host', host: 'fixture', port: 22, user: 'test', keyFile: null },
        wire: 'blue',
        open: remote.open,
      },
    ],
  })
  core.start()
  await settle()
  const signal = { aborted: false, addEventListener() {} }
  try {
    const result = (await core.command(
      'files.resolve',
      {
        deviceId: 'remote',
        root: '/project',
        ref: { path: '/outside/a.txt', alt: null, line: null },
        href: '/outside/a.txt',
      },
      signal,
    )) as FileLinkResolution
    assert.equal(result.status, 'ready')
    const content = (await core.command(
      'files.read',
      { deviceId: 'remote', root: '/outside', path: '/outside/a.txt' },
      signal,
    )) as FileContent
    assert.equal(content.kind === 'text' && content.text, 'remote')
    assert.equal(local.last().seen.filter((call) => call.method.startsWith('fs/')).length, 0)
    assert.ok(remote.last().seen.some((call) => call.method === 'fs/readFile'))
  } finally {
    core.stop()
  }
})
