// 会话归档（照 Claude 桌面端）：用户归档父会话时已经停下的子会话跟着归档，在干活的、置顶的留着；
// 模型的 litch_sessions.archive / unarchive：只在用户发起的回合里归档，在干活的、置顶的不归档，self 等回合结束再归档，
// 模型归档的子会话回报照常唤醒（不算用户停的）；子会话的工作树照归档规则处理。
import assert from 'node:assert/strict'
import { existsSync, realpathSync, rmSync } from 'node:fs'
import test from 'node:test'
import { failureOf, resultOf } from './fake-engine.mjs'
import { settle, tempDir } from './helpers.mjs'
import {
  brief,
  ECHO_SPEC,
  got,
  litch,
  parent,
  refuseSteer,
  SESSIONS,
  TREE,
  text,
  treeRig,
  until,
} from './tree-kit.mjs'
import { makeRepo, sh, write } from './worktree-kit.mjs'

type Env = ReturnType<typeof treeRig>

/** 父会话（pi，用户回合里）让模型派一个 claude-code 的子会话 */
async function spawn(env: Env, threadId: string, title: string) {
  const answer = await env.pi.callTool(threadId, SESSIONS, 'start', {
    title,
    ...brief('做点事。'),
    harness: 'claude-code',
    initiation: 'user_asked',
  })
  return resultOf(answer?.answer).thread_id as string
}

const call = (env: Env, threadId: string, tool: string, args: unknown) =>
  env.pi.callTool(threadId, SESSIONS, tool, args)

const archivedIn = (env: Env, threadId: string) =>
  [...env.pi.threads, ...env.claude.threads].find((one) => one.id === threadId)?.archived === true

const notesOf = (env: Env, threadId: string) => env.device.sessionTree.store.notes(threadId)

test('SESSION-ARCHIVE-001：用户归档父会话：已经停下的子孙会话跟着归档（算用户归档的），在跑的、置顶的留着，各客户端连接都收到', async () => {
  const env = treeRig()
  refuseSteer(env.pi)
  try {
    const client = await litch(env)
    const other = await litch(env)
    const { threadId } = await parent(client)
    const done = await spawn(env, threadId, '做完的')
    const busy = await spawn(env, threadId, '还在跑的')
    const pinned = await spawn(env, threadId, '置顶的')
    env.claude.end(done, 'completed', '好了')
    env.claude.end(pinned, 'completed', '好了')
    env.device.sessionTree.host.workspaces.pin(pinned, true)
    // 做完的那个自己又派了一个孙会话，也停下了：一起带走
    await client.call('turn/start', { threadId: done, input: text('再派一个') })
    const grandchild = resultOf(
      (
        await env.claude.callTool(done, SESSIONS, 'start', {
          title: '孙会话',
          ...brief('做点小事。'),
          initiation: 'user_asked',
        })
      )?.answer,
    ).thread_id as string
    env.claude.end(grandchild, 'completed', '好了')
    env.claude.end(done, 'completed', '也好了')
    // 孙会话停了、它的父会话也闲了：会被唤醒（回报到的先后不定，可能不止一回），唤醒的回合都结束掉
    await until(() => env.claude.running(done), '做完的那个被孙会话唤醒')
    for (let round = 0; round < 10; round++) {
      if (env.claude.running(done)) env.claude.end(done, 'completed', '收到')
      await settle(50)
    }
    env.pi.end(threadId)
    await until(
      () => ![done, grandchild].some((id) => env.device.sessionTree.isActive(id)),
      '子孙的回合结束',
    )

    await client.call('thread/archive', { threadId })
    await until(() => archivedIn(env, done) && archivedIn(env, grandchild), '停下的子孙跟着归档')
    await settle(50)
    assert.equal(archivedIn(env, busy), false, '在跑的留着')
    assert.equal(archivedIn(env, pinned), false, '置顶的留着')
    assert.equal(
      env.device.sessionTree.store.parentOf(done)?.parentThreadId,
      threadId,
      '父子关系不变',
    )
    for (const id of [done, grandchild]) {
      assert.equal(env.device.sessionTree.host.index.archived(id), true)
      for (const one of [client, other])
        await until(
          () => got(one, 'thread/archived').some((params) => params.threadId === id),
          `连接收到 ${id} 的 thread/archived`,
        )
    }
    // 跟着用户归档的父会话一起归档的算用户归档：排着的回报不再唤醒
    const reports = notesOf(env, threadId).filter((note) => note.threadId === done)
    assert.ok(reports.length > 0)
    for (const note of reports) {
      assert.equal(note.userStopped, 'archived')
      assert.equal(note.wake, false)
    }
    assert.ok(
      notesOf(env, threadId).some((note) => note.threadId === pinned && note.wake),
      '置顶的留着的回报不动',
    )
    // 放回父会话只放它一个
    await client.call('thread/unarchive', { threadId })
    await settle(50)
    assert.equal(archivedIn(env, done), true)
  } finally {
    await env.close()
  }
})

