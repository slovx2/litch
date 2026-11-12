import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FilesystemRpc } from '../../shared/src/filesystem-rpc.mjs'
import { RpcError } from '../src/connection/rpc.mjs'
import { channelFailure } from '../src/device/faults.mjs'
import { createFiles } from '../src/device/files.mjs'
import { fakeClock } from './helpers.mjs'

test('显式软链解析同设备真实目标；文档自动资源仍拒绝跨真实根', async () => {
  const root = await mkdtemp(join(tmpdir(), 'litch-explicit-link-'))
  const project = join(root, 'project'),
    outside = join(root, 'outside')
  await Promise.all([mkdir(project), mkdir(outside)])
  const target = join(outside, 'note.txt'),
    link = join(project, 'note.txt')
  await writeFile(target, '真实目标')
  await symlink(target, link)
  await symlink(outside, join(project, 'folder'))
  await symlink(project, join(project, 'loop'))
  const rpc = new FilesystemRpc(),
    peer = { id: 'ui', send() {}, close() {} }
  rpc.declare(peer, {
    capabilities: { litchExtensions: ['fileBrowser', 'fileRealpath', 'filePreview', 'shortMedia'] },
  })
  const files = createFiles({
    clock: fakeClock().clock,
    online: () => true,
    platform: () => 'macos',
    home: () => root,
    browserSupported: () => true,
    realpathSupported: () => true,
    shortMediaSupported: () => true,
    previewSupported: () => true,
    knownRoot: () => false,
    log() {},
    fail: channelFailure,
    request: async (method, params) => {
      try {
        return (await rpc.call(peer, method, params as Record<string, unknown>)) as any
      } catch (error: any) {
        throw new RpcError(error.code ?? -32603, error.message, error.data)
      }
    },
  })
  const result = await files.resolve(project, { path: link, line: null, alt: null }, link)
  assert.equal(result.status, 'ready')
  assert.deepEqual(result.candidates[0], {
    root: await realpath(outside),
    path: await realpath(target),
    kind: 'file',
    linkPath: link,
  })
  assert.equal((await files.preview(project, link, 'source')).kind, 'outside')
  const dir = await files.target(project, join(project, 'folder'))
  assert.equal(dir.root, await realpath(outside))
  assert.equal(dir.kind, 'directory')
  assert.equal((await files.target(project, join(project, 'loop'))).root, await realpath(project))
  const standard = (await rpc.call({ id: 'official', send() {}, close() {} }, 'fs/getMetadata', {
    path: link,
  })) as any
  assert.equal(standard.isSymlink, true)
  assert.equal(standard.litchResolved, undefined)
  await assert.rejects(
    rpc.call({ id: 'official', send() {}, close() {} }, 'fs/getMetadata', {
      path: link,
      litchResolve: true,
    }),
    /fileRealpath/,
  )
  rpc.close()
})
