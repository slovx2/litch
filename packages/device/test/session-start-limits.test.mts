import assert from 'node:assert/strict'
import test from 'node:test'
import { StartRefused, startChild } from '../src/session-start.mjs'
import { failureOf } from './fake-engine.mjs'
import { RpcFailure } from './fake-upstream.mjs'
import { brief, litch, parent, SESSIONS, treeRig, until } from './tree-kit.mjs'

const spec = { kind: 'fresh' as const, title: '分支', ...brief('完成独立模块'), wakeParent: false }

test('START-LIMIT-001：会话已建但首回合失败不退额度，八个未启动子会话持久占位；归档成功才释放', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId, turnId } = await parent(client)
    assert.ok(turnId)
    const original = env.claude.handlers['turn/start']
    assert.ok(original)
    env.claude.handlers['turn/start'] = () => {
      throw new RpcFailure(-32000, '首回合失败')
    }
    for (let i = 0; i < 8; i++)
      await assert.rejects(
        startChild(
          env.device.sessionTree,
          threadId,
          { ...spec, harness: 'claude-code' },
          'model',
          turnId,
        ),
        /created but its start was not confirmed/,
      )
    const holds = env.device.sessionTree.store.childStarts()
    assert.equal(holds.length, 8)
    await assert.rejects(
      startChild(env.device.sessionTree, threadId, spec, 'model', turnId),
      /limit is 8/,
    )
    // 再占八个已达16；第17个不能借首回合失败退回的额度继续建。
    for (let i = 0; i < 8; i++)
      assert.ok(env.device.sessionTree.store.reserveDirectStart(threadId, turnId, 16))
    assert.equal(env.device.sessionTree.store.reserveDirectStart(threadId, turnId, 16), false)
    const child = holds[0]?.threadId
    assert.ok(child)
    const archive = env.claude.handlers['thread/archive']
    assert.ok(archive)
    env.claude.handlers['thread/archive'] = () => {
      throw new RpcFailure(-32000, '归档失败')
    }
    await client.fails('thread/archive', { threadId: child })
    assert.equal(env.device.sessionTree.store.childStarts().length, 8)
    env.claude.handlers['thread/archive'] = archive
    await client.call('thread/archive', { threadId: child })
    await until(() => env.device.sessionTree.store.childStarts().length === 7, '归档释放名额')
    env.claude.handlers['turn/start'] = original
    assert.ok((await startChild(env.device.sessionTree, threadId, spec, 'user')).threadId)
  } finally {
    await env.close()
  }
})

test('START-LIMIT-002：整树计入根和不同分支，24个边界并发只能进入剩余两个，另一棵树不受影响', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const branches = await Promise.all(
      Array.from({ length: 3 }, () => startChild(env.device.sessionTree, threadId, spec, 'user')),
    )
    const children = await Promise.all(
      branches.flatMap((branch) =>
        Array.from({ length: 6 }, () =>
          startChild(env.device.sessionTree, branch.threadId, spec, 'user'),
        ),
      ),
    )
    const extra = await Promise.allSettled(
      branches
        .slice(0, 2)
        .flatMap((branch) =>
          Array.from({ length: 2 }, () =>
            startChild(env.device.sessionTree, branch.threadId, spec, 'user'),
          ),
        ),
    )
    assert.equal(extra.filter((r) => r.status === 'fulfilled').length, 2)
    for (const r of extra)
      if (r.status === 'rejected') {
        assert.ok(r.reason instanceof StartRefused)
        assert.equal(r.reason.kind, 'forbidden')
        assert.match(r.reason.message, /limit 24/)
      }
    const finished = children.at(-1)
    assert.ok(finished)
    env.pi.end(finished.threadId)
    await until(() => !env.device.sessionTree.isActive(finished.threadId), '释放树内一个名额')
    assert.ok(
      (await startChild(env.device.sessionTree, branches[2]?.threadId as string, spec, 'user'))
        .threadId,
    )
    const other = await parent(client)
    assert.ok((await startChild(env.device.sessionTree, other.threadId, spec, 'user')).threadId)
  } finally {
    await env.close()
  }
})

test('START-LIMIT-003：根是第0层，允许四层，第五层返回forbidden', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    let { threadId } = await parent(client)
    for (let depth = 1; depth <= 4; depth++)
      threadId = (await startChild(env.device.sessionTree, threadId, spec, 'user')).threadId
    await assert.rejects(
      startChild(env.device.sessionTree, threadId, spec, 'user'),
      (error: unknown) =>
        error instanceof StartRefused &&
        error.kind === 'forbidden' &&
        /depth 4/.test(error.message),
    )
    const called = await env.pi.callTool(threadId, SESSIONS, 'start', {
      ...spec,
      initiation: 'user_asked',
    })
    assert.equal(failureOf(called?.answer), 'forbidden')
    const refused = await client.fails('litch/session/start', { ...spec, parentThreadId: threadId })
    assert.equal(refused.data?.litch, 'forbidden')
  } finally {
    await env.close()
  }
})

test('START-LIMIT-004：归档成功清除自己的直接启动计数，用户及模型归档都覆盖；失败不清', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    for (const by of ['user', 'model'] as const) {
      const { threadId } = await parent(client, false)
      for (let i = 0; i < 16; i++)
        assert.ok(env.device.sessionTree.store.reserveDirectStart(threadId, 't', 16))
      const archive = env.pi.handlers['thread/archive']
      assert.ok(archive)
      env.pi.handlers['thread/archive'] = () => {
        throw new RpcFailure(-32000, '模拟失败')
      }
      await assert.rejects(env.device.archives.archive(threadId, by))
      assert.equal(env.device.sessionTree.store.reserveDirectStart(threadId, 't', 16), false)
      env.pi.handlers['thread/archive'] = archive
      await env.device.archives.archive(threadId, by)
      assert.ok(env.device.sessionTree.store.reserveDirectStart(threadId, 't', 16))
    }
  } finally {
    await env.close()
  }
})
