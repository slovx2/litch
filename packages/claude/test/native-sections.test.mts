import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('SESSION-004：真实会话分组分页、重排、重启及删除保持原生历史', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-sections-'))
  const llm = new MockLLM()
  const url = await llm.start()
  let client = await ProtocolClient.start(home, url)
  const marker = `SECTION_CONTEXT_${randomUUID()}`
  try {
    const first = (await client.request('thread/start', { cwd: home })).thread.id
    const second = (await client.request('thread/start', { cwd: home })).thread.id
    llm.enqueue(() => [{ type: 'text', text: marker }])
    const { turn } = await client.request('turn/start', {
      threadId: first,
      input: [{ type: 'text', text: '保存分组前的真实会话上下文' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    const created: Array<{ id: string; name: string }> = []
    for (const name of ['待执行', '待复核', '已完成']) {
      const { section } = await client.request('threadSection/create', { name })
      assert.equal(section.name, name)
      assert.ok(section.id)
      created.push(section)
    }
    const listAll = async () => {
      const items: Array<{ id: string; name: string }> = []
      const cursors = new Set<string>()
      let cursor: string | null = null
      do {
        const page = await client.request('threadSection/list', { limit: 1, cursor })
        assert.equal(page.data.length, 1)
        items.push(...page.data)
        cursor = page.nextCursor
        if (cursor !== null) {
          assert.ok(!cursors.has(cursor), '分页游标不能循环')
          cursors.add(cursor)
        }
      } while (cursor !== null)
      assert.equal(new Set(items.map((item) => item.id)).size, items.length)
      return items
    }
    const sections = await listAll()
    assert.equal(sections.length, 4)
    for (const section of created) assert.ok(sections.some((item) => item.id === section.id))
    const pinned = sections.find((item) => !created.some((section) => section.id === item.id))!
    const sectionId = created[0]!.id
    await client.request('thread/section/move', { threadId: first, sectionId })
    await client.request('thread/section/move', {
      threadId: second,
      sectionId,
      beforeThreadId: first,
    })
    const order = async () =>
      (
        await client.request('thread/list', {
          sectionId,
          sortKey: 'section_position',
          sortDirection: 'asc',
        })
      ).data.map((thread: { id: string }) => thread.id)
    assert.deepEqual(await order(), [second, first])
    const renamed = await client.request('threadSection/update', { sectionId, name: '审核中' })
    assert.equal(renamed.section.id, sectionId)
    assert.equal(renamed.section.name, '审核中')
    const failedMove = await client.raw('thread/section/move', {
      threadId: first,
      sectionId: randomUUID(),
    })
    assert.ok(failedMove.error, '不存在的目标分组不能返回成功')
    assert.deepEqual(await order(), [second, first], '失败移动不能改变原分组顺序')
    assert.ok(
      (
        await client.raw('threadSection/update', {
          sectionId: randomUUID(),
          name: '不存在',
        })
      ).error,
    )
    assert.ok((await client.raw('threadSection/delete', { sectionId: pinned.id })).error)
    assert.equal(llm.requests.length, 1, '分组维护不能隐式启动模型')
    await client.close()
    client = await ProtocolClient.start(home, url)
    assert.equal((await listAll()).find((item) => item.id === sectionId)?.name, '审核中')
    assert.deepEqual(await order(), [second, first])
    const history = await client.request('thread/read', { threadId: first, includeTurns: true })
    assert.ok(JSON.stringify(history).includes(marker))
    assert.equal(history.thread.section.id, sectionId)
    llm.enqueue((request) => {
      assert.ok(JSON.stringify(request.messages).includes(marker), '原生恢复必须保留分组前上下文')
      return [{ type: 'text', text: 'SECTION_RESUMED' }]
    })
    const resumed = await client.request('turn/start', {
      threadId: first,
      input: [{ type: 'text', text: '在重排后的分组中继续' }],
    })
    assert.equal((await client.completed(resumed.turn.id)).status, 'completed')
    await client.request('threadSection/delete', { sectionId })
    assert.ok((await client.raw('threadSection/delete', { sectionId })).error)
    await client.close()
    client = await ProtocolClient.start(home, url)
    const remaining = await listAll()
    assert.equal(remaining.length, 3)
    assert.ok(!remaining.some((item) => item.id === sectionId))
    for (const threadId of [first, second]) {
      const { thread } = await client.request('thread/read', { threadId, includeTurns: true })
      assert.equal(thread.section, null)
      assert.equal(thread.isPinned, false)
    }
    assert.equal(llm.requests.length, 2)
    llm.assertConsumed()
  } finally {
    await client.close()
    await llm.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
