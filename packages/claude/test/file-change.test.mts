import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileChangeFromTool } from '../src/server-helpers.mjs'

test('Write 新建文件的 diff 为完整内容，覆盖已有文件按更新给出统一 diff', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'file-change-'))
  try {
    const created = join(directory, 'created.txt')
    // 客户端按行统计新增：单行内容只能计 1 行，不能把统一 diff 头部算进去。
    assert.deepEqual(fileChangeFromTool('Write', { file_path: created, content: 'ONE_LINE' }), [
      { path: created, kind: { type: 'add' }, diff: 'ONE_LINE' },
    ])
    const existing = join(directory, 'existing.txt')
    await writeFile(existing, 'old\n')
    const [change] = fileChangeFromTool('Write', { file_path: existing, content: 'new\n' })
    assert.deepEqual(change?.kind, { type: 'update', move_path: null })
    assert.match(change?.diff ?? '', /^-old$/m)
    assert.match(change?.diff ?? '', /^\+new$/m)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
