import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('PROJECT-002：真实回合项目幂等、分页重排、归属迁移和通知、重启及删除保留历史', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-projects-'))
  const llm = new MockLLM(),
    url = await llm.start()
  let client = await ProtocolClient.start(home, url)
  const source = join(home, 'retain.txt')
  await writeFile(source, '项目维护不能改动文件\n')
  const listed = async (params: Record<string, unknown> = {}) =>
    (await client.request('project/list', params)).data
  const members = async (projectId: string | null) =>
    (await client.request('thread/list', { projectId })).data.map((thread: any) => thread.id)
  const readThread = async (threadId: string) =>
    (await client.request('thread/read', { threadId, includeTurns: true })).thread
  try {
    assert.deepEqual(await listed(), [])
    const create = {
      name: '原项目',
      roots: [{ path: home }],
      metadata: { marker: 'original' },
      idempotencyKey: 'original',
    }
    const { project: first } = await client.request('project/create', create)
    await client.notification(
      'project/changed',
      (p) => p.projectId === first.id && p.changeType === 'created',
    )
    const repeated = await Promise.all(
      Array.from({ length: 3 }, () =>
        client.request('project/create', { ...create, name: '重复请求不能覆盖' }),
      ),
    )
    assert.ok(
      repeated.every(
        (result) => result.project.id === first.id && result.project.name === first.name,
      ),
    )
    const { project: second } = await client.request('project/create', {
      ...create,
      name: '第二项目',
      idempotencyKey: 'second',
    })
    const ids: string[] = [],
      histories: unknown[] = []
    for (const [index, projectId] of [first.id, null].entries()) {
      const { thread } = await client.request('thread/start', { cwd: home, projectId })
      assert.equal(thread.projectId, projectId)
      ids.push(thread.id)
      llm.enqueue(() => [{ type: 'text', text: `PROJECT_HISTORY_${index}_OK` }])
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: `保留项目历史 ${index}` }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
      histories.push((await readThread(thread.id)).turns)
    }
    const [owner, other] = ids as [string, string]
    assert.deepEqual(await members(null), [other])
    const importedParams = {
      name: '导入项目',
      roots: [{ path: home }],
      threads: [owner, other, owner],
      idempotencyKey: 'imported',
    }
    const { project: imported } = await client.request('project/import', importedParams)
    assert.equal((await client.request('project/import', importedParams)).project.id, imported.id)
    await client.notification(
      'thread/project/updated',
      (p) => p.threadId === owner && p.projectId === imported.id,
    )
    await client.notification(
      'thread/project/updated',
      (p) => p.threadId === other && p.projectId === imported.id,
    )
    assert.deepEqual(new Set(await members(imported.id)), new Set(ids))
    assert.deepEqual(await members(first.id), [])
    const threadPage = await client.request('thread/list', { projectId: imported.id, limit: 1 })
    assert.ok(threadPage.nextCursor)
    const threadNext = await client.request('thread/list', {
      projectId: imported.id,
      limit: 1,
      cursor: threadPage.nextCursor,
    })
    assert.equal(new Set([...threadPage.data, ...threadNext.data].map((t) => t.id)).size, 2)
    await client.raw('thread/list', { projectId: first.id, cursor: threadPage.nextCursor }, -32602)
    await client.request('project/move', { projectId: second.id, beforeProjectId: first.id })
    await client.notification(
      'project/changed',
      (p) => p.projectId === second.id && p.changeType === 'updated',
    )
    assert.deepEqual(
      (await listed()).map((p: any) => p.id),
      [second.id, first.id, imported.id],
    )
    const { project: updated } = await client.request('project/update', {
      projectId: first.id,
      name: '已更新',
      roots: [],
      metadata: {},
    })
    assert.deepEqual(updated.roots, [])
    assert.deepEqual(updated.metadata, {})
    await client.notification(
      'project/changed',
      (p) => p.projectId === first.id && p.changeType === 'updated',
    )
    await client.request('thread/metadata/update', { threadId: owner, projectId: second.id })
    await client.notification(
      'thread/project/updated',
      (p) => p.threadId === owner && p.projectId === second.id,
    )
    await client.request('thread/metadata/update', { threadId: owner, projectId: null })
    assert.equal((await readThread(owner)).projectId, second.id, 'null 应保持归属')
    await client.request('thread/metadata/update', { threadId: other, projectId: '' })
    await client.notification(
      'thread/project/updated',
      (p) => p.threadId === other && p.projectId === null,
    )
    assert.deepEqual(await members(null), [other])
    await client.request('thread/metadata/update', { threadId: other, projectId: imported.id })
    for (const sortKey of ['position', 'recencyAt'])
      for (const sortDirection of ['asc', 'desc']) {
        const options = { sortKey, sortDirection }
        const full = await listed(options),
          collected = []
        let cursor: string | null = null,
          firstCursor: string | null = null
        for (let page = 0; page < 5; page++) {
          const result = await client.request('project/list', { ...options, limit: 1, cursor })
          assert.equal(result.data.length, 1)
          collected.push(...result.data)
          cursor = result.nextCursor
          if (page === 0) firstCursor = cursor
          if (cursor === null) break
        }
        assert.equal(cursor, null)
        assert.deepEqual(collected, full)
        assert.equal(new Set(collected.map((p) => p.id)).size, 3)
        if (sortKey === 'recencyAt') {
          assert.equal(full.at(-1).id, first.id, '空项目必须始终排在末尾')
          assert.equal(full.at(-1).recencyAt, null)
          assert.ok(full[0].recencyAt > 0)
        }
        await client.raw(
          'project/list',
          {
            ...options,
            sortDirection: sortDirection === 'asc' ? 'desc' : 'asc',
            cursor: firstCursor,
          },
          -32602,
        )
      }
    await client.request('thread/archive', { threadId: other })
    assert.equal(
      (await client.request('project/read', { projectId: imported.id })).project.recencyAt,
      null,
    )
    await client.request('thread/unarchive', { threadId: other })
    assert.ok(
      (await client.request('project/read', { projectId: imported.id })).project.recencyAt > 0,
    )
    const { thread: ephemeral } = await client.request('thread/start', {
      cwd: home,
      ephemeral: true,
      projectId: first.id,
    })
    assert.equal(ephemeral.projectId, first.id)
    // 列表照上游不列还没说过话的会话：先说一句
    llm.enqueue(() => [{ type: 'text', text: 'EPHEMERAL_OK' }])
    const { turn: helperTurn } = await client.request('turn/start', {
      threadId: ephemeral.id,
      input: [{ type: 'text', text: '起个标题' }],
    })
    assert.equal((await client.completed(helperTurn.id)).status, 'completed')
    assert.equal(
      (await client.request('thread/list', { projectId: first.id, includeEphemeral: true })).data[0]
        .id,
      ephemeral.id,
    )
    for (const params of [
      { limit: 0 },
      { limit: 1.5 },
      { limit: 1001 },
      { sortDirection: 'asc' },
      { cursor: 'invalid' },
      { sortKey: 'invalid' },
    ])
      await client.raw('project/list', params, -32602)
    await client.raw(
      'project/create',
      { ...create, roots: [{ path: 'relative' }], idempotencyKey: 'bad-root' },
      -32602,
    )
    await client.raw(
      'project/update',
      { projectId: first.id, name: '不能部分修改', metadata: { invalid: 3 } },
      -32602,
    )
    assert.equal(
      (await client.request('project/read', { projectId: first.id })).project.name,
      '已更新',
    )
    await client.raw(
      'project/import',
      { ...importedParams, threads: [owner, 'unknown'], idempotencyKey: 'bad-import' },
      -32602,
    )
    await client.raw('project/move', { projectId: second.id, beforeProjectId: 'unknown' }, -32602)
    await client.raw(
      'thread/metadata/update',
      { threadId: owner, projectId: 'unknown', gitInfo: { branch: 'must-not-write' } },
      -32602,
    )
    assert.equal((await readThread(owner)).projectId, second.id)
    assert.notEqual((await readThread(owner)).gitInfo?.branch, 'must-not-write')
    await client.raw('thread/start', { cwd: home, projectId: 'unknown' }, -32602)
    const { thread: fork } = await client.request('thread/fork', { threadId: owner })
    assert.equal(fork.projectId, second.id, '真实原生分叉应继承所属项目')
    assert.equal((await readThread(fork.id)).turns.length, 1)
    const beforeRestart = await listed()
    assert.equal(beforeRestart.length, 3)
    await client.close()
    assert.equal(
      client.trace.filter(
        (m) => m.method === 'project/changed' && m.params.changeType === 'created',
      ).length,
      3,
    )
    client = await ProtocolClient.start(home, url)
    assert.deepEqual(await listed(), beforeRestart)
    // 临时会话不跨进程：入口重启时上次留下的临时会话连同归属一起删掉
    assert.equal(
      (await client.raw('thread/read', { threadId: ephemeral.id })).error?.message,
      `thread not found: ${ephemeral.id}`,
    )
    for (const id of ids) await client.request('thread/resume', { threadId: id })
    for (const [index, id] of ids.entries())
      assert.deepEqual((await readThread(id)).turns, histories[index])
    assert.equal((await readThread(owner)).projectId, second.id)
    assert.equal((await readThread(fork.id)).projectId, second.id)
    await client.request('project/delete', { projectId: first.id })
    assert.equal((await readThread(owner)).projectId, second.id)
    // 页边界删除后仍能继续读取剩余项目。
    const page = await client.request('project/list', { limit: 1 })
    assert.equal(page.data[0].id, second.id)
    await client.request('project/delete', { projectId: second.id })
    await client.notification(
      'thread/project/updated',
      (p) => p.threadId === owner && p.projectId === null,
    )
    assert.deepEqual(
      (await client.request('project/list', { cursor: page.nextCursor })).data.map(
        (p: any) => p.id,
      ),
      [imported.id],
    )
    await client.request('project/delete', { projectId: imported.id })
    await client.notification(
      'thread/project/updated',
      (p) => p.threadId === other && p.projectId === null,
    )
    await client.notification(
      'project/changed',
      (p) => p.projectId === imported.id && p.changeType === 'deleted',
    )
    await client.raw('project/read', { projectId: imported.id }, -32602)
    await client.close()
    client = await ProtocolClient.start(home, url)
    assert.deepEqual(await listed(), [])
    assert.equal((await readThread(fork.id)).projectId, null)
    assert.equal((await readThread(fork.id)).turns.length, 1)
    for (const [index, id] of ids.entries()) {
      const thread = await readThread(id)
      assert.equal(thread.projectId, null)
      assert.deepEqual(thread.turns, histories[index])
    }
    assert.equal(await readFile(source, 'utf8'), '项目维护不能改动文件\n')
    // 两个普通回合，加上临时会话为了进列表说的一句
    assert.equal(llm.requests.length, 3)
    llm.assertConsumed()
  } finally {
    await client.close()
    await llm.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('PROJECT-003：SQLite 归属写入失败回滚完整导入，重试持久且不发出虚假通知', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-project-transaction-'))
  const llm = new MockLLM(),
    url = await llm.start()
  const client = await ProtocolClient.start(home, url)
  try {
    const threads: string[] = []
    for (let index = 0; index < 2; index++)
      threads.push((await client.request('thread/start', { cwd: home })).thread.id)
    const db = new DatabaseSync(join(home, 'adapter', 'state.sqlite'))
    try {
      db.exec(`CREATE TRIGGER reject_second_member BEFORE INSERT ON project_threads
        WHEN (SELECT count(*) FROM project_threads)>0 BEGIN SELECT RAISE(ABORT, 'project write fault'); END`)
      const params = {
        name: '原子导入',
        roots: [{ path: home }],
        threads,
        idempotencyKey: 'atomic-import',
      }
      await client.raw('project/import', params, -32000)
      assert.deepEqual((await client.request('project/list')).data, [])
      assert.equal(db.prepare('SELECT count(*) AS total FROM project_threads').get()?.total, 0)
      db.exec('DROP TRIGGER reject_second_member')
      const { project } = await client.request('project/import', params)
      await client.notification(
        'thread/project/updated',
        (p) => p.threadId === threads[1] && p.projectId === project.id,
      )
      assert.equal(db.prepare('SELECT count(*) AS total FROM project_threads').get()?.total, 2)
      await client.request('thread/delete', { threadId: threads[0] })
      assert.equal(db.prepare('SELECT count(*) AS total FROM project_threads').get()?.total, 1)
      await client.close()
      assert.equal(client.trace.filter((m) => m.method === 'project/changed').length, 1)
      assert.equal(client.trace.filter((m) => m.method === 'thread/project/updated').length, 2)
      assert.equal(llm.requests.length, 0)
      llm.assertConsumed()
    } finally {
      db.close()
    }
  } finally {
    await client.close()
    await llm.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
