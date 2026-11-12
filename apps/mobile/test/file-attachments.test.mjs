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
test('离线选文件只读本地并清除缓存副本；附件内容草稿可恢复', async () => {
  select()
  const result = await pickFile()
  assert.equal(result.dataBase64, 'AP8B')
  assert.match(result.path, /^draft:/)
  assert.equal(files.has('cache:attachment'), false)
  saveDraftFiles('draft', [result])
  assert.deepEqual(loadDraftFiles('draft'), [result])
  saveDraftFiles('draft', [])
  assert.deepEqual(loadDraftFiles('draft'), [])
})
test('取消、超限、失败没有假附件；图片走原有 data URL', async () => {
  setResult({ canceled: true, assets: null })
  assert.equal(await pickFile(), null)
  select('big', 'application/pdf', MAX_ATTACHMENT_BYTES + 1)
  await assert.rejects(pickFile(), /fileTooLarge/)
  assert.equal(files.has('cache:attachment'), false)
  select('a.png', 'image/png')
  assert.deepEqual(await pickFile(), {
    kind: 'image',
    name: 'a.png',
    url: 'data:image/png;base64,AP8B',
  })
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
