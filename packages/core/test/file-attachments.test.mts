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
