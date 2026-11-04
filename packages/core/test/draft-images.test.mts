import assert from 'node:assert/strict'
import test from 'node:test'
import { DRAFT_IMAGE_LIMIT, type DraftImageEntries, DraftImages } from '../src/draft-images.mjs'

const image = { url: 'data:image/png;base64,AAAA', name: '截图.png' }
test('图片草稿跨实例还原，发送清空后删除持久文件，不影响其他草稿', () => {
  let disk: DraftImageEntries | null = null
  const storage = {
    read: () => disk && structuredClone(disk),
    write: (entries: DraftImageEntries) => {
      disk = structuredClone(entries)
    },
    remove: () => {
      disk = null
    },
  }
  const first = new DraftImages(storage)
  assert.equal(first.save('a', [image]), null)
  first.save('b', [image])
  const reopened = new DraftImages(storage)
  assert.deepEqual(reopened.load('a'), [image])
  reopened.save('a', [])
  assert.deepEqual(new DraftImages(storage).load('a'), [])
  assert.deepEqual(new DraftImages(storage).load('b'), [image])
  reopened.save('b', [])
  assert.equal(disk, null)
})

test('超过总上限不丢当前内存图片、不淘汰其他草稿，旧版本不再重现', () => {
  let disk: DraftImageEntries | null = null
  const drafts = new DraftImages({
    read: () => disk,
    write: (entries) => {
      disk = entries
    },
    remove: () => {
      disk = null
    },
  })
  drafts.save('a', [image])
  drafts.save('b', [image])
  const huge = { ...image, url: `data:image/png;base64,${'A'.repeat(DRAFT_IMAGE_LIMIT)}` }
  assert.equal(drafts.save('a', [huge]), 'limit')
  assert.deepEqual(disk, [['b', [image]]])
  assert.equal(drafts.load('a')[0], huge)
  assert.equal(drafts.save('a', [image]), null)
})

test('磁盘写入失败可明确提示且当前草稿仍然可发送', () => {
  const drafts = new DraftImages({
    read: () => null,
    write: () => {
      throw new Error('disk full')
    },
    remove() {},
  })
  assert.equal(drafts.save('a', [image]), 'write')
  assert.deepEqual(drafts.load('a'), [image])
})
