import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { IMAGE_BYTES } from '../../protocol/src/media-images.mjs'
import { DeviceServer } from '../src/device.mjs'
import { downloadImage, MediaImages, publicAddress } from '../src/media-images.mjs'
import { listenUnix } from '../src/sockets.mjs'
import { TestClient } from './helpers.mjs'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xoAAAAASUVORK5CYII=',
  'base64',
)

test('公网地址拒绝本机、私网、链路本地、映射 IPv6、保留地址与不同拼写', () => {
  for (const ip of [
    '127.0.0.1',
    '0.0.0.0',
    '10.1.2.3',
    '172.31.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.1.2',
    '198.18.1.1',
    '192.0.2.1',
    '224.1.1.1',
    '255.255.255.255',
    '::1',
    '::ffff:127.0.0.1',
    'fe80::1',
    'fc00::1',
    '2001:db8::1',
    '2001:0db8::1',
    '2002:7f00:1::',
  ])
    assert.equal(publicAddress(ip), false, ip)
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])
    assert.equal(publicAddress(ip), true, ip)
})

type Network = NonNullable<Parameters<typeof downloadImage>[2]>
function network(
  replies: { status?: number; headers?: Record<string, string>; body?: Buffer }[],
  ips = ['8.8.8.8'],
) {
  const calls: { url: string; headers: unknown; address: string }[] = []
  const dns: string[] = []
  const request = ((url: URL, options: any, receive: (res: any) => void) => {
    const req = new EventEmitter() as EventEmitter & { end(): void }
    req.end = () =>
      queueMicrotask(() => {
        const response = replies.shift() ?? {}
        const stream = Object.assign(new PassThrough(), {
          statusCode: response.status ?? 200,
          headers: response.headers ?? { 'content-type': 'image/png' },
        })
        options.lookup(url.hostname, {}, (_error: unknown, address: string) =>
          calls.push({ url: String(url), headers: options.headers, address }),
        )
        receive(stream)
        stream.end(response.body ?? PNG)
      })
    return req
  }) as Network['httpRequest']
  const lookup = (async (host: string) => {
    dns.push(host)
    return ips.map((address) => ({ address, family: 4 }))
  }) as unknown as Network['lookup']
  return {
    io: { lookup, httpRequest: request, httpsRequest: request as Network['httpsRequest'] },
    calls,
    dns,
  }
}

test('下载先 DNS 检查，连接固定 IP，跳转逐次检查且没有 Cookie/Referer/Authorization', async () => {
  const fixture = network([
    { status: 302, headers: { location: 'https://two.example/image' } },
    { body: PNG },
  ])
  assert.deepEqual(
    await downloadImage('https://one.example/image', new AbortController().signal, fixture.io),
    PNG,
  )
  assert.deepEqual(fixture.dns, ['one.example', 'two.example'])
  assert.equal(fixture.calls.length, 2)
  for (const call of fixture.calls) {
    assert.equal(call.address, '8.8.8.8')
    assert.deepEqual(call.headers, { Accept: 'image/*', 'Accept-Encoding': 'identity' })
  }
  const privateDns = network([], ['8.8.8.8', '127.0.0.1'])
  await assert.rejects(
    downloadImage('https://one.example/image', new AbortController().signal, privateDns.io),
  )
  assert.equal(privateDns.calls.length, 0)
  const redirected = network([
    { status: 302, headers: { location: 'http://169.254.169.254/image' } },
  ])
  await assert.rejects(
    downloadImage('https://one.example/image', new AbortController().signal, redirected.io),
  )
  assert.equal(redirected.calls.length, 1)
})

test('下载拒绝非图片、压缩响应、错误状态、无限跳转、超限；DNS 可取消', async () => {
  for (const reply of [
    { headers: { 'content-type': 'text/html' } },
    { headers: { 'content-type': 'image/png', 'content-encoding': 'gzip' } },
    { headers: { 'content-type': 'image/png', 'content-length': String(IMAGE_BYTES + 1) } },
    { status: 404 },
    { body: Buffer.alloc(IMAGE_BYTES + 1) },
  ]) {
    const fixture = network([reply])
    await assert.rejects(
      downloadImage('https://one.example/image', new AbortController().signal, fixture.io),
    )
  }
  const loop = network(
    Array.from({ length: 5 }, () => ({ status: 302, headers: { location: '/again' } })),
  )
  await assert.rejects(
    downloadImage('https://one.example/image', new AbortController().signal, loop.io),
  )
  assert.equal(loop.calls.length, 5)
  const controller = new AbortController()
  const fixture = network([])
  fixture.io.lookup = (() => new Promise(() => {})) as Network['lookup']
  const pending = downloadImage('https://one.example/image', controller.signal, fixture.io)
  controller.abort()
  await assert.rejects(pending)
  assert.equal(fixture.calls.length, 0)
})

test('本地按内容判断：无扩展名、根外链接、非媒体只读 4 KiB 头、超限不读正文', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'litch-media-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const images = new MediaImages()
  const image = join(root, 'image.dat'),
    fake = join(root, 'fake.png'),
    link = join(root, 'link.png')
  await writeFile(image, PNG)
  await writeFile(fake, 'not an image'.repeat(10000))
  await symlink(image, link)
  assert.equal((await images.read('a', image)).kind, 'ready')
  assert.equal((await images.read('a', link)).kind, 'ready')
  const probe = await open(fake, 'r'),
    prototype = Object.getPrototypeOf(probe),
    original = prototype.read
  await probe.close()
  let bytes = 0
  t.mock.method(prototype, 'read', async function (this: unknown, ...args: unknown[]) {
    const result = await original.apply(this, args)
    bytes += result.bytesRead
    return result
  })
  assert.equal((await images.read('a', fake)).kind, 'notFile')
  assert.equal(bytes, 4096)
  const large = await open(join(root, 'large.png'), 'w')
  await large.truncate(IMAGE_BYTES + 1)
  await large.close()
  assert.equal((await images.read('a', join(root, 'large.png'))).kind, 'tooLarge')
  assert.equal(bytes, 4096)
  assert.equal((await images.read('a', `${root}/../image.dat`)).kind, 'invalid')
  assert.equal((await images.read('a', `${root}/a\t.png`)).kind, 'invalid')
  assert.equal((await images.read('a', root)).kind, 'notFile')
})

test('真实设备连接：mediaImages 独立声明，未声明拒绝，标准读取形状不变', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lmi-'))
  const file = join(root, 'extensionless')
  await writeFile(file, PNG)
  const server = new DeviceServer({ stateDir: join(root, 'state'), upstreams: [] })
  const socket = join(root, 'device.sock')
  const listener = await listenUnix(socket, (wire) => server.attach(wire))
  const modern = await TestClient.overSocket(socket),
    old = await TestClient.overSocket(socket)
  t.after(async () => {
    modern.close()
    old.close()
    await listener.close()
    await server.close()
    await rm(root, { recursive: true, force: true })
  })
  await modern.initialize(['harness', 'mediaImages'])
  await old.initialize(['harness'])
  assert((await modern.call('runtime/info')).device.extensions.includes('mediaImages'))
  const result = await modern.call('litch/media/readImage', { source: file })
  assert.equal(result.kind, 'ready')
  assert.equal(result.dataBase64, PNG.toString('base64'))
  await old.fails('litch/media/readImage', { source: file })
  assert.deepEqual(await old.call('fs/readFile', { path: file }), {
    dataBase64: PNG.toString('base64'),
  })
})