test('SESSION-ARCHIVE-002：模型在用户回合里归档自己的子会话：回报照常唤醒、不算用户停的；放回不用用户回合', async () => {
  const env = treeRig()
  refuseSteer(env.pi)
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const child = await spawn(env, threadId, '子任务')
    env.claude.end(child, 'completed', '做完了')
    await until(() => notesOf(env, threadId).length === 1, '回报进队列')
    const answer = resultOf((await call(env, threadId, 'archive', { thread_id: child }))?.answer)
    assert.equal(answer.thread_id, child)
    assert.match(answer.note, /^Archived\./)
    assert.equal(archivedIn(env, child), true)
    assert.equal(env.device.sessionTree.host.index.archived(child), true)
    await until(
      () => got(client, 'thread/archived').some((params) => params.threadId === child),
      '客户端收到 thread/archived',
    )
    await settle(50)
    const [note] = notesOf(env, threadId)
    assert.equal(note?.wake, true, '模型归档的照常唤醒')
    assert.equal(note?.userStopped, undefined)
    // 已经归档的再归档：照实回，不报错
    const again = resultOf((await call(env, threadId, 'archive', { thread_id: child }))?.answer)
    assert.match(again.note, /already archived/)

    // 父会话的回合结束、被唤醒（不是用户回合）：自己的子会话照样能放回来
    env.pi.end(threadId)
    await until(() => env.pi.running(threadId), '父会话被唤醒')
    const restored = resultOf(
      (await call(env, threadId, 'unarchive', { thread_id: child }))?.answer,
    )
    assert.equal(restored.thread_id, child)
    assert.equal(archivedIn(env, child), false)
    assert.equal(env.device.sessionTree.host.index.archived(child), false)
    await until(
      () => got(client, 'thread/unarchived').some((params) => params.threadId === child),
      '客户端收到 thread/unarchived',
    )
    // 唤醒回合里不能归档：要用户同意
    const refused = await call(env, threadId, 'archive', { thread_id: child })
    assert.equal(failureOf(refused?.answer), 'blocked')
    assert.match(refused?.answer.result.contentItems[0].text, /Ask the user first/)
    assert.equal(archivedIn(env, child), false)
  } finally {
    await env.close()
  }
})

