// 设备进程怎么用工作树：设备信息列出扩展；声明了 worktrees 的连接 thread/start 带 litchWorktree 时先建工作树、
// cwd 换成工作树里的子目录再转给引擎，会话对象上挂 litchWorktree、收到变化通知；没声明的连接带了也当不认识的参数丢掉；
// 引擎没建成会话时把刚建的工作树删干净。上游是假引擎（fake-engine.mts），仓库是真的 git 仓库。
import assert from 'node:assert/strict'
import { existsSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { RpcFailure } from './fake-upstream.mjs'
import { tempDir } from './helpers.mjs'
import { got, treeRig, until } from './tree-kit.mjs'
import { makeRepo, sh } from './worktree-kit.mjs'

const CHANGED = 'litch/worktree/changed'

function world() {
  const dir = realpathSync(tempDir())
  const repo = makeRepo(dir)
  const env = treeRig()
  return {
    env,
    repo,
    async done() {
      await env.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('WTD-001：设备信息列出 worktrees；声明了的连接建会话时在新工作树的子目录里起，会话对象上带 litchWorktree', async () => {
  const { env, repo, done } = world()
  try {
    const client = env.connect()
    await client.initialize(['harness', 'worktrees'])
    const plain = env.connect()
    await plain.initialize(['harness'])
    const info = await client.call('runtime/info')
    assert.ok(info.device.extensions.includes('worktrees'))
    const started = await client.call('thread/start', {
      harness: 'pi',
      cwd: join(repo, 'src'),
      litchWorktree: { title: 'Add search', from: { kind: 'head' } },
    })
    const made = env.device.worktrees?.list()[0]
    assert.ok(made, '建了一个工作树')
    assert.match(made.branch, /^litch\/add-search-[0-9a-f]{6}$/)
    assert.equal(made.baseRef, 'HEAD')
    // 引擎收到的是工作树里对应的子目录，参数里没有 litchWorktree
    const threadId = started.thread.id as string
    assert.equal(started.thread.cwd, join(made.path, 'src'))
    const forwarded = env.pi.seen.find((frame) => frame.method === 'thread/start')
    assert.equal(forwarded?.params.cwd, join(made.path, 'src'))
    assert.equal('litchWorktree' in (forwarded?.params ?? {}), false)
    assert.equal(sh(made.path, 'symbolic-ref', '--short', 'HEAD'), made.branch)
    // 应答回来后记成主人；应答本身和之后的读取都带 litchWorktree
    await until(() => env.device.worktrees?.forThread(threadId)?.id === made.id, '记成主人')
    const read = await client.call('thread/read', { threadId })
    assert.equal(read.thread.litchWorktree.id, made.id)
    assert.equal(read.thread.litchWorktree.branch, made.branch)
    assert.equal(read.thread.litchWorktree.sourceRoot, repo)
    const listed = await client.call('thread/list', {})
    assert.equal(listed.data.find((row: any) => row.id === threadId)?.litchWorktree?.id, made.id)
    // 没声明的连接看不到字段、收不到通知
    const plainRead = await plain.call('thread/read', { threadId })
    assert.equal('litchWorktree' in plainRead.thread, false)
    await until(
      () => got(client, CHANGED).some((one) => one.worktree.ownerThreadId === threadId),
      '主人变了的通知',
    )
    assert.deepEqual(got(plain, CHANGED), [])
    // 方法：列出、删、恢复
    const all = await client.call('litch/worktree/list', {})
    assert.equal(all.data[0].id, made.id)
    const removed = await client.call('litch/worktree/remove', { id: made.id })
    assert.equal(removed.worktree.state, 'removed')
    assert.equal(existsSync(made.path), false)
    const restored = await plain.call('litch/worktree/restore', { id: made.id })
    assert.equal(restored.worktree.state, 'ready')
    assert.equal(existsSync(made.path), true)
    const branches = await client.call('litch/worktree/branches', { cwd: repo })
    assert.equal(branches.current, 'main')
  } finally {
    await done()
  }
})

test('WTD-002：没声明的连接带 litchWorktree 当不认识的参数丢掉，照原目录建会话', async () => {
  const { env, repo, done } = world()
  try {
    const plain = env.connect()
    await plain.initialize(['harness'])
    const started = await plain.call('thread/start', {
      harness: 'pi',
      cwd: repo,
      litchWorktree: { title: 'x' },
    })
    assert.equal(started.thread.cwd, repo)
    assert.equal('litchWorktree' in started.thread, false)
    const forwarded = env.pi.seen.find((frame) => frame.method === 'thread/start')
    assert.equal('litchWorktree' in (forwarded?.params ?? {}), false)
    assert.deepEqual(env.device.worktrees?.list(), [])
  } finally {
    await done()
  }
})

test('WTD-003：建不了工作树时回错误、不转给引擎；引擎没建成会话时删掉刚建的工作树和分支', async () => {
  const { env, repo, done } = world()
  try {
    const client = env.connect()
    await client.initialize(['harness', 'worktrees'])
    const outside = realpathSync(tempDir())
    const notRepo = await client.fails('thread/start', {
      harness: 'pi',
      cwd: outside,
      litchWorktree: {},
    })
    rmSync(outside, { recursive: true, force: true })
    assert.equal(notRepo.code, -32602)
    const noCwd = await client.fails('thread/start', { harness: 'pi', litchWorktree: {} })
    assert.equal(noCwd.code, -32602)
    assert.equal(
      env.pi.seen.some((frame) => frame.method === 'thread/start'),
      false,
    )
    env.pi.handlers['thread/start'] = () => {
      throw new RpcFailure(-32603, '引擎出错')
    }
    const failed = await client.fails('thread/start', {
      harness: 'pi',
      cwd: repo,
      litchWorktree: { title: 'doomed' },
    })
    assert.equal(failed.message, '引擎出错')
    await until(() => (env.device.worktrees?.list().length ?? 0) === 0, '刚建的工作树删掉了')
    assert.equal(sh(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'), 'main')
    assert.equal(sh(repo, 'worktree', 'list', '--porcelain').split('\n\n').length, 1)
  } finally {
    await done()
  }
})

test('WTD-004：经聚合面归档工作树的主人，干净的删了目录；重新打开（thread/resume）之前先建回来', async () => {
  const { env, repo, done } = world()
  try {
    const client = env.connect()
    await client.initialize(['harness', 'worktrees'])
    const started = await client.call('thread/start', {
      harness: 'pi',
      cwd: repo,
      litchWorktree: { title: 'Archive me' },
    })
    const threadId = started.thread.id as string
    await until(() => env.device.worktrees?.forThread(threadId) != null, '记成主人')
    const made = env.device.worktrees?.forThread(threadId)
    assert.ok(made)
    await client.call('thread/archive', { threadId })
    await until(() => env.device.worktrees?.get(made.id)?.state === 'removed', '归档后删了目录')
    assert.equal(existsSync(made.path), false)
    await client.call('thread/resume', { threadId })
    assert.equal(env.device.worktrees?.get(made.id)?.state, 'ready')
    assert.equal(existsSync(made.path), true, 'resume 转给引擎之前目录已经建回来了')
  } finally {
    await done()
  }
})
