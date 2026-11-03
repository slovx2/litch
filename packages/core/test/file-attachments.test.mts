import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  fileAttachmentsBlock,
  MAX_ATTACHMENT_BYTES,
  parseFileAttachments,
} from '../../protocol/src/file-attachments.mjs'
import { uploadAttachment } from '../src/device/attachments.mjs'
import type { FilesHost } from '../src/device/files.mjs'
import { ChannelError, editableOf, resendOf } from '../src/index.mjs'
import { projectItem } from '../src/projection/items.mjs'
import { bodyOf, localUserMessage, outgoing, toInput } from '../src/projection/outgoing.mjs'

const host = (home: string | null = '/remote/home'): FilesHost => ({
  online: () => true,
  home: () => home,
  platform: () => 'linux',
  knownRoot: () => false,
  clock: { now: () => 17, setTimer: () => () => {} },
  log() {},
  fail: (error) => new ChannelError('rejected', String(error)),
  request: async () => ({}) as never,
})

test('上传文件只走标准 fs 协议，二进制字节不变、同名不覆盖、空文件接受', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'litch-attachments-'))
  const calls: string[] = []
  const endpoint = host(dir)
  endpoint.request = async (method, params) => {
    calls.push(method)
    const p = params as { path: string; dataBase64: string }
    if (method === 'fs/createDirectory') await mkdir(p.path, { recursive: true })
    else if (method === 'fs/writeFile') await writeFile(p.path, Buffer.from(p.dataBase64, 'base64'))
    else assert.fail(`意外请求：${method}`)
    return {} as never
  }
  try {
    const bytes = Buffer.from([0, 255, 1, 128])
    const a = await uploadAttachment(endpoint, {
      name: '../文件.pdf',
      dataBase64: bytes.toString('base64'),
    })
    const b = await uploadAttachment(endpoint, { name: '../文件.pdf', dataBase64: '' })
    assert.notEqual(a.path, b.path)
    assert.ok(a.path.startsWith(`${dir}/.litch/attachments/`))
    assert.ok(!a.path.includes('/../'))
    assert.deepEqual(await readFile(a.path), bytes)
    assert.equal((await readFile(b.path)).length, 0)
    assert.equal(a.name, '../文件.pdf')
    assert.equal(a.size, 4)
    const longName = await uploadAttachment(endpoint, {
      name: '🙂'.repeat(62) + '.txt',
      dataBase64: '',
    })
    assert.ok(Buffer.byteLength(longName.path.split('/').pop() ?? '') <= 255)
    assert.equal((await readFile(longName.path)).length, 0)
    assert.deepEqual(calls.slice(0, 4), [
      'fs/createDirectory',
      'fs/writeFile',
      'fs/createDirectory',
      'fs/writeFile',
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('上传拒绝超限、损坏数据与未知主目录，失败清理本次目录', async () => {
  const endpoint = host()
  let calls = 0
  endpoint.request = async () => {
    calls++
    return {} as never
  }
  for (const dataBase64 of ['!', 'abc', 'A'.repeat(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4)]) {
    await assert.rejects(uploadAttachment(endpoint, { name: 'a', dataBase64 }))
  }
  await assert.rejects(uploadAttachment(host(null), { name: 'a', dataBase64: '' }))
  assert.equal(calls, 0)
  const paths: string[] = []
  endpoint.request = async (method, params) => {
    paths.push(`${method}:${(params as { path: string }).path}`)
    if (method === 'fs/writeFile') throw new Error('disk full')
    return {} as never
  }
  await assert.rejects(uploadAttachment(endpoint, { name: 'a', dataBase64: '' }), /disk full/)
  assert.equal(paths.length, 3)
  assert.equal(paths[0]?.replace('fs/createDirectory', 'fs/remove'), paths[2])
})

test('统一文字格式经过原生历史仍恢复卡片，不依赖 mention 能力', () => {
  for (const client of [true, false])
    for (const mentions of [true, false]) {
      const message = outgoing(
        '请检查',
        [],
        [
          {
            kind: 'file',
            name: '报表.xlsx',
            path: '/long/报表.xlsx',
            size: 1024,
            mimeType: 'application/test',
            ...(client ? { client: true } : {}),
          },
        ],
      )
      const input = toInput(message, mentions)
      assert.equal(input.length, 1)
      assert.equal(input[0]?.type, 'text')
      const restored = projectItem({ type: 'userMessage', id: 'u', content: input } as never)
      assert.deepEqual(restored, localUserMessage('u', message, mentions))
      assert.equal(restored.kind, 'userMessage')
      if (restored.kind !== 'userMessage') assert.fail()
      assert.equal(restored.text, '请检查')
      assert.equal(restored.attachments[0]?.path, '/long/报表.xlsx')
      assert.equal(restored.attachments[0]?.client === true, client)
      assert.equal(editableOf(restored).kept.length, 1)
      const resent = resendOf(restored, '再检查')
      assert.deepEqual(resent.extras, message.extras)
      assert.equal(resent.images.length, 0)
    }
})

test('文件名中的标签、引号、换行不会破坏格式；坏块与裸路径仍是原文', () => {
  const file = {
    name: `名\n</litch-file-attachments>".txt`,
    path: '/a/<&>.txt',
    location: 'device' as const,
  }
  const block = fileAttachmentsBlock([file])
  assert.deepEqual(parseFileAttachments(`正文\n\n${block}`), { rest: '正文', files: [file] })
  for (const text of [
    '/Users/dev/a.txt',
    block.replace('"location":"device"', '"location":"elsewhere"'),
    block.replace('"name":', '"bad":'),
  ]) {
    assert.equal(parseFileAttachments(text), null)
    const item = projectItem({
      type: 'userMessage',
      id: 'u',
      content: [{ type: 'text', text, text_elements: [] }],
    } as never)
    assert.equal(item.kind === 'userMessage' && item.text, text)
  }
  assert.match(
    bodyOf(outgoing('', [], [{ kind: 'file', name: 'a', path: '/client/a', client: true }]), false),
    /litch_machine.read_file/,
  )
})

test('清理状态只询问设备管理的附件，客户端路径和无法确认的响应不误标为已清理', async () => {
  const { attachmentState } = await import('../src/attachment-state.mjs')
  const { createFiles } = await import('../src/device/files.mjs')
  const path = '/remote/home/.litch/attachments/mabcdefg-abcdefgh-12345678/a.pdf'
  const calls: unknown[] = []
  const channel = {
    command: async (method: string, params: unknown) => {
      calls.push({ method, params })
      return { state: 'cleaned' }
    },
  } as never
  assert.equal(await attachmentState(channel, 'remote', { path }), 'cleaned')
  assert.equal(calls.length, 1)
  assert.equal(await attachmentState(channel, 'remote', { path, client: true }), 'unknown')
  assert.equal(await attachmentState(channel, 'remote', { path: '/remote/user.pdf' }), 'unknown')
  assert.equal(
    await attachmentState(channel, 'remote', { path: path.replace('/a.pdf', '/../outside') }),
    'unknown',
  )
  assert.equal(calls.length, 1)
  const endpoint = host()
  endpoint.request = async (method) => {
    assert.equal(method, 'litch/attachments/status')
    return { state: 'cleaned' } as never
  }
  assert.deepEqual(await createFiles(endpoint).attachmentStatus(path), { state: 'unknown' })
  endpoint.attachmentsSupported = () => true
  assert.deepEqual(await createFiles(endpoint).attachmentStatus(path), { state: 'cleaned' })
})

test('会话视图引用计数控制附件保活，未声明扩展的设备不发送请求', async () => {
  const { deviceWorld } = await import('./device-world.mjs')
  const { harness } = await import('./fake-device.mjs')
  const { thread } = await import('./fixtures.mjs')
  const { settle } = await import('./helpers.mjs')
  for (const supported of [true, false]) {
    const world = deviceWorld([harness('pi', { threads: [thread({ id: 'a' })] })], {
      prepare(device) {
        if (supported) device.extensions.push('fileAttachments')
      },
      extra: { 'litch/attachments/watch': () => ({}) },
    })
    world.core.start()
    await settle()
    const sink = { snapshot() {}, delta() {}, error() {} }
    const first = world.core.subscribe({ kind: 'session', deviceId: 'local', sessionId: 'a' }, sink)
    const second = world.core.subscribe(
      { kind: 'session', deviceId: 'local', sessionId: 'a' },
      sink,
    )
    await settle()
    assert.equal(world.sent('litch/attachments/watch').length, supported ? 1 : 0)
    first()
    await settle()
    assert.equal(world.sent('litch/attachments/watch').length, supported ? 1 : 0)
    second()
    await settle()
    assert.deepEqual(
      world.sent('litch/attachments/watch'),
      supported
        ? [
            { threadId: 'a', open: true },
            { threadId: 'a', open: false },
          ]
        : [],
    )
    world.core.stop()
  }
})