test('SESSION-ARCHIVE-003：模型归档：别人的会话在用户回合里也行；在跑的、置顶的、引擎子线程不归档；别人的放回要用户回合', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const { threadId: stranger } = await parent(client, false)
    const child = await spawn(env, threadId, '还在跑')
    const running = await call(env, threadId, 'archive', { thread_id: child })
    assert.equal(failureOf(running?.answer), 'blocked')
    assert.match(running?.answer.result.contentItems[0].text, /still working/)
    assert.equal(archivedIn(env, child), false)

    env.device.sessionTree.host.workspaces.pin(stranger, true)
    const pinned = await call(env, threadId, 'archive', { thread_id: stranger })
    assert.equal(failureOf(pinned?.answer), 'blocked')
    assert.match(pinned?.answer.result.contentItems[0].text, /pinned/)
    env.device.sessionTree.host.workspaces.pin(stranger, false)
    const archived = resultOf(
      (await call(env, threadId, 'archive', { thread_id: stranger }))?.answer,
    )
    assert.equal(archived.thread_id, stranger)
    assert.equal(archivedIn(env, stranger), true)

    env.pi.threads.push({ id: 'pi-sub', updatedAt: 1, cwd: '/work', parentThreadId: threadId })
    const sub = await call(env, threadId, 'archive', { thread_id: 'pi-sub' })
    assert.equal(failureOf(sub?.answer), 'blocked')
    assert.match(sub?.answer.result.contentItems[0].text, /subagent thread/)

    // 引擎自己开的回合（不是用户发起的）：别人的会话放不回来
    env.pi.end(threadId)
    env.pi.selfTurn(threadId)
    const back = await call(env, threadId, 'unarchive', { thread_id: stranger })
    assert.equal(failureOf(back?.answer), 'blocked')
    assert.equal(archivedIn(env, stranger), true)
  } finally {
    await env.close()
  }
})

test('SESSION-ARCHIVE-004：模型归档自己（self）：回合结束后才归档，连同停下的子会话', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const child = await spawn(env, threadId, '子任务')
    env.claude.end(child, 'completed', '好了')
    // 父会话被子会话的回报唤醒一回合、结束，再由用户说一句：在这个用户回合里归档自己
    env.pi.end(threadId)
    await until(() => env.pi.running(threadId), '父会话被唤醒')
    env.pi.end(threadId)
    await until(() => !env.device.sessionTree.isActive(threadId), '唤醒回合结束')
    await client.call('turn/start', { threadId, input: text('都好了，把这个会话归档吧') })
    const answer = resultOf((await call(env, threadId, 'archive', { thread_id: 'self' }))?.answer)
    assert.equal(answer.thread_id, threadId)
    assert.match(answer.note, /archived when this turn ends/)
    await settle(50)
    assert.equal(archivedIn(env, threadId), false, '回合还没结束')
    env.pi.end(threadId, 'completed', '收工')
    await until(
      () => archivedIn(env, threadId) && archivedIn(env, child),
      '回合结束后归档，带上子会话',
    )
    await until(
      () => got(client, 'thread/archived').some((params) => params.threadId === threadId),
      '客户端收到 thread/archived',
    )
  } finally {
    await env.close()
  }
})

test('SESSION-ARCHIVE-005：模型归档在自己工作树里的子会话：干净的删目录留分支，有改动的留着', async () => {
  const dir = realpathSync(tempDir())
  const repo = makeRepo(dir)
  const env = treeRig()
  try {
    const client = env.connect()
    await client.initialize([...TREE, 'worktrees'], {
      litchClientTools: { namespaces: ['litch_echo'] },
    })
    const started = await client.call('thread/start', {
      harness: 'pi',
      cwd: repo,
      dynamicTools: [ECHO_SPEC],
    })
    const threadId = started.thread.id as string
    await client.call('turn/start', { threadId, input: text('派两个子会话') })
    const worktrees = env.device.worktrees
    assert.ok(worktrees)
    for (const dirty of [false, true]) {
      const child = resultOf(
        (
          await call(env, threadId, 'start', {
            title: dirty ? 'Dirty child' : 'Clean child',
            ...brief('做一件独立的事'),
            initiation: 'user_asked',
            worktree: true,
          })
        )?.answer,
      ).thread_id as string
      const tree = worktrees.forThread(child)
      assert.ok(tree)
      env.pi.end(child, 'completed', '好了')
      await until(() => !env.device.sessionTree.isActive(child), '子会话的回合结束')
      if (dirty) write(tree.path, 'src/app.txt', 'changed\n')
      resultOf((await call(env, threadId, 'archive', { thread_id: child }))?.answer)
      assert.equal(worktrees.get(tree.id)?.state, dirty ? 'kept' : 'removed')
      assert.equal(existsSync(tree.path), dirty)
      assert.ok(sh(repo, 'branch', '--list', tree.branch), '分支留着')
    }
  } finally {
    await env.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
