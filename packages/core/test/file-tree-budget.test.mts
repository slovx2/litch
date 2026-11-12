import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FileRow } from '../src/model-files.mjs'
import {
  createFileTrees,
  FILE_TREE_DIRECTORIES_MAX,
  FILE_TREES_MAX,
  fileKeys,
} from '../src/replica/file-trees.mjs'
import { KeyedStore } from '../src/replica/keyed-store.mjs'
import { settle } from './helpers.mjs'

test('频繁换根回收闲置树，迟到请求不能恢复已回收状态；活动树保留', async () => {
  const store = new KeyedStore()
  let release: ((value: any) => void) | undefined
  const trees = createFileTrees(
    {
      command: async (_name: string, { path }: any) =>
        path === '/slow'
          ? new Promise((resolve) => {
              release = resolve
            })
          : { path, entries: [], total: 0 },
      subscribe: () => () => {},
    } as any,
    store,
  )
  const active = trees.open('device', '/active')
  trees.open('device', '/slow')()
  for (let n = 0; n < FILE_TREES_MAX + 5; n++) trees.open('device', `/root-${n}`)()
  await settle()
  release?.({ path: '/slow', entries: [], total: 0 })
  await settle()
  assert.equal(store.get(fileKeys.tree('device', '/slow')), undefined)
  assert.notEqual(store.get(fileKeys.tree('device', '/active')), undefined)
  assert.notEqual(store.get(fileKeys.tree('device', `/root-${FILE_TREES_MAX + 4}`)), undefined)
  active()
})

test('单树展开、层缓存与监听均有上限，离开全部退订', async () => {
  const store = new KeyedStore()
  let watches = 0,
    peak = 0
  const trees = createFileTrees(
    {
      command: async (_name: string, { path }: any) => ({
        path,
        total: path === '/root' ? 64 : 1,
        entries:
          path === '/root'
            ? Array.from({ length: 64 }, (_, n) => ({ name: `dir-${n}`, kind: 'dir' }))
            : [{ name: 'a.txt', kind: 'file' }],
      }),
      subscribe: () => {
        watches++
        peak = Math.max(peak, watches)
        return () => {
          watches--
        }
      },
    } as any,
    store,
  )
  const close = trees.open('device', '/root')
  await settle()
  for (let n = 0; n < 64; n++) {
    trees.expand('device', '/root', `/root/dir-${n}`)
    await settle()
  }
  const rows = store.get<FileRow[]>(fileKeys.rows('device', '/root')) ?? []
  assert.ok(rows.filter((row) => row.expanded).length < FILE_TREE_DIRECTORIES_MAX)
  assert.ok(peak <= FILE_TREE_DIRECTORIES_MAX)
  close()
  assert.equal(watches, 0)
})
