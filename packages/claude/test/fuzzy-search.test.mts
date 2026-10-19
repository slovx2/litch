import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fuzzyPathMatch } from '../../shared/src/fuzzy-search.mjs'
import { windowsFiles } from '../../shared/src/fuzzy-session.mjs'

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

test('Windows 上没有 rg：仓库里按 gitignore 用 git 列，不在仓库里自己遍历并跳过 .git', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'litch-fuzzy-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const put = (path: string) => {
    mkdirSync(join(base, path, '..'), { recursive: true })
    writeFileSync(join(base, path), 'x')
  }
  const repo = join(base, 'repo')
  for (const path of ['repo/src/a.ts', 'repo/中文 名.md', 'repo/dist/out.js', 'repo/.gitignore'])
    put(path)
  writeFileSync(join(repo, '.gitignore'), 'dist/\n')
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    })
  git('init', '-q')
  git('add', 'src/a.ts')
  assert.deepEqual((await windowsFiles(repo)).sort(), [
    '.gitignore',
    join('src', 'a.ts'),
    '中文 名.md',
  ])
  // 根是仓库里的子目录：只列它下面的，相对于它
  assert.deepEqual(await windowsFiles(join(repo, 'src')), ['a.ts'])

  for (const path of ['plain/b.txt', 'plain/deep/c.txt', 'plain/.git/HEAD']) put(path)
  assert.deepEqual((await windowsFiles(join(base, 'plain'))).sort(), [
    'b.txt',
    join('deep', 'c.txt'),
  ])
})
