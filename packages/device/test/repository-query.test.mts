import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runGit } from '../src/repository-command.mjs'
import { repositoryRoot } from '../src/repository-path.mjs'
import { queryRepository } from '../src/repository-query.mjs'
import { commitAll, makeRepo, sh, write } from './worktree-kit.mjs'

test('Git argv：读写命令、工作树、特殊文件名及已有五个快捷方法', async () => {
  const root = mkdtempSync(join(tmpdir(), 'repo-command-test-'))
  try {
    const repo = makeRepo(root)
    const run = (argv: string[], directory = repo) =>
      queryRepository('run', { directory, argv }, AbortSignal.timeout(15000))
    for (const name of ['with space.txt', '-leading.txt', 'semi;$(echo literal).txt']) {
      write(repo, name, 'first\nsecond\n')
      assert.equal((await run(['add', '--', name])).exit_code, 0)
    }
    assert.equal((await run(['commit', '-m', 'argv commit'])).exit_code, 0)
    assert.match((await run(['log', '-1', '--format=%s'])).content, /argv commit/)
    for (const name of ['with space.txt', '-leading.txt', 'semi;$(echo literal).txt'])
      assert.equal((await run(['show', `HEAD:${name}`])).content, 'first\nsecond\n')
    assert.equal((await run(['config', 'litch.test', 'value;literal'])).exit_code, 0)
    assert.equal((await run(['config', '--get', 'litch.test'])).content.trim(), 'value;literal')
    const worktree = join(root, 'line-worktree')
    assert.equal((await run(['worktree', 'add', '-b', 'line', worktree])).exit_code, 0)
    assert.equal((await run(['status', '--porcelain'], worktree)).content, '')
    assert.equal(await repositoryRoot(worktree, AbortSignal.timeout(5000)), realpathSync(worktree))
    write(repo, 'src/app.txt', 'staged\n')
    sh(repo, 'add', 'src/app.txt')
    write(repo, 'src/app.txt', 'unstaged\n')
    const shortcut = (method: 'log' | 'show' | 'diff' | 'blame' | 'status', args = {}) =>
      queryRepository(method, { directory: repo, ...args }, AbortSignal.timeout(15000))
    assert.match((await shortcut('log')).content, /argv commit/)
    assert.equal((await shortcut('show', { path: 'with space.txt' })).content, 'first\nsecond\n')
    assert.match((await shortcut('diff')).content, /unstaged/)
    assert.match((await shortcut('diff', { staged: true })).content, /staged/)
    assert.match((await shortcut('blame', { path: 'with space.txt' })).content, /second/)
    assert.match((await shortcut('status')).content, /src\/app.txt/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Git 进程：超时、主动取消和输出限长', async () => {
  const root = mkdtempSync(join(tmpdir(), 'repo-command-limits-'))
  try {
    const repo = makeRepo(root)
    // Git 自身通过别名启动测试计时器；工具仍只 execFile git，不执行 shell 文本。
    const delay = [
      '-c',
      `alias.delay=!"${process.execPath.replaceAll('\\', '/')}" -e "setTimeout(()=>{},10000)"`,
      'delay',
    ]
    await assert.rejects(runGit(delay, repo, AbortSignal.timeout(100)), /timed out/)
    const controller = new AbortController()
    const pending = runGit(delay, repo, controller.signal)
    controller.abort()
    await assert.rejects(pending, /cancelled/)
    write(repo, 'large.txt', 'x'.repeat(600000))
    commitAll(repo, 'large blob')
    const large = await runGit(['show', 'HEAD:large.txt'], repo, AbortSignal.timeout(5000), 1024)
    assert.equal(large.stdout.length, 1024)
    assert.equal(large.truncated, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
