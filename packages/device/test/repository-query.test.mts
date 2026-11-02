import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import { REPOSITORY_METHODS } from '../../protocol/src/client-tools-repository.mjs'
import {
  ReadCommandError,
  readOnlyCommand,
  runReadOnlyCommand,
} from '../../shared/src/read-only-command.mjs'
import { queryRepository } from '../src/repository-query.mjs'
import {
  REPOSITORY_GIT,
  repositoryEnvironment,
  requireLocalRepositoryPath,
} from '../src/repository-view.mjs'
import { commitAll, makeRepo, sh, write } from './worktree-kit.mjs'

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  const visit = (path: string) => {
    const stat = lstatSync(path)
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name))
      return
    }
    files[relative(root, path)] =
      `${stat.mode}:${stat.mtimeMs}:` +
      (stat.isSymbolicLink()
        ? readlinkSync(path)
        : createHash('sha256').update(readFileSync(path)).digest('hex'))
  }
  visit(root)
  return files
}

test('受控 Git：五方法、工作树、特殊文件名和快照前后文件/索引/HEAD/refs/config 不变', async () => {
  const root = mkdtempSync(join(tmpdir(), 'repo-read-test-'))
  try {
    const repo = makeRepo(root)
    for (const name of ['with space.txt', '-leading.txt', 'line\nbreak.txt'])
      write(repo, name, 'first\nsecond\n')
    write(repo, 'deleted.txt', 'historical\n')
    write(repo, 'binary.bin', Buffer.from([0, 1, 2]).toString('binary'))
    write(repo, 'large.txt', 'x'.repeat(600000))
    const base = commitAll(repo, 'history files')
    sh(repo, 'rm', 'deleted.txt')
    write(repo, 'src/app.txt', 'v2\n')
    const head = commitAll(repo, 'remove historical file')
    const worktree = join(root, 'line-worktree')
    sh(repo, 'worktree', 'add', '-q', '-b', 'line-branch', worktree)
    write(repo, 'src/app.txt', 'staged\n')
    sh(repo, 'add', 'src/app.txt')
    write(repo, 'src/app.txt', 'unstaged\n')
    write(repo, 'untracked.txt', 'untracked\n')
    const before = snapshot(root)
    const run = (method: (typeof REPOSITORY_METHODS)[number], args = {}, directory = repo) =>
      queryRepository(method, { directory, ...args }, AbortSignal.timeout(15000))
    const log = await run('log', { limit: 1 })
    assert.match(log.content, /remove historical file/)
    assert.equal(log.head, head)
    assert.equal(log.boundary, process.platform === 'win32' ? 'controlled-methods' : 'sandboxed')
    assert.match((await run('log', { skip: 1, limit: 1 })).content, /history files/)
    assert.match((await run('show', { ref: base, path: 'deleted.txt' })).content, /historical/)
    assert.match((await run('show')).content, /remove historical file/)
    for (const path of ['with space.txt', '-leading.txt', 'line\nbreak.txt']) {
      assert.equal((await run('show', { path })).content, 'first\nsecond\n')
      assert.match((await run('blame', { path, start_line: 2, end_line: 2 })).content, /second/)
    }
    assert.match((await run('diff')).content, /unstaged/)
    assert.match((await run('diff', { staged: true })).content, /staged/)
    assert.match((await run('diff', { base, head })).content, /deleted.txt/)
    assert.match((await run('status')).content, /untracked.txt/)
    assert.equal((await run('status', {}, worktree)).content, '')
    assert.equal((await run('show', { path: 'binary.bin' })).binary, true)
    const large = await run('show', { path: 'large.txt' })
    assert.equal(large.file_bytes, 600000)
    assert.equal(large.content, '')
    assert.equal(large.truncated, true)
    await assert.rejects(
      run('log', {}, root),
      (error: unknown) => error instanceof ReadCommandError && error.code === 'not_repository',
    )
    assert.deepEqual(snapshot(root), before, '工作区与整个 .git/common dir 内容、mtime 都不变')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('受控 Git：配置/环境/选项/路径注入、外部 helpers 和缺失对象不执行副作用', async () => {
  const root = mkdtempSync(join(tmpdir(), 'repo-read-hostile-'))
  const saved = { ...process.env }
  try {
    const repo = makeRepo(root)
    const trap = join(root, 'trap')
    const command = `touch '${trap}'`
    write(repo, '.gitattributes', '*.txt filter=evil diff=evil\n')
    commitAll(repo, 'attributes')
    for (const [key, value] of [
      ['core.fsmonitor', command],
      ['core.pager', command],
      ['diff.external', command],
      ['diff.evil.command', command],
      ['diff.evil.textconv', command],
      ['filter.evil.clean', command],
      ['filter.evil.smudge', command],
      ['filter.evil.process', command],
      ['filter.evil.required', 'true'],
      ['alias.log', `!${command}`],
      ['core.sshCommand', command],
      ['remote.origin.url', 'http://127.0.0.1:9/missing'],
      ['remote.origin.promisor', 'true'],
      ['extensions.partialClone', 'origin'],
    ] as const)
      sh(repo, 'config', key, value)
    write(repo, 'src/app.txt', 'working changes\n')
    // 构造真实提交引用一个本地缺失的 blob，模拟部分克隆按需取对象的触发点。
    const missingTree = execFileSync(REPOSITORY_GIT, ['mktree', '--missing'], {
      cwd: repo,
      env: process.env,
      input: `100644 blob ${'e'.repeat(40)}\tmissing.txt\n`,
      encoding: 'utf8',
    }).trim()
    const missingCommit = sh(repo, 'commit-tree', missingTree, '-p', 'HEAD', '-m', 'missing object')
    sh(repo, 'update-ref', 'refs/heads/missing', missingCommit)
    const before = snapshot(root)
    Object.assign(process.env, {
      GIT_EXTERNAL_DIFF: command,
      GIT_PAGER: command,
      GIT_DIR: '/invalid',
      GIT_WORK_TREE: '/invalid',
      GIT_INDEX_FILE: trap,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: command,
      GIT_EXEC_PATH: '/invalid',
      LD_PRELOAD: '/invalid',
      DYLD_INSERT_LIBRARIES: '/invalid',
    })
    const run = (method: (typeof REPOSITORY_METHODS)[number], args = {}) =>
      queryRepository(method, { directory: repo, ...args }, AbortSignal.timeout(15000))
    for (const method of REPOSITORY_METHODS)
      await run(method, method === 'blame' ? { path: 'src/app.txt' } : {})
    for (const args of [
      { output: trap },
      { command: 'commit' },
      { argv: ['--output', trap] },
      { env: { GIT_DIR: '/invalid' } },
      { ref: '--output=evil' },
      { ref: 'HEAD;touch evil' },
      { ref: '$(touch evil)' },
      { path: '../outside' },
      { path: '/etc/passwd' },
      { path: '.git/config' },
    ])
      await assert.rejects(run('show', args))
    await assert.rejects(
      run('show', { ref: 'f'.repeat(40) }),
      (error: unknown) => error instanceof ReadCommandError && error.code === 'missing_object',
    )
    await assert.rejects(run('show', { ref: 'missing', path: 'missing.txt' }))
    assert.deepEqual(snapshot(root), before)
    symlinkSync(root, join(repo, 'outside'))
    await assert.rejects(run('show', { path: 'outside/trap' }), /escapes/)
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    rmSync(root, { recursive: true, force: true })
  }
})

test('只读查询进程：超时、输出限长、平台边界；macOS 沙箱实际拒写和禁网', async () => {
  const root = mkdtempSync(join(tmpdir(), 'read-command-test-'))
  try {
    assert.throws(() => requireLocalRepositoryPath('//server/share'), /UNC/)
    assert.throws(() => requireLocalRepositoryPath('\\\\?\\C:\\repo'), /UNC/)
    assert.equal(readOnlyCommand(['/fixed/git'], root, 'win32').boundary, 'controlled-methods')
    assert.throws(() => readOnlyCommand(['/fixed/git'], root, 'aix'), /No read-only/)
    const env = repositoryEnvironment()
    await assert.rejects(
      runReadOnlyCommand(
        [process.execPath, '-e', 'setTimeout(()=>{},10000)'],
        root,
        env,
        AbortSignal.timeout(100),
      ),
      /timed out/,
    )
    const large = await runReadOnlyCommand(
      [process.execPath, '-e', 'process.stdout.write("x".repeat(65536))'],
      root,
      env,
      AbortSignal.timeout(5000),
      1024,
    )
    assert.equal(large.stdout.length, 1024)
    assert.equal(large.truncated, true)
    if (process.platform !== 'win32') {
      const write = await runReadOnlyCommand(
        [
          process.execPath,
          '-e',
          `require('fs').writeFileSync(${JSON.stringify(join(root, 'forbidden'))}, 'x')`,
        ],
        root,
        env,
        AbortSignal.timeout(5000),
      )
      assert.notEqual(write.code, 0)
      const network = await runReadOnlyCommand(
        [process.execPath, '-e', "require('net').createServer().listen(0,'127.0.0.1')"],
        root,
        env,
        AbortSignal.timeout(5000),
      )
      assert.notEqual(network.code, 0)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
