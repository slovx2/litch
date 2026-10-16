import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { PiStore } from '../src/store.mjs'

test('Pi 拒绝旧适配数据库且不改写文件，新格式可重新打开', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cha-pi-format-'))
  const path = join(home, 'adapter.sqlite')
  try {
    const old = new DatabaseSync(path)
    old.exec('CREATE TABLE threads(id TEXT)')
    old.close()
    const before = await readFile(path)
    assert.throws(() => new PiStore(home), /旧适配器数据库不受支持/)
    assert.deepEqual(await readFile(path), before)
    await rm(path)
    const fresh = new PiStore(home)
    fresh.db.close()
    const reopened = new PiStore(home)
    assert.deepEqual(reopened.threads(), [])
    reopened.db.close()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// 0.6.0 的库：回合整个存在 turns 的一行里，没有 turn_items。建表语句照抄 0.6.0 的 store.mts
const SCHEMA_060 = `PRAGMA application_id = ${0x43484131};
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, data TEXT NOT NULL,
    updated_at INTEGER NOT NULL, ephemeral INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS turns(id TEXT NOT NULL, thread_id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(thread_id,id));
  CREATE INDEX IF NOT EXISTS turns_thread ON turns(thread_id, position);
  CREATE TABLE IF NOT EXISTS submissions(thread_id TEXT NOT NULL, message_id TEXT NOT NULL,
    hash TEXT NOT NULL, turn_id TEXT NOT NULL, PRIMARY KEY(thread_id,message_id));
  CREATE TABLE IF NOT EXISTS metadata(scope TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope,id));`

test('Pi 照常打开 0.6.0 的库：回合原样读出，没写完的回合标成被打断、条目都在，之后的回合按条目写', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cha-pi-060-'))
  const thread = {
    id: 't',
    path: null,
    cwd: home,
    name: null,
    preview: '你好',
    createdAt: 1,
    updatedAt: 2,
    ephemeral: false,
    model: null,
    effort: null,
    planMode: false,
    dynamicTools: [],
    forkedFromId: null,
  }
  const said = (id: string, text: string) => ({
    type: 'agentMessage',
    id,
    text,
    phase: 'final_answer',
    memoryCitation: null,
  })
  const done = {
    id: 'a',
    items: [said('a:1', '说完了')],
    status: 'completed' as const,
    error: null,
    startedAt: 10,
    completedAt: 20,
    durationMs: 10,
  }
  // 0.6.0 跑到一半被强杀留下的：状态还是进行中，条目在这一行里
  const cut = { ...done, id: 'b', items: [said('b:1', '说到一半')], status: 'inProgress' as const }
  try {
    const old = new DatabaseSync(join(home, 'adapter.sqlite'))
    old.exec(SCHEMA_060)
    old
      .prepare('INSERT INTO threads(id,data,updated_at,ephemeral) VALUES(?,?,?,?)')
      .run('t', JSON.stringify(thread), 2, 0)
    for (const [position, turn] of [done, cut].entries())
      old
        .prepare('INSERT INTO turns(id,thread_id,position,data) VALUES(?,?,?,?)')
        .run(turn.id, 't', position + 1, JSON.stringify(turn))
    old.close()

    const store = new PiStore(home)
    assert.deepEqual(store.threads(), [thread])
    const [first, second] = store.turns('t')
    assert.deepEqual(first, done)
    assert.deepEqual(second, {
      ...cut,
      status: 'interrupted',
      completedAt: second?.completedAt,
      durationMs: second?.durationMs,
    })
    // 新的回合：进行中按条目写，读出来和内存里的一样；结束后整个一行
    const turn = {
      id: 'c',
      items: [] as any[],
      status: 'inProgress' as const,
      error: null,
      startedAt: 30,
      completedAt: null,
      durationMs: null,
    }
    store.saveTurn('t', turn)
    turn.items.push(said('c:1', '新的'))
    store.saveItems('t', turn, [turn.items[0]])
    assert.deepEqual(store.turns('t').at(-1), turn)
    store.close()
    const reopened = new PiStore(home)
    assert.deepEqual(
      reopened.turns('t').map((t) => [t.id, t.status, t.items]),
      [
        ['a', 'completed', done.items],
        ['b', 'interrupted', cut.items],
        ['c', 'interrupted', turn.items],
      ],
    )
    reopened.close()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
