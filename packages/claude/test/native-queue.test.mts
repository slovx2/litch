import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('QUEUE-008：原生队列持久顺序、编辑删除、事务失败、重启消费与消息去重', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-queue-'))
  const model = new MockLLM()
  const url = await model.start()
  let client = await ProtocolClient.start(home, url)
  const db = new DatabaseSync(join(home, 'adapter', 'state.sqlite'))
  const file = join(home, 'queue-effects.txt')
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      historyMode: 'paginated',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    model.enqueue(() => [{ type: 'text', text: 'QUEUE_WARMUP_DONE' }])
    const warmup = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'QUEUE_WARMUP' }],
    })
    assert.equal((await client.completed(warmup.turn.id)).status, 'completed')
    await client.request('thread/unsubscribe', { threadId: thread.id })
    const add = async (id: string, text = id) =>
      (
        await client.request('thread/queue/add', {
          threadId: thread.id,
          clientUserMessageId: id,
          input: [{ type: 'text', text }],
        })
      ).queuedSubmission
    const first = await add('QUEUE_FIRST')
    const second = await add('QUEUE_SECOND')
    const third = await add('QUEUE_DELETED')
    assert.deepEqual(await add('QUEUE_FIRST'), first)
    await client.raw(
      'thread/queue/add',
      {
        threadId: thread.id,
        clientUserMessageId: 'QUEUE_FIRST',
        input: [{ type: 'text', text: 'CONFLICT' }],
      },
      -32009,
    )
    const updated = await client.request('thread/queue/update', {
      threadId: thread.id,
      queuedSubmissionId: second.id,
      input: [{ type: 'text', text: 'QUEUE_SECOND_EDITED' }],
    })
    assert.equal(updated.queuedSubmission.clientUserMessageId, second.clientUserMessageId)
    await client.request('thread/queue/reorder', {
      threadId: thread.id,
      queuedSubmissionIds: [second.id, first.id, third.id],
    })
    const page = await client.request('thread/queue/list', { threadId: thread.id, limit: 1 })
    assert.deepEqual(page.data, [updated.queuedSubmission])
    const rest = await client.request('thread/queue/list', {
      threadId: thread.id,
      limit: 10,
      cursor: page.nextCursor,
    })
    assert.deepEqual(rest.data, [first, third])
    assert.equal(rest.nextCursor, null)
    const other = (await client.request('thread/start', { cwd: home })).thread
    await client.raw('thread/queue/list', { threadId: other.id, cursor: page.nextCursor }, -32602)
    await client.raw(
      'thread/queue/reorder',
      { threadId: thread.id, queuedSubmissionIds: [first.id, first.id] },
      -32602,
    )
    assert.equal(
      (
        await client.request('thread/queue/delete', {
          threadId: other.id,
          queuedSubmissionId: third.id,
        })
      ).deleted,
      false,
    )
    assert.equal(
      (
        await client.request('thread/queue/delete', {
          threadId: thread.id,
          queuedSubmissionId: third.id,
        })
      ).deleted,
      true,
    )
    assert.equal(
      (
        await client.request('thread/queue/delete', {
          threadId: thread.id,
          queuedSubmissionId: third.id,
        })
      ).deleted,
      false,
    )
    assert.equal(model.requests.length, 1, '未加载线程中的队列管理不能启动模型')
    db.exec(
      "CREATE TRIGGER reject_queue_claim BEFORE UPDATE OF state ON queued_submissions WHEN NEW.state='consumed' BEGIN SELECT RAISE(ABORT, 'QUEUE_CLAIM_FAILURE'); END",
    )
    const failure = await client.raw(
      'thread/queue/start',
      { threadId: thread.id, queuedSubmissionId: second.id },
      -32000,
    )
    assert.match(failure.error.message, /QUEUE_CLAIM_FAILURE/)
    assert.equal(
      db.prepare('SELECT count(*) AS total FROM turns WHERE thread_id=?').get(thread.id)?.total,
      1,
    )
    assert.equal(
      (await client.request('thread/queue/list', { threadId: thread.id })).data.length,
      2,
    )
    assert.equal(model.requests.length, 1, '原子领取失败不能执行模型或产生半个回合')
    db.exec('DROP TRIGGER reject_queue_claim')
    await client.close()
    client = await ProtocolClient.start(home, url)
    const before = await client.request('thread/queue/list', { threadId: thread.id })
    assert.deepEqual(
      before.data.map((item: { id: string }) => item.id),
      [second.id, first.id],
    )
    await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    assert.equal(model.requests.length, 1, '重启只读队列和历史不得重放')
    for (const marker of ['QUEUE_SECOND_EDITED', 'QUEUE_FIRST']) {
      model.enqueue((request) => {
        assert.ok(JSON.stringify(request.messages).includes(marker))
        assert.ok(!JSON.stringify(request.messages).includes('QUEUE_DELETED'))
        return [
          {
            type: 'tool_use',
            id: `toolu_${marker}`,
            name: 'Bash',
            input: { command: `printf '${marker}\n' >> '${file}'` },
          },
        ]
      })
      model.enqueue((request) => {
        assert.ok(JSON.stringify(request.messages).includes('tool_result'))
        return [{ type: 'text', text: `${marker}_DONE` }]
      })
    }
    await client.request('thread/resume', { threadId: thread.id })
    for (const marker of ['QUEUE_SECOND_EDITED', 'QUEUE_FIRST']) {
      const started = await client.notification(
        'item/started',
        (p) =>
          p.item?.type === 'userMessage' &&
          p.item.clientId === (marker === 'QUEUE_FIRST' ? marker : 'QUEUE_SECOND'),
      )
      assert.equal((await client.completed(started.turnId)).status, 'completed')
    }
    assert.equal(await readFile(file, 'utf8'), 'QUEUE_SECOND_EDITED\nQUEUE_FIRST\n')
    assert.equal(
      (await client.request('thread/queue/list', { threadId: thread.id })).data.length,
      0,
    )
    assert.equal(model.requests.length, 5)
    await client.raw(
      'thread/queue/add',
      {
        threadId: thread.id,
        clientUserMessageId: 'QUEUE_FIRST',
        input: [{ type: 'text', text: 'QUEUE_FIRST' }],
      },
      -32009,
    )
    await client.raw('thread/queue/start', { threadId: thread.id }, -32602)
    await client.request('thread/unsubscribe', { threadId: thread.id })
    const explicit = await add('QUEUE_EXPLICIT')
    model.enqueue(() => [{ type: 'text', text: 'QUEUE_EXPLICIT_DONE' }])
    const result = await client.request('thread/queue/start', {
      threadId: thread.id,
      queuedSubmissionId: explicit.id,
    })
    assert.equal((await client.completed(result.turn.id)).status, 'completed')
    const effectsBefore = await readFile(file, 'utf8')
    await client.close()
    client = await ProtocolClient.start(home, url)
    await client.request('thread/resume', { threadId: thread.id })
    assert.equal(
      (await client.request('thread/queue/list', { threadId: thread.id })).data.length,
      0,
    )
    assert.equal(model.requests.length, 6)
    assert.equal(await readFile(file, 'utf8'), effectsBefore)
    assert.ok(
      client.trace.every((message) => message.method !== 'turn/started'),
      '重启不得重放已消费队列',
    )
  } finally {
    await client.close()
    db.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})
