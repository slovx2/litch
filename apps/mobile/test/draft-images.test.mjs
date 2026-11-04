import assert from 'node:assert/strict'
import test from 'node:test'
import { files } from './stubs/expo-file-system.mjs'

test('手机图片草稿重开还原，发出或删除后清理应用文档目录', async () => {
  files.clear()
  const first = await import('../src/detail/composer/drafts.ts?images=first')
  const image = { url: 'data:image/png;base64,AAAA', name: '截图.png' }
  assert.equal(first.saveDraftImages('device:thread', [image]), null)
  assert.equal(files.has('doc:/draft-images.json'), true)
  const reopened = await import('../src/detail/composer/drafts.ts?images=reopened')
  assert.deepEqual(reopened.loadDraftImages('device:thread'), [image])
  reopened.dropDraft('device:thread')
  assert.equal(files.has('doc:/draft-images.json'), false)
  const again = await import('../src/detail/composer/drafts.ts?images=again')
  assert.deepEqual(again.loadDraftImages('device:thread'), [])
})
