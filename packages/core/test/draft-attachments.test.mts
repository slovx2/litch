import assert from 'node:assert/strict'
import test from 'node:test'
import type { CoreChannel } from '../src/channel/client.mjs'
import { stageAttachment, uploadDraftAttachments } from '../src/draft-attachments.mjs'
import { outgoing } from '../src/projection/outgoing.mjs'

test('附件在本地暂存，发送前上传到目标设备；正文和队列不接收未上传内容', async () => {
  const staged = stageAttachment('nebula.bin', 'AP8B', 'application/octet-stream')
  assert.match(staged.path, /^draft:/)
  assert.equal(staged.dataBase64, 'AP8B')
  assert.throws(() => outgoing('检查附件', [], [staged]), /本地附件尚未上传/)
  const seen: unknown[] = []
  const channel = {
    async command(name: string, params: unknown) {
      seen.push({ name, params })
      return { kind: 'file', name: 'nebula.bin', path: '/srv/nebula/attachments/file.bin' }
    },
  } as unknown as CoreChannel
  const ready = await uploadDraftAttachments(channel, 'remote', [staged])
  assert.deepEqual(seen, [
    {
      name: 'files.uploadAttachment',
      params: {
        deviceId: 'remote',
        name: 'nebula.bin',
        dataBase64: 'AP8B',
        mimeType: 'application/octet-stream',
      },
    },
  ])
  assert.equal(ready[0]?.kind === 'file' && ready[0].dataBase64, undefined)
  assert.equal(staged.dataBase64, 'AP8B', '发送不修改原草稿，失败时仍可回填')
  assert.doesNotThrow(() => outgoing('检查附件', [], ready))
})

test('上传失败保留本地草稿；现有设备/控制端引用和图片不触发上传', async () => {
  const staged = stageAttachment('nebula.txt', 'YQ==')
  const channel = {
    command: async () => {
      throw new Error('offline')
    },
  } as unknown as CoreChannel
  await assert.rejects(uploadDraftAttachments(channel, 'remote', [staged]), /offline/)
  assert.equal(staged.dataBase64, 'YQ==')
  const ref = { kind: 'file' as const, name: 'nebula.txt', path: '/srv/nebula/a.txt' }
  assert.deepEqual(await uploadDraftAttachments(channel, 'remote', [ref]), [ref])
})
