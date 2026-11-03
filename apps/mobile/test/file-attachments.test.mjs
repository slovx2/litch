import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_ATTACHMENT_BYTES } from '@litch/core'
import { setResult } from 'expo-document-picker'
import { files } from 'expo-file-system'
import { loadDraftFiles, saveDraftFiles } from '../src/detail/composer/drafts.ts'
import { pickFile } from '../src/detail/composer/files.ts'

const select = (name = '报告.pdf', mimeType = 'application/pdf', size = 3) => {
  files.set('cache:attachment', Buffer.from([0, 255, 1]))
  setResult({ canceled: false, assets: [{ name, uri: 'cache:attachment', mimeType, size }] })
}
test('手机选文件上传至会话设备，保留字节并清除缓存副本；文件引用草稿可恢复', async () => {
  select()
  const calls = []
  const result = await pickFile(
    {
      command: async (method, params) => {
        calls.push([method, params])
        return { kind: 'file', name: params.name, path: '/remote/file.pdf', size: 3 }
      },
    },
    'remote',
  )
  assert.equal(calls[0][0], 'files.uploadAttachment')
  assert.equal(calls[0][1].deviceId, 'remote')
  assert.equal(calls[0][1].dataBase64, 'AP8B')
  assert.equal(files.has('cache:attachment'), false)
  saveDraftFiles('draft', [result])
  assert.deepEqual(loadDraftFiles('draft'), [result])
  saveDraftFiles('draft', [])
  assert.deepEqual(loadDraftFiles('draft'), [])
})
test('取消、超限、失败没有假附件；图片走原有 data URL', async () => {
  let calls = 0
  const channel = {
    command: async () => {
      calls++
      throw new Error('offline')
    },
  }
  setResult({ canceled: true, assets: null })
  assert.equal(await pickFile(channel, 'd'), null)
  select('big', 'application/pdf', MAX_ATTACHMENT_BYTES + 1)
  await assert.rejects(pickFile(channel, 'd'), /fileTooLarge/)
  assert.equal(calls, 0)
  assert.equal(files.has('cache:attachment'), false)
  select()
  await assert.rejects(pickFile(channel, 'd'), /offline/)
  assert.equal(files.has('cache:attachment'), false)
  select('a.png', 'image/png')
  assert.deepEqual(await pickFile(channel, 'd'), {
    kind: 'image',
    name: 'a.png',
    url: 'data:image/png;base64,AP8B',
  })
  assert.equal(calls, 1)
})

test('编辑发送失败的文件引用经回填事件保留', async () => {
  const { refillDraft, onRefill } = await import('../src/detail/refill.ts')
  const message = {
    text: '再试',
    images: [],
    files: [{ kind: 'file', name: 'a', path: '/remote/a' }],
  }
  refillDraft('remote', 'thread', message)
  let restored
  const stop = onRefill('remote', 'thread', (m) => {
    restored = m
  })
  assert.deepEqual(restored, message)
  stop()
})
