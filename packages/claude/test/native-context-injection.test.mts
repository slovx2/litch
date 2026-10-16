import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { promisify } from 'node:util'
import type { ContextInjection } from '../src/native-context.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const textItem = (text: string) => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }],
})

async function nativeMessages(home: string, sessionId: string): Promise<any[]> {
  const script = `import {getSessionMessages} from ${JSON.stringify(import.meta.resolve('@anthropic-ai/claude-agent-sdk'))}; console.log(JSON.stringify(await getSessionMessages(process.argv[1],{dir:process.argv[2]})));`
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', script, sessionId, home],
    {
      env: { HOME: home, CLAUDE_CONFIG_DIR: join(home, 'claude'), NODE_NO_WARNINGS: '1' },
      maxBuffer: 2_000_000,
    },
  )
  return JSON.parse(stdout)
}

function entries(db: DatabaseSync): Array<{ context: ContextInjection; committed: number }> {
  return db
    .prepare('SELECT context_json,committed FROM context_injections ORDER BY rowid')
    .all()
    .map((row) => ({
      context: JSON.parse(String(row.context_json)),
      committed: Number(row.committed),
    }))
}

async function startTurn(client: ProtocolClient, threadId: string, text: string): Promise<string> {
  const { turn } = await client.request('turn/start', { threadId, input: [{ type: 'text', text }] })
  assert.equal((await client.completed(turn.id)).status, 'completed')
  return turn.id
}

