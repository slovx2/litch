import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { ProtocolError, submissionHash } from '../src/protocol-contract.mjs'
import { SessionStore } from '../src/store.mjs'
import type { ThreadRecord, TurnRecord } from '../src/types.mjs'

test('SUBMIT-002：工具执行意图在重启后保留，不确定结果不能重放', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tool-ledger-'))
  let store = new SessionStore(join(directory, 'ledger.sqlite'))
  try {
    assert.equal(store.reserveTool('thread', 'call-1', 'hash'), null)
    store.close()
    store = new SessionStore(join(directory, 'ledger.sqlite'))
    assert.throws(
      () => store.reserveTool('thread', 'call-1', 'hash'),
      (error: unknown) => error instanceof ProtocolError && error.code === -32010,
    )
    store.completeTool('thread', 'call-1', { success: true, contentItems: [] })
    assert.deepEqual(store.reserveTool('thread', 'call-1', 'hash'), {
      result: { success: true, contentItems: [] },
    })
    assert.throws(
      () => store.reserveTool('thread', 'call-1', 'changed'),
      (error: unknown) => error instanceof ProtocolError && error.code === -32009,
    )
    assert.equal(store.reserveTool('other-thread', 'call-1', 'hash'), null)
    assert.equal(submissionHash({ b: 2, a: 1 }), submissionHash({ a: 1, b: 2 }))
  } finally {
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('CONTEXT-003：rollback 数据库失败时原生指针与历史一起回滚，同秒 Turn 按插入顺序回退', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rollback-atomic-'))
  const path = join(directory, 'state.sqlite')
  let store = new SessionStore(path)
  const connection = new DatabaseSync(path)
  const thread: ThreadRecord = {
    id: 'thread',
    sessionId: 'thread',
    forkedFromId: null,
    preview: '',
    name: null,
    archived: false,
    cwd: directory,
    model: 'sonnet',
    reasoningEffort: null,
    modelProvider: 'claude-code',
    runtimeBackend: 'claude',
    claudeSessionId: 'original',
    codexSessionId: null,
    source: 'appServer',
    createdAt: 1,
    updatedAt: 1,
    status: { type: 'idle' },
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
    ephemeral: false,
    threadSource: 'user',
    agentRole: null,
    agentNickname: null,
    baseInstructions: null,
    developerInstructions: null,
    personality: null,
  }
  const turn = (id: string): TurnRecord => ({
    id,
    threadId: thread.id,
    status: 'completed',
    startedAt: 1,
    completedAt: 1,
    durationMs: 0,
    items: [],
    diff: '',
    error: null,
  })
  try {
    store.upsertThread(thread)
    store.saveSubmission(turn('first'), 'm1', 'h1')
    store.saveSubmission(turn('second'), 'm2', 'h2')
    store.saveNativeBoundary('second', 'native-second')
    store.saveNativeBoundary('first', 'native-first')
    const boundaries = new Map([['first', 'fork-first']])
    connection.exec(
      "CREATE TRIGGER fail_delete BEFORE DELETE ON turns BEGIN SELECT RAISE(ABORT, 'injected disk failure'); END",
    )
    assert.throws(
      () => store.commitRollback({ ...thread, claudeSessionId: 'fork' }, 1, boundaries),
      /injected disk failure/,
    )
    assert.equal(store.getThread(thread.id)?.claudeSessionId, 'original')
    assert.equal(store.listTurns(thread.id).length, 2)
    assert.equal(store.nativeBoundary('first'), 'native-first')
    connection.exec('DROP TRIGGER fail_delete')
    connection.exec(
      "CREATE TRIGGER fail_boundary BEFORE UPDATE ON native_turn_boundaries BEGIN SELECT RAISE(ABORT, 'injected boundary failure'); END",
    )
    assert.throws(
      () => store.commitRollback({ ...thread, claudeSessionId: 'fork' }, 1, boundaries),
      /injected boundary failure/,
    )
    assert.equal(store.getThread(thread.id)?.claudeSessionId, 'original')
    assert.equal(store.listTurns(thread.id).length, 2)
    assert.equal(store.nativeBoundary('first'), 'native-first')
    assert.equal(store.nativeBoundary('second'), 'native-second')
    connection.exec('DROP TRIGGER fail_boundary')
    assert.equal(store.commitRollback({ ...thread, claudeSessionId: 'fork' }, 1, boundaries), 1)
    store.close()
    store = new SessionStore(path)
    assert.equal(store.getThread(thread.id)?.claudeSessionId, 'fork')
    assert.equal(store.nativeBoundary('first'), 'fork-first')
    assert.deepEqual(
      store.listTurns(thread.id).map((entry) => entry.id),
      ['first'],
    )
    assert.equal(store.nativeBoundary('second'), null)
    assert.throws(() => store.submittedTurn(thread.id, 'm2', 'h2'), /已被回退/)
  } finally {
    connection.close()
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
