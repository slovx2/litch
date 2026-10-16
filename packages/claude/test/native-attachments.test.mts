import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('ATTACHMENT-002：真实回合附件幂等、分页隔离、通知及删除跨重启持久，不改历史和源文件', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-attachments-'))
  const llm = new MockLLM()
  const url = await llm.start()
  let client = await ProtocolClient.start(home, url)
  const source = join(home, 'source.txt')
  await writeFile(source, '附件元数据不能删除源文件\n')
  try {
    const threads: string[] = []
    const histories: unknown[] = []
    for (const name of ['owner', 'other']) {
      const { thread } = await client.request('thread/start', { cwd: home })
      threads.push(thread.id)
      llm.enqueue(() => [{ type: 'text', text: `ATTACHMENT_${name}_OK` }])
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: `记录 ${name} 的独立历史` }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
      histories.push(
        (
          await client.request('thread/read', {
            threadId: thread.id,
            includeTurns: true,
          })
        ).thread.turns,
      )
    }
    const [threadId, otherId] = threads
    const identity = { threadId, attachmentType: 'source', identityKey: 'same-key' }
    const payload = { source, empty: '', zero: 0, enabled: false, nested: [null, { value: 1 }] }
    const created = await client.request('thread/attachment/add', { ...identity, payload })
    assert.equal(created.outcome, 'created')
    assert.deepEqual(created.attachment.payload, payload)
    assert.ok(created.attachment.id)
    assert.ok(Number.isInteger(created.attachment.createdAt))
    assert.deepEqual(await client.notification('thread/attachment/updated'), {
      ...identity,
      attachmentId: created.attachment.id,
      operation: 'created',
    })
    const duplicates = await Promise.all(
      Array.from({ length: 4 }, () =>
        client.request('thread/attachment/add', { ...identity, payload: { replace: true } }),
      ),
    )
    for (const duplicate of duplicates)
      assert.deepEqual(duplicate, { outcome: 'existing', attachment: created.attachment })
    const expected = [created.attachment]
    for (const [index, value] of [null, false, 0, '', ['a', 2]].entries()) {
      const added = await client.request('thread/attachment/add', {
        ...identity,
        attachmentType: `type-${index}`,
        payload: value,
      })
      assert.equal(added.outcome, 'created')
      assert.deepEqual(added.attachment.payload, value)
      expected.push(added.attachment)
      await client.notification(
        'thread/attachment/updated',
        (p) => p.attachmentId === added.attachment.id && p.operation === 'created',
      )
    }
    const other = await client.request('thread/attachment/add', {
      ...identity,
      threadId: otherId,
      payload: 'other-thread',
    })
    assert.equal(other.outcome, 'created')
    assert.notEqual(other.attachment.id, created.attachment.id)
    await client.notification('thread/attachment/updated', (p) => p.threadId === otherId)
    const full = await client.request('thread/attachment/list', { threadId })
    assert.equal(full.nextCursor, null)
    assert.deepEqual(new Set(full.data.map((a: any) => a.id)), new Set(expected.map((a) => a.id)))
    let cursor: string | null = null
    let firstCursor: string | null = null
    const collected = []
    for (let page = 0; page < 10; page++) {
      const result = await client.request('thread/attachment/list', { threadId, limit: 1, cursor })
      assert.equal(result.data.length, 1)
      collected.push(...result.data)
      cursor = result.nextCursor
      if (page === 0) firstCursor = cursor
      if (cursor === null) break
    }
    assert.equal(cursor, null)
    assert.ok(firstCursor)
    assert.deepEqual(collected, full.data)
    await client.raw('thread/attachment/list', { threadId: otherId, cursor: firstCursor }, -32602)
    await client.raw('thread/attachment/list', { threadId, cursor: 'invalid' }, -32602)
    for (const limit of [0, -1, 1.5, '1', 1001])
      await client.raw('thread/attachment/list', { threadId, limit }, -32602)
    for (const params of [{ ...identity }, { ...identity, payload: null, identityKey: 3 }])
      await client.raw('thread/attachment/add', params, -32602)
    for (const method of ['add', 'list', 'remove'])
      await client.raw(
        `thread/attachment/${method}`,
        { ...identity, threadId: 'unknown', payload: null },
        -32602,
      )
    await client.close()
    assert.equal(client.trace.filter((m) => m.method === 'thread/attachment/updated').length, 7)
    client = await ProtocolClient.start(home, url)
    assert.deepEqual(await client.request('thread/attachment/list', { threadId }), full)
    await client.request('thread/resume', { threadId })
    // 删除上一页边界后，游标仍须前进，不依赖被删记录存在。
    const boundary = full.data[0]
    await client.request('thread/attachment/remove', { threadId, ...boundary })
    await client.notification('thread/attachment/updated', (p) => p.attachmentId === boundary.id)
    assert.deepEqual(
      (
        await client.request('thread/attachment/list', {
          threadId,
          cursor: firstCursor,
        })
      ).data,
      full.data.slice(1),
    )
    for (const attachment of full.data.slice(1)) {
      await client.request('thread/attachment/remove', { threadId, ...attachment })
      await client.notification(
        'thread/attachment/updated',
        (p) => p.attachmentId === attachment.id,
      )
    }
    assert.deepEqual(await client.request('thread/attachment/remove', identity), {})
    assert.deepEqual(await client.request('thread/attachment/list', { threadId }), {
      data: [],
      nextCursor: null,
    })
    await client.close()
    const deleted = client.trace.filter((m) => m.method === 'thread/attachment/updated')
    assert.equal(deleted.length, expected.length, '幂等删除不能重复通知')
    assert.ok(deleted.every((m) => m.params.operation === 'deleted'))
    for (const attachment of expected)
      assert.deepEqual(deleted.find((m) => m.params.attachmentId === attachment.id)?.params, {
        threadId,
        attachmentType: attachment.attachmentType,
        identityKey: attachment.identityKey,
        attachmentId: attachment.id,
        operation: 'deleted',
      })
    client = await ProtocolClient.start(home, url)
    assert.deepEqual(await client.request('thread/attachment/list', { threadId }), {
      data: [],
      nextCursor: null,
    })
    assert.deepEqual(await client.request('thread/attachment/list', { threadId: otherId }), {
      data: [other.attachment],
      nextCursor: null,
    })
    for (const [index, id] of threads.entries())
      assert.deepEqual(
        (await client.request('thread/read', { threadId: id, includeTurns: true })).thread.turns,
        histories[index],
      )
    await client.request('thread/delete', { threadId: otherId })
    await client.raw('thread/attachment/list', { threadId: otherId }, -32602)
    await client.close()
    const db = new DatabaseSync(join(home, 'adapter', 'state.sqlite'), { readOnly: true })
    try {
      assert.equal(db.prepare('SELECT count(*) AS total FROM thread_attachments').get()?.total, 0)
    } finally {
      db.close()
    }
    assert.equal(await readFile(source, 'utf8'), '附件元数据不能删除源文件\n')
    assert.equal(llm.requests.length, 2, '附件维护不能触发模型或重放回合')
    llm.assertConsumed()
  } finally {
    await client.close()
    await llm.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
