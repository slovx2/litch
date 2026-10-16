import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('CATALOG-001：原生模型及权限目录分页不重复，错误参数明确拒绝且不调用模型', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-model-catalog-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    for (const method of ['model/list', 'permissionProfile/list']) {
      const full = await client.request(method)
      assert.ok(full.data.length > 2, '必须真正跨页')
      const ids: string[] = []
      let cursor: string | null = null
      let firstCursor: string | null = null
      for (let page = 0; page < 10; page++) {
        const result = await client.request(method, { limit: 2, cursor })
        assert.ok(result.data.length <= 2)
        ids.push(...result.data.map((entry: any) => entry.id))
        cursor = result.nextCursor
        if (page === 0) firstCursor = cursor
        if (cursor === null) break
      }
      assert.equal(cursor, null, '分页必须终止')
      assert.ok(firstCursor, '目录不能忽略 limit')
      assert.deepEqual(
        ids,
        full.data.map((entry: any) => entry.id),
      )
      for (const limit of [0, -1, 1.5, '2', 1001]) {
        await client.raw(method, { limit }, -32602)
      }
      await client.raw(method, { cursor: 'not-a-cursor' }, -32602)
      const other = method === 'model/list' ? 'permissionProfile/list' : 'model/list'
      await client.raw(other, { cursor: firstCursor }, -32602)
    }
    await client.raw('model/list', { includeHidden: 'yes' }, -32602)
    await client.raw('permissionProfile/list', { cwd: 42 }, -32602)
    const first = await client.request('model/list', { limit: 2, includeHidden: false })
    await client.raw('model/list', { cursor: first.nextCursor, includeHidden: true }, -32602)
    const profiles = await client.request('permissionProfile/list')
    assert.deepEqual(
      profiles.data.map((entry: any) => entry.id),
      [':read-only', ':workspace', ':danger-full-access'],
    )
    assert.equal(model.requests.length, 0)
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('HISTORY-003：同时间戳会话分页不漏项，已加载列表游标前进且读取不调用模型', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-catalog-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const threads = []
    for (let index = 0; index < 8; index++) {
      const { thread } = await client.request('thread/start', { cwd: home })
      threads.push(thread)
      await client.request('thread/name/set', { threadId: thread.id, name: `catalog-${index}` })
      // 列表照上游不列还没说过话的会话：暂停的目标给它预览，又不调用模型
      await client.request('thread/goal/set', {
        threadId: thread.id,
        objective: `目录 ${index}`,
        status: 'paused',
      })
    }
    assert.ok(
      new Set(threads.map((thread) => thread.createdAt)).size < threads.length,
      '必须实际覆盖同时间戳，不能靠等待跨秒规避游标冲突',
    )
    for (const sortDirection of ['asc', 'desc']) {
      let cursor = null
      const ids: string[] = []
      for (let page = 0; page < 10; page++) {
        const result = await client.request('thread/list', {
          cwd: home,
          limit: 2,
          sortDirection,
          cursor,
        })
        ids.push(...result.data.map((thread: any) => thread.id))
        cursor = result.nextCursor
        if (cursor == null) break
      }
      assert.equal(cursor, null, '游标必须终止')
      assert.equal(ids.length, threads.length, `${sortDirection} 不能漏项或重复`)
      assert.deepEqual(new Set(ids), new Set(threads.map((thread) => thread.id)))
    }
    let cursor = null
    const loaded: string[] = []
    for (let page = 0; page < 10; page++) {
      const result = await client.request('thread/loaded/list', { limit: 2, cursor })
      loaded.push(...result.data)
      cursor = result.nextCursor
      if (cursor == null) break
    }
    assert.equal(cursor, null, '已加载列表不能无限返回第一页')
    assert.equal(loaded.length, threads.length)
    assert.deepEqual(new Set(loaded), new Set(threads.map((thread) => thread.id)))
    const filtered = await client.request('thread/list', { cwd: home, searchTerm: 'catalog-3' })
    assert.deepEqual(
      filtered.data.map((thread: any) => thread.id),
      [threads[3].id],
    )
    assert.equal(
      (await client.request('thread/list', { modelProviders: ['unrelated-provider'] })).data.length,
      0,
    )
    const first = await client.request('thread/list', {
      cwd: home,
      limit: 2,
      sortDirection: 'desc',
    })
    const second = await client.request('thread/list', {
      cwd: home,
      limit: 2,
      sortDirection: 'desc',
      cursor: first.nextCursor,
    })
    const backwards = await client.request('thread/list', {
      cwd: home,
      limit: 2,
      sortDirection: 'asc',
      cursor: second.backwardsCursor,
    })
    assert.deepEqual(
      backwards.data.map((thread: any) => thread.id),
      [second.data[0].id, first.data[1].id],
    )
    assert.equal(
      (await client.raw('thread/list', { cwd: home + '/other', cursor: first.nextCursor })).error
        .code,
      -32602,
    )
    assert.equal(
      (await client.raw('thread/loaded/list', { cursor: first.nextCursor })).error.code,
      -32602,
    )
    assert.equal((await client.raw('thread/list', { cursor: 'invalid' })).error.code, -32602)
    // 删除上一页边界后仍能继续，不能依赖边界记录继续存在。
    await client.request('thread/delete', { threadId: first.data[1].id })
    const afterDelete = await client.request('thread/list', {
      cwd: home,
      limit: 2,
      sortDirection: 'desc',
      cursor: first.nextCursor,
    })
    assert.deepEqual(
      afterDelete.data.map((thread: any) => thread.id),
      second.data.map((thread: any) => thread.id),
    )
    assert.equal(model.requests.length, 0)
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})
