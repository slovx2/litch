import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('REVIEW-001：真实审查读取文件并闭合进入退出事件，detached保持父会话不变', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-review-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const file = join(home, 'review-target.txt')
    await writeFile(file, 'REAL_REVIEW_FILE_MARKER', { mode: 0o600 })
    const { thread } = await client.request('thread/start', { cwd: home, sandbox: 'read-only' })
    for (const delivery of ['inline', 'detached']) {
      model.enqueue((request) => {
        assert.match(JSON.stringify(request.messages), /REVIEW_INSTRUCTIONS/)
        return [
          {
            type: 'tool_use',
            id: `read_review_${delivery}`,
            name: 'Read',
            input: { file_path: file },
          },
        ]
      })
      model.enqueue((request) => {
        assert.match(JSON.stringify(request.messages), /REAL_REVIEW_FILE_MARKER/)
        return [{ type: 'text', text: `REVIEW_FINDING_${delivery}` }]
      })
      const result = await client.request('review/start', {
        threadId: thread.id,
        delivery,
        target: { type: 'custom', instructions: 'REVIEW_INSTRUCTIONS: read the target file' },
      })
      if (delivery === 'inline') assert.equal(result.reviewThreadId, thread.id)
      else assert.notEqual(result.reviewThreadId, thread.id, '独立审查必须创建独立会话')
      assert.equal((await client.completed(result.turn.id)).status, 'completed')
      const history = await client.request('thread/read', {
        threadId: result.reviewThreadId,
        includeTurns: true,
      })
      const items = history.thread.turns.at(-1).items
      assert.equal(items.filter((item: any) => item.type === 'enteredReviewMode').length, 1)
      assert.equal(items.filter((item: any) => item.type === 'exitedReviewMode').length, 1)
      assert.match(
        items.find((item: any) => item.type === 'exitedReviewMode').review,
        new RegExp(`REVIEW_FINDING_${delivery}`),
      )
      const events = client.trace.filter((event) => event.params?.turnId === result.turn.id)
      for (const type of ['enteredReviewMode', 'exitedReviewMode']) {
        assert.equal(
          events.filter(
            (event) => event.method === 'item/started' && event.params.item.type === type,
          ).length,
          1,
        )
        assert.equal(
          events.filter(
            (event) => event.method === 'item/completed' && event.params.item.type === type,
          ).length,
          1,
        )
      }
      assert.equal(await readFile(file, 'utf8'), 'REAL_REVIEW_FILE_MARKER')
    }
    const parent = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    assert.equal(parent.thread.turns.length, 1)
    assert.equal(model.requests.length, 4)
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('REVIEW-002：非法审查与活动回合并发请求不修改会话、不调用模型', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-review-conflict-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  try {
    const { thread } = await client.request('thread/start', { cwd: home })
    const base = { threadId: thread.id, target: { type: 'uncommittedChanges' } }
    for (const params of [
      { ...base, target: { type: 'unknown' } },
      { ...base, target: { type: 'baseBranch' } },
      { ...base, target: { type: 'commit', sha: '' } },
      { ...base, target: { type: 'custom', instructions: [] } },
      { ...base, delivery: 'invalid' },
    ])
      await client.raw('review/start', params, -32602)
    assert.equal(model.requests.length, 0)
    assert.equal(
      (await client.request('thread/read', { threadId: thread.id, includeTurns: true })).thread
        .turns.length,
      0,
    )
    model.enqueue(async () => {
      entered()
      await gate
      return [{ type: 'text', text: 'ORIGINAL_TURN_DONE' }]
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'ORIGINAL' }],
    })
    await ready
    for (const delivery of ['inline', 'detached'])
      await client.raw('review/start', { ...base, delivery }, -32009)
    release()
    assert.equal((await client.completed(turn.id)).status, 'completed')
    assert.equal(model.requests.length, 1)
    assert.equal(
      (await client.request('thread/read', { threadId: thread.id, includeTurns: true })).thread
        .turns.length,
      1,
    )
    model.assertConsumed()
  } finally {
    release()
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

for (const mode of ['failure', 'interrupt'] as const) {
  test(`REVIEW-003：真实审查${mode}退出事件唯一且先于回合终态`, { timeout: 60_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'native-review-end-'))
    const model = new MockLLM()
    const client = await ProtocolClient.start(home, await model.start())
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      const { thread } = await client.request('thread/start', { cwd: home })
      model.enqueue(async () => {
        entered()
        if (mode === 'failure') return { status: 401, message: 'review_fixture_auth_failure' }
        await gate
        return [{ type: 'text', text: 'LATE_REVIEW_MUST_NOT_COMPLETE' }]
      })
      const { turn } = await client.request('review/start', {
        threadId: thread.id,
        target: { type: 'uncommittedChanges' },
      })
      await ready
      if (mode === 'interrupt') {
        await client.request('turn/interrupt', { threadId: thread.id, turnId: turn.id })
        release()
      }
      assert.equal(
        (await client.completed(turn.id)).status,
        mode === 'failure' ? 'failed' : 'interrupted',
      )
      const history = await client.request('thread/read', {
        threadId: thread.id,
        includeTurns: true,
      })
      const items = history.thread.turns[0].items
      assert.equal(items.filter((item: any) => item.type === 'exitedReviewMode').length, 1)
      const endIndex = client.trace.findIndex(
        (event) =>
          event.method === 'item/completed' &&
          event.params.turnId === turn.id &&
          event.params.item.type === 'exitedReviewMode',
      )
      const turnIndex = client.trace.findIndex(
        (event) => event.method === 'turn/completed' && event.params.turn.id === turn.id,
      )
      assert.ok(endIndex >= 0 && endIndex < turnIndex)
      assert.equal(
        client.trace.filter(
          (event) => event.method === 'turn/completed' && event.params.turn.id === turn.id,
        ).length,
        1,
      )
      assert.equal(model.requests.length, 1)
      model.assertConsumed()
    } finally {
      release()
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
}