test('CONTEXT-009：图片精度偏好不阻断正文和图片追加，重启后真实入模且无重复追加', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-context-detail-'))
  const model = new MockLLM()
  const endpoint = await model.start()
  let client = await ProtocolClient.start(home, endpoint)
  const db = new DatabaseSync(join(home, 'adapter', 'state.sqlite'), { readOnly: true })
  try {
    const { thread } = await client.request('thread/start', { cwd: home, sandbox: 'read-only' })
    const items = ['auto', 'low', 'high', 'original'].map((detail) => ({
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: `DETAIL_PREFERENCE_${detail}` },
        { type: 'input_image', image_url: `data:image/png;base64,${png}`, detail },
      ],
    }))
    await client.request('thread/inject_items', { threadId: thread.id, items })
    assert.equal(model.requests.length, 0, '追加上下文不能触发模型')
    const [injection] = entries(db)
    assert.ok(injection)
    assert.equal(injection.committed, 1)
    const persisted = (await nativeMessages(home, injection.context.sessionId)).filter(
      (message) => message.uuid === injection.context.messageId,
    )
    assert.equal(persisted.length, 1)
    assert.deepEqual(persisted[0].message.content, injection.context.content)
    assert.equal(persisted[0].message.content.length, 8, '正文和图片必须全部保留')
    for (const invalid of [false, 1, 'unknown']) {
      await client.raw(
        'thread/inject_items',
        {
          threadId: thread.id,
          items: [
            textItem('INVALID_BATCH_MUST_NOT_PERSIST'),
            {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_image', image_url: `data:image/png;base64,${png}`, detail: invalid },
              ],
            },
          ],
        },
        -32602,
      )
    }
    assert.equal(entries(db).length, 1, '无效批次不能部分写入')
    await client.close()
    client = await ProtocolClient.start(home, endpoint)
    await client.request('thread/resume', { threadId: thread.id })
    model.enqueue((request) => {
      const blocks = request.messages.flatMap((message: any) =>
        Array.isArray(message.content) ? message.content : [],
      )
      for (const detail of ['auto', 'low', 'high', 'original'])
        assert.ok(
          blocks.some(
            (block: any) =>
              block.type === 'text' && block.text.includes(`DETAIL_PREFERENCE_${detail}`),
          ),
        )
      const images = blocks.filter((block: any) => block.type === 'image')
      assert.equal(images.length, 4)
      for (const image of images)
        assert.deepEqual(image.source, {
          type: 'base64',
          media_type: 'image/png',
          data: png,
        })
      assert.doesNotMatch(JSON.stringify(request.messages), /INVALID_BATCH_MUST_NOT_PERSIST/)
      return [{ type: 'text', text: 'ALL_DETAIL_IMAGES_PRESENT' }]
    })
    await startTurn(client, thread.id, 'CONTINUE_WITH_DETAIL_IMAGES')
    assert.equal(model.requests.length, 1)
    model.assertConsumed()
    assert.equal(entries(db).length, 1)
  } finally {
    db.close()
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('CONTEXT-004：真实原生追加零模型调用，文图重启入模，分叉回退保留边界且不伪造 Turn', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-context-inject-'))
  const model = new MockLLM()
  const endpoint = await model.start()
  let client = await ProtocolClient.start(home, endpoint)
  const db = new DatabaseSync(join(home, 'adapter', 'state.sqlite'), { readOnly: true })
  try {
    const { thread } = await client.request('thread/start', { cwd: home })
    const threadId = thread.id
    await mkdir(join(home, '.claude'))
    const hookMarker = join(home, 'unexpected-startup-hook.txt')
    const settingsPath = join(home, '.claude', 'settings.json')
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: `printf unexpected > '${hookMarker}'` }] },
          ],
        },
      }),
    )
    const firstItems = [
      textItem('INJECT_BEFORE_FIRST_8439'),
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'INJECT_SECOND_ITEM_8439' },
          { type: 'input_image', image_url: `data:image/png;base64,${png}`, detail: 'auto' },
        ],
      },
    ]
    const before = client.trace.length
    const injecting = client.request('thread/inject_items', { threadId, items: firstItems })
    await client.raw('thread/fork', { threadId }, -32009)
    await client.raw('thread/rollback', { threadId, numTurns: 1 }, -32009)
    await client.raw('thread/inject_items', { threadId, items: firstItems }, -32009)
    await injecting
    await assert.rejects(access(hookMarker), '上下文追加不能运行项目启动 hook')
    await rm(settingsPath)
    assert.equal(model.requests.length, 0)
    assert.equal(
      client.trace
        .slice(before)
        .some(
          (entry) =>
            ['turn/started', 'item/completed', 'turn/completed'].includes(entry.method) &&
            entry.direction !== 'client',
        ),
      false,
    )
    assert.deepEqual((await client.request('thread/read', { threadId })).thread.turns, [])
    const [injection] = entries(db)
    assert.equal(injection!.committed, 1)
    const history = await nativeMessages(home, injection!.context.sessionId)
    const persisted = history.filter((message) => message.uuid === injection!.context.messageId)
    assert.equal(persisted.length, 1)
    assert.deepEqual(persisted[0].message.content, injection!.context.content)
    assert.deepEqual(
      persisted[0].message.content.map((block: any) => block.type),
      ['text', 'text', 'image'],
    )
    await client.close()
    client = await ProtocolClient.start(home, endpoint)
    await client.request('thread/resume', { threadId })
    model.enqueue((request) => {
      const blocks = request.messages.flatMap((message: any) =>
        Array.isArray(message.content)
          ? message.content.map((block: any) => ({ role: message.role, ...block }))
          : [],
      )
      assert.ok(
        blocks.some(
          (block: any) =>
            block.role === 'user' &&
            block.type === 'text' &&
            block.text.includes('INJECT_BEFORE_FIRST_8439'),
        ),
      )
      assert.ok(
        blocks.some(
          (block: any) =>
            block.role === 'user' &&
            block.type === 'text' &&
            block.text.includes('INJECT_SECOND_ITEM_8439'),
        ),
      )
      assert.ok(
        blocks.some(
          (block: any) =>
            block.role === 'user' && block.type === 'image' && block.source.data === png,
        ),
      )
      return [{ type: 'text', text: 'KEPT_INJECTION_TURN_8439' }]
    })
    const kept = await startTurn(client, threadId, 'FIRST_REAL_TURN_8439')
    await client.request('thread/inject_items', {
      threadId,
      items: [textItem('INJECT_AFTER_KEPT_8439')],
    })
    const { thread: fork } = await client.request('thread/fork', { threadId })
    model.enqueue((request) => {
      assert.match(JSON.stringify(request.messages), /INJECT_AFTER_KEPT_8439/)
      return [{ type: 'text', text: 'FORK_INJECT_PRESENT_8439' }]
    })
    await startTurn(client, fork.id, 'CONTINUE_FORK_8439')
    model.enqueue(() => [{ type: 'text', text: 'DROP_THIS_TURN_8439' }])
    await startTurn(client, threadId, 'DROP_THIS_INPUT_8439')
    const rollback = await client.request('thread/rollback', { threadId, numTurns: 1 })
    assert.deepEqual(
      rollback.thread.turns.map((turn: any) => turn.id),
      [kept],
    )
    model.enqueue((request) => {
      const text = JSON.stringify(request.messages)
      assert.match(text, /INJECT_AFTER_KEPT_8439/)
      assert.doesNotMatch(text, /DROP_THIS_(?:TURN|INPUT)_8439/)
      return [{ type: 'text', text: 'ROLLBACK_INJECT_PRESENT_8439' }]
    })
    await startTurn(client, threadId, 'CONTINUE_AFTER_ROLLBACK_8439')
    assert.equal((await client.request('thread/read', { threadId })).thread.turns.length, 2)
    assert.equal(model.requests.length, 4)
    model.assertConsumed()
  } finally {
    db.close()
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('CONTEXT-005：原生追加整批校验、活动互斥及提交失败重启按 UUID 对账，不假成功或重复写入', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-context-failure-'))
  const model = new MockLLM()
  const endpoint = await model.start()
  let client = await ProtocolClient.start(home, endpoint)
  const db = new DatabaseSync(join(home, 'adapter', 'state.sqlite'))
  let releaseModel: (() => void) | undefined
  try {
    const { thread } = await client.request('thread/start', { cwd: home })
    const threadId = thread.id
    for (const invalid of [
      null,
      [],
      [
        textItem('VALID_BUT_BATCH_REJECTED'),
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'FAKE_ASSISTANT' }],
        },
      ],
      [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_audio', audio_url: 'audio.wav' }],
        },
      ],
      [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 1 }] }],
      [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_image', image_url: `data:image/png;base64,${png}`, detail: 'unknown' },
          ],
        },
      ],
      [
        {
          type: 'message',
          role: 'user',
          id: 'cannot-preserve-id',
          content: [{ type: 'input_text', text: 'id' }],
        },
      ],
    ])
      await client.raw('thread/inject_items', { threadId, items: invalid }, -32602)
    assert.deepEqual(entries(db), [], '后半批无效时前半批不能开始原生写入')
    assert.equal(model.requests.length, 0)
    // 历史数据库保留引擎身份；不能因当前进程默认 Claude 就改写旧 Codex 会话。
    db.prepare("UPDATE threads SET runtime_backend='codex' WHERE id=?").run(threadId)
    await client.raw(
      'thread/inject_items',
      { threadId, items: [textItem('FOREIGN_ENGINE')] },
      -32004,
    )
    assert.deepEqual(entries(db), [])
    assert.equal(
      db.prepare('SELECT claude_session_id FROM threads WHERE id=?').get(threadId)!
        .claude_session_id,
      null,
    )
    assert.equal(model.requests.length, 0)
    db.prepare("UPDATE threads SET runtime_backend='claude' WHERE id=?").run(threadId)
    db.exec(
      "CREATE TRIGGER reject_context_begin BEFORE INSERT ON context_injections BEGIN SELECT RAISE(ABORT, 'INJECT_BEGIN_FAILED'); END",
    )
    await client.raw(
      'thread/inject_items',
      { threadId, items: [textItem('BEGIN_MUST_FAIL')] },
      -32000,
    )
    assert.deepEqual(entries(db), [])
    db.exec('DROP TRIGGER reject_context_begin')
    db.exec(
      "CREATE TRIGGER reject_context_commit BEFORE UPDATE ON context_injections BEGIN SELECT RAISE(ABORT, 'INJECT_COMMIT_FAILED'); END",
    )
    const result = await client.raw(
      'thread/inject_items',
      { threadId, items: [textItem('PERSISTED_ITEM_A_9421'), textItem('PERSISTED_ITEM_B_9421')] },
      -32000,
    )
    assert.match(result.error.message, /INJECT_COMMIT_FAILED/)
    const [pending] = entries(db)
    assert.equal(pending!.committed, 0)
    assert.equal(
      db.prepare('SELECT claude_session_id FROM threads WHERE id=?').get(threadId)!
        .claude_session_id,
      null,
    )
    const before = await nativeMessages(home, pending!.context.sessionId)
    assert.equal(before.filter((message) => message.uuid === pending!.context.messageId).length, 1)
    assert.deepEqual(
      before.find((message) => message.uuid === pending!.context.messageId).message.content,
      pending!.context.content,
    )
    assert.deepEqual((await client.request('thread/read', { threadId })).thread.turns, [])
    assert.equal(model.requests.length, 0)
    db.exec('DROP TRIGGER reject_context_commit')
    await client.close()
    client = await ProtocolClient.start(home, endpoint)
    // 只破坏适配器 journal 来验完整内容对账；不伪造或改写原生历史。
    db.prepare('UPDATE context_injections SET context_json=? WHERE message_id=?').run(
      JSON.stringify({ ...pending!.context, content: [{ type: 'text', text: 'MISMATCH' }] }),
      pending!.context.messageId,
    )
    const mismatch = await client.raw('thread/resume', { threadId }, -32000)
    assert.match(mismatch.error.message, /持久内容不一致/)
    assert.equal(entries(db)[0]!.committed, 0)
    db.prepare('UPDATE context_injections SET context_json=? WHERE message_id=?').run(
      JSON.stringify(pending!.context),
      pending!.context.messageId,
    )
    await client.request('thread/resume', { threadId })
    assert.equal(entries(db)[0]!.committed, 1)
    const after = await nativeMessages(home, pending!.context.sessionId)
    assert.deepEqual(after, before, '已写完整批次必须直接对账，不能重放已有 UUID 或新增原生占位')
    assert.equal(model.requests.length, 0)
    const heldModel = new Promise<void>((resolve) => {
      releaseModel = resolve
    })
    model.enqueue(async (request) => {
      const blocks = request.messages.flatMap((message: any) =>
        Array.isArray(message.content) ? message.content : [],
      )
      for (const text of ['PERSISTED_ITEM_A_9421', 'PERSISTED_ITEM_B_9421'])
        assert.equal(
          blocks.filter((block: any) => block.type === 'text' && block.text.includes(text)).length,
          1,
        )
      assert.doesNotMatch(
        JSON.stringify(request.messages),
        /VALID_BUT_BATCH_REJECTED|BEGIN_MUST_FAIL|MISMATCH/,
      )
      await heldModel
      return [{ type: 'text', text: 'PERSISTED_BATCH_RESUMED' }]
    })
    const { turn } = await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'RESUME_AFTER_FAILED_COMMIT' }],
    })
    await client.raw(
      'thread/inject_items',
      { threadId, items: [textItem('ACTIVE_MUST_REJECT')] },
      -32009,
    )
    await client.raw('thread/fork', { threadId }, -32009)
    await client.raw('thread/rollback', { threadId, numTurns: 1 }, -32009)
    assert.equal(entries(db).length, 1)
    releaseModel!()
    assert.equal((await client.completed(turn.id)).status, 'completed')
    assert.equal(model.requests.length, 1)
    model.assertConsumed()
  } finally {
    releaseModel?.()
    db.close()
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
