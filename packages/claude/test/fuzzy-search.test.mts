import assert from 'node:assert/strict'
import test from 'node:test'
import { fuzzyPathMatch } from '../../shared/src/fuzzy-search.mjs'

test('模糊搜索支持非连续字符、大小写和 Unicode 高亮', () => {
  assert.deepEqual(fuzzyPathMatch('bnrd', 'binary.dat')?.indices, [0, 2, 4, 7])
  assert.deepEqual(fuzzyPathMatch('BNRD', 'binary.dat')?.indices, [0, 2, 4, 7])
  assert.deepEqual(fuzzyPathMatch('文件', '📁/文档/文件.txt')?.indices, [2, 6])
  assert.equal(fuzzyPathMatch('absent', 'binary.dat'), null)
  assert.ok(
    (fuzzyPathMatch('binary.dat', 'binary.dat')?.score ?? 0) >
      (fuzzyPathMatch('binary.dat', 'src/binary.data')?.score ?? 0),
  )
})
