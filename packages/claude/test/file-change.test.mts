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

test('Edit 的 diff 带行号和行数的 hunk 头（客户端靠它认出补丁、给增删染色），空行照留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'file-change-'))
  try {
    const file = join(directory, 'core.py')
    await writeFile(file, 'a\nb\nold1\n\nold2\nz\n')
    // 还没改：按旧文字找到第 3 行
    const [before] = fileChangeFromTool('Edit', {
      file_path: file,
      old_string: 'old1\n\nold2',
      new_string: 'new1\nnew2',
    })
    assert.equal(
      before?.diff,
      `--- a/${file}\n+++ b/${file}\n@@ -3,3 +3,2 @@\n-old1\n-\n-old2\n+new1\n+new2\n`,
    )
    // 已经改完了（调用来晚了）：按新文字找
    await writeFile(file, 'a\nb\nnew1\nnew2\nz\n')
    const [after] = fileChangeFromTool('Edit', {
      file_path: file,
      old_string: 'old1\n\nold2',
      new_string: 'new1\nnew2',
    })
    assert.match(after?.diff ?? '', /^@@ -3,3 \+3,2 @@$/m)
    // 文件读不到：从第 1 行算，照样是能认出的补丁
    const [missing] = fileChangeFromTool('Edit', {
      file_path: join(directory, 'gone.py'),
      old_string: 'x',
      new_string: '',
    })
    assert.match(missing?.diff ?? '', /^@@ -1,1 \+0,0 @@$/m)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
