import assert from 'node:assert/strict'
import { mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  BROWSER_UPLOAD_EXTENSION,
  BROWSER_UPLOAD_METHOD,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_SOURCE_MAX_BYTES,
} from '../../protocol/src/browser-upload.mjs'
import { EXTENSION } from '../../protocol/src/device.mjs'
import { readUploadSource } from '../src/browser-upload.mjs'
import { DeviceCalls, DeviceLayer } from '../src/device-layer.mjs'
import { FakeUpstream } from './fake-upstream.mjs'
import { REPO, rig } from './helpers.mjs'

test('浏览器上传扩展：协议定义、读取路由及 runtime/info 的支持声明一致', async () => {
  const definition = JSON.parse(
    await readFile(join(REPO, 'protocol/extensions/browser-upload.json'), 'utf8'),
  )
  assert.equal(definition.extension, BROWSER_UPLOAD_EXTENSION)
  assert.equal(EXTENSION.browserUpload, BROWSER_UPLOAD_EXTENSION)
  assert.deepEqual(definition.declaration.schema.contains, { const: BROWSER_UPLOAD_EXTENSION })
  assert.deepEqual(
    definition.parts.map((part: { method: string }) => part.method),
    [BROWSER_UPLOAD_METHOD],
  )
  assert.equal(definition.parts[0].params.oneOf[1].properties.length.maximum, UPLOAD_CHUNK_BYTES)
  assert.equal(definition.parts[0].response.properties.size.maximum, UPLOAD_SOURCE_MAX_BYTES)
  const env = rig({ pi: new FakeUpstream('pi') })
  try {
    const client = env.connect()
    await client.initialize(['harness'])
    const info = await client.call('runtime/info', {})
    assert.ok(info.device.extensions.includes(BROWSER_UPLOAD_EXTENSION))
  } finally {
    await env.close()
  }
})

test('上传源可靠元数据、分块、空文件、路径/范围/大小限制及修改或替换检测', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'litch-upload-device-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'source.txt')
  const bytes = Buffer.alloc(UPLOAD_CHUNK_BYTES + 3, 71)
  await writeFile(path, bytes)
  const source = await readUploadSource({ action: 'stat', path })
  assert.equal(source.size, bytes.length)
  assert.ok(source.version)
  const chunk = await readUploadSource({
    action: 'read',
    path,
    version: source.version,
    offset: UPLOAD_CHUNK_BYTES,
    length: 3,
  })
  assert.deepEqual(Buffer.from(chunk.dataBase64!, 'base64'), bytes.subarray(UPLOAD_CHUNK_BYTES))
  for (const request of [
    { action: 'stat', path: 'relative' },
    { action: 'stat', path: root },
    { action: 'stat', path: join(root, 'missing') },
    { action: 'read', path, version: source.version, offset: 0, length: UPLOAD_CHUNK_BYTES + 1 },
    { action: 'read', path, version: source.version, offset: -1, length: 1 },
    { action: 'read', path, version: source.version, offset: bytes.length, length: 1 },
  ])
    await assert.rejects(readUploadSource(request))
  await writeFile(path, Buffer.alloc(bytes.length, 72))
  await assert.rejects(
    readUploadSource({ action: 'read', path, version: source.version, offset: 0, length: 1 }),
    /changed/,
  )
  const second = await readUploadSource({ action: 'stat', path })
  await rename(path, join(root, 'old.txt'))
  await writeFile(path, Buffer.alloc(bytes.length, 72))
  await assert.rejects(
    readUploadSource({ action: 'read', path, version: second.version, offset: 0, length: 1 }),
    /changed/,
  )
  await writeFile(path, '')
  const empty = await readUploadSource({ action: 'stat', path })
  assert.equal(
    (await readUploadSource({ action: 'read', path, version: empty.version, offset: 0, length: 0 }))
      .dataBase64,
    '',
  )
  const file = await open(path, 'w')
  await file.truncate(UPLOAD_SOURCE_MAX_BYTES + 1)
  await file.close()
  await assert.rejects(readUploadSource({ action: 'stat', path }), /512 MiB/)
})

test('未声明 litchBrowserUpload 的连接不可读取，标准 fs 路由不变', async () => {
  const layer = new DeviceLayer()
  try {
    const calls = new DeviceCalls(layer, {
      id: 'undeclared',
      send() {},
      close() {},
      declares: () => false,
      backlog: () => 0,
    })
    assert.throws(
      () => calls.call('litch/browserUpload/read', { action: 'stat', path: '/no-file' }),
      /Declare litchBrowserUpload/,
    )
  } finally {
    await layer.close()
  }
})
