import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  ProtocolError,
  submissionHash,
  ThreadNotFound,
} from '../../shared/src/protocol-contract.mjs'
import { assertStoreFormat, initializeStoreFormat } from '../../shared/src/store-format.mjs'
import { ensureParent } from '../../shared/src/util.mjs'

export interface PiThread {
  id: string
  path: string | null
  cwd: string
  name: string | null
  preview: string
  createdAt: number
  updatedAt: number
  ephemeral: boolean
  model: string | null
  effort: string | null
  planMode: boolean
  dynamicTools: any[]
  forkedFromId: string | null
  // Pi 自己分出来的会话（命令行里的 /fork 之类）在文件头里记的上级：是上级会话的文件路径，不是会话号。
  // 报 forkedFromId 时按路径换成会话号（PiServer.envelope），找不到就是 null
  forkedFromPath?: string | null
  parentThreadId?: string | null
}
export interface PiTurn {
  id: string
  items: any[]
  status: 'inProgress' | 'completed' | 'interrupted' | 'failed'
  error: { message: string; codexErrorInfo: null; additionalDetails: null } | null
  startedAt: number
  completedAt: number | null
  durationMs: number | null
}

// 仅保存协议投影、提交账本和界面元数据；模型上下文始终由 Pi SessionManager 读取。
//
// 回合怎么存（turns 和 turn_items 两张表）：结束了的回合（完成、失败、被打断）整个是 turns 里的一行。
// 进行中的回合在 turns 里只有回合本身（标识、状态、错误、时间），条目是空的；条目一个一行放在 turn_items，
// 行号是条目在回合里的位置。所以回合进行时多了或者改了一个条目，写的只是这一个条目，不随回合里已有的条目变多。
// 回合结束时整个写成一行，它在 turn_items 里的那些行删掉。读的时候把 turn_items 里的条目按位置放回回合里
// （turns()），读到的和整个回合存成一行时一样。
export class PiStore {
  readonly db: DatabaseSync
  /**
   * 记了一笔、还没写进库的条目（见 saveItemsLater）：会话标识 → 回合和这些条目的位置。
   * 一个会话同时只有一个回合在进行
   */
  private readonly unsaved = new Map<string, { turn: PiTurn; positions: Set<number> }>()
  /** 进行中的回合上回写进 turns 的那一行（回合本身，不带条目）：会话标识 → 回合标识和那一行。没变就不再写 */
  private readonly headers = new Map<string, { id: string; data: string }>()
  /** 这次运行里存过的临时会话（上次的启动时就删了）。发通知时要问，放在内存里，库关了也问得到 */
  private readonly transient = new Set<string>()
  constructor(home: string) {
    const path = join(home, 'adapter.sqlite')
    assertStoreFormat(path)
    ensureParent(path)
    this.db = new DatabaseSync(path)
    initializeStoreFormat(this.db)
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, data TEXT NOT NULL,
        updated_at INTEGER NOT NULL, ephemeral INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS turns(id TEXT NOT NULL, thread_id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(thread_id,id));
      CREATE INDEX IF NOT EXISTS turns_thread ON turns(thread_id, position);
      CREATE TABLE IF NOT EXISTS turn_items(thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, position INTEGER NOT NULL,
        data TEXT NOT NULL, PRIMARY KEY(thread_id,turn_id,position));
      CREATE TABLE IF NOT EXISTS submissions(thread_id TEXT NOT NULL, message_id TEXT NOT NULL,
        hash TEXT NOT NULL, turn_id TEXT NOT NULL, PRIMARY KEY(thread_id,message_id));
      CREATE TABLE IF NOT EXISTS metadata(scope TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope,id));`)
    for (const thread of this.threads()) {
      if (thread.ephemeral) {
        this.delete(thread.id)
        continue
      }
      for (const turn of this.turns(thread.id))
        if (turn.status === 'inProgress') {
          turn.status = 'interrupted'
          turn.completedAt = Date.now()
          turn.durationMs = turn.completedAt - turn.startedAt
          this.saveTurn(thread.id, turn)
        }
    }
  }
  threads(): PiThread[] {
    return this.db
      .prepare('SELECT data FROM threads ORDER BY updated_at,id')
      .all()
      .map((r) => JSON.parse(String(r.data)))
  }
  /** 有过回合的会话（进行中的也算）：列会话时认“说过话”用，一次查完 */
  threadsWithTurns(): Set<string> {
    return new Set(
      this.db
        .prepare('SELECT DISTINCT thread_id FROM turns')
        .all()
        .map((r) => String(r.thread_id)),
    )
  }
  /** 是不是临时会话（客户端起标题、摘要用的，不进列表） */
  ephemeral(id: string): boolean {
    return this.transient.has(id)
  }
  /** 原生会话文件在这个路径上的会话号，没有就是 null */
  threadAt(path: string): string | null {
    const row = this.db
      .prepare("SELECT id FROM threads WHERE json_extract(data,'$.path')=? LIMIT 1")
      .get(path)
    return row ? String(row.id) : null
  }
  thread(id: string): PiThread {
    const row = this.db.prepare('SELECT data FROM threads WHERE id=?').get(id)
    // 话术照上游：桌面端找会话在哪台机器上时拿别处的会话号来问，按这句认“这里没有”（ThreadNotFound）
    if (!row) throw new ThreadNotFound(id)
    return JSON.parse(String(row.data))
  }
  // 归档是适配器侧的界面状态，不改动 Pi 原生会话文件。
  archivedIds(): Set<string> {
    return new Set(
      this.db
        .prepare('SELECT id FROM threads WHERE archived=1')
        .all()
        .map((r) => String(r.id)),
    )
  }
  setArchived(id: string, archived: boolean): void {
    this.thread(id)
    this.db.prepare('UPDATE threads SET archived=? WHERE id=?').run(Number(archived), id)
  }
  saveThread(thread: PiThread): void {
    if (thread.ephemeral) this.transient.add(thread.id)
    else this.transient.delete(thread.id)
    this.db
      .prepare(`INSERT INTO threads(id,data,updated_at,ephemeral) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at,ephemeral=excluded.ephemeral`)
      .run(thread.id, JSON.stringify(thread), thread.updatedAt, Number(thread.ephemeral))
  }
  turns(id: string): PiTurn[] {
    this.flush(id)
    const turns: PiTurn[] = this.db
      .prepare('SELECT data FROM turns WHERE thread_id=? ORDER BY position,id')
      .all(id)
      .map((r) => JSON.parse(String(r.data)))
    // 进行中的回合的条目在 turn_items 里，按位置放回去
    const items = this.db
      .prepare('SELECT turn_id,position,data FROM turn_items WHERE thread_id=?')
      .all(id)
    if (items.length) {
      const byId = new Map(turns.map((turn) => [turn.id, turn]))
      for (const row of items) {
        const turn = byId.get(String(row.turn_id))
        if (turn) turn.items[Number(row.position)] = JSON.parse(String(row.data))
      }
    }
    return turns
  }
  /** 整个回合写一遍：结束了的写成 turns 里的一行；进行中的写回合本身和它的全部条目（存法见类前的说明） */
  saveTurn(threadId: string, turn: PiTurn): void {
    if (this.unsaved.get(threadId)?.turn.id === turn.id) this.unsaved.delete(threadId)
    if (turn.status === 'inProgress') {
      this.headers.delete(threadId)
      this.atomically(() => {
        this.db
          .prepare('DELETE FROM turn_items WHERE thread_id=? AND turn_id=?')
          .run(threadId, turn.id)
        this.writeItems(threadId, turn, turn.items.keys())
      })
      return
    }
    if (this.headers.get(threadId)?.id === turn.id) this.headers.delete(threadId)
    this.atomically(() => {
      this.writeRow(threadId, turn.id, JSON.stringify(turn))
      this.db
        .prepare('DELETE FROM turn_items WHERE thread_id=? AND turn_id=?')
        .run(threadId, turn.id)
    })
  }
  /**
   * 进行中的回合里这几个条目新加了或者改了：只写这几个条目，回合本身（状态、错误）变了的话连同它那一行，
   * 写的量和回合里已有多少条目无关。条目要已经放进回合里了。回合已经结束的整个写一遍（saveTurn）
   */
  saveItems(threadId: string, turn: PiTurn, items: Iterable<any>): void {
    // 别的回合记下的那一笔先写掉（一个会话同时只有一个回合在进行，不会有）
    const other = this.unsaved.get(threadId)
    if (other && other.turn !== turn) this.flush(threadId)
    if (turn.status !== 'inProgress') {
      this.saveTurn(threadId, turn)
      return
    }
    const positions = new Set(this.positions(turn, items))
    // 这个回合记下的那一笔一起写
    for (const position of this.unsaved.get(threadId)?.positions ?? []) positions.add(position)
    this.unsaved.delete(threadId)
    this.writeItems(threadId, turn, positions)
  }
  /**
   * 条目里流式的内容多了一段（正文、思考、命令的输出）：只记一笔，先不写。
   * 一次写的是整个条目，每来一条增量就写的话，写的量和这个条目已有的长度成正比，回答越长每条越贵。
   * 记下的这一笔，在有人读这个会话的回合之前（turns）、或者回合有了别的动静时（saveItems、saveTurn）写进去，
   * 所以读到的总是最新的。进程被强杀时库里少的是最后一次写之后流出来的那一截，
   * 这一截原生会话里也还没有（Pi 等一条消息说完才记）。
   */
  saveItemsLater(threadId: string, turn: PiTurn, items: Iterable<any>): void {
    const positions = this.positions(turn, items)
    if (!positions.length) return
    if (this.unsaved.get(threadId)?.turn !== turn) this.flush(threadId)
    const pending = this.unsaved.get(threadId) ?? { turn, positions: new Set<number>() }
    for (const position of positions) pending.positions.add(position)
    this.unsaved.set(threadId, pending)
  }
  private flush(threadId: string): void {
    const pending = this.unsaved.get(threadId)
    if (pending) this.saveItems(threadId, pending.turn, [])
  }
  /** 这些条目在回合里的位置。变了的条目多半在末尾，从后往前找 */
  private positions(turn: PiTurn, items: Iterable<any>): number[] {
    const positions: number[] = []
    for (const item of items) {
      const position = turn.items.lastIndexOf(item)
      if (position >= 0) positions.push(position)
    }
    return positions
  }
  /** 进行中的回合：回合本身和上回写的不一样才写它那一行，再写这几个位置上的条目 */
  private writeItems(threadId: string, turn: PiTurn, positions: Iterable<number>): void {
    const header = JSON.stringify({ ...turn, items: [] })
    const written = this.headers.get(threadId)
    const changed = written?.id !== turn.id || written.data !== header
    const items = [...positions]
    if (!changed && !items.length) return
    this.atomically(() => {
      if (changed) this.writeRow(threadId, turn.id, header)
      const item =
        this.db.prepare(`INSERT INTO turn_items(thread_id,turn_id,position,data) VALUES(?,?,?,?)
        ON CONFLICT(thread_id,turn_id,position) DO UPDATE SET data=excluded.data`)
      for (const position of items)
        item.run(threadId, turn.id, position, JSON.stringify(turn.items[position]))
    })
    this.headers.set(threadId, { id: turn.id, data: header })
  }
  /** turns 里回合的那一行：已经有了就换掉内容，没有就排在这个会话的最后 */
  private writeRow(threadId: string, turnId: string, data: string): void {
    this.db
      .prepare(`INSERT INTO turns(id,thread_id,position,data)
      SELECT ?,?,COALESCE(MAX(position),0)+1,? FROM turns WHERE thread_id=?
      ON CONFLICT(thread_id,id) DO UPDATE SET data=excluded.data`)
      .run(turnId, threadId, data, threadId)
  }
  /** 几条写入要么都成、要么都不成。用的是保存点，在 admit、replaceTurns 开着的事务里面也能用 */
  private atomically(write: () => void): void {
    this.db.exec('SAVEPOINT pi_store')
    try {
      write()
      this.db.exec('RELEASE pi_store')
    } catch (error) {
      this.db.exec('ROLLBACK TO pi_store')
      this.db.exec('RELEASE pi_store')
      throw error
    }
  }
  submitted(threadId: string, clientId: string, input: unknown): PiTurn | null {
    const row = this.db
      .prepare('SELECT hash,turn_id FROM submissions WHERE thread_id=? AND message_id=?')
      .get(threadId, clientId)
    if (!row) return null
    if (row.hash !== submissionHash(input))
      throw new ProtocolError(-32009, '消息 ID 已被不同输入使用')
    const turn = this.turns(threadId).find((t) => t.id === row.turn_id)
    if (!turn) throw new ProtocolError(-32009, '此提交属于已回退分支，不能重复执行')
    return turn
  }
  admit(
    threadId: string,
    clientId: string | null,
    input: unknown,
    turn: PiTurn,
    consume?: () => void,
  ): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.saveTurn(threadId, turn)
      if (clientId)
        this.db
          .prepare('INSERT INTO submissions VALUES(?,?,?,?)')
          .run(threadId, clientId, submissionHash(input), turn.id)
      consume?.()
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      // 记着的“上回写的回合那一行”跟着回滚了
      this.headers.delete(threadId)
      throw e
    }
  }
  replaceTurns(threadId: string, turns: PiTurn[]): void {
    this.unsaved.delete(threadId)
    this.headers.delete(threadId)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const table of ['turns', 'turn_items'])
        this.db.prepare(`DELETE FROM ${table} WHERE thread_id=?`).run(threadId)
      // 条目表里这个会话的行刚删光，又在事务里：结束了的回合直接写它那一行
      for (const turn of turns)
        if (turn.status === 'inProgress') this.saveTurn(threadId, turn)
        else this.writeRow(threadId, turn.id, JSON.stringify(turn))
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      this.headers.delete(threadId)
      throw e
    }
  }
  getMeta(scope: string, id: string): any {
    const row = this.db.prepare('SELECT data FROM metadata WHERE scope=? AND id=?').get(scope, id)
    return row ? JSON.parse(String(row.data)) : null
  }
  setMeta(scope: string, id: string, data: unknown): void {
    this.db
      .prepare(
        'INSERT INTO metadata VALUES(?,?,?) ON CONFLICT(scope,id) DO UPDATE SET data=excluded.data',
      )
      .run(scope, id, JSON.stringify(data))
  }
  delete(id: string): void {
    this.transient.delete(id)
    this.unsaved.delete(id)
    this.headers.delete(id)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const table of ['turns', 'turn_items', 'submissions'])
        this.db.prepare(`DELETE FROM ${table} WHERE thread_id=?`).run(id)
      this.db
        .prepare('DELETE FROM metadata WHERE id=? OR scope=? OR scope=?')
        .run(id, `attachments:${id}`, `steer:${id}`)
      this.db.prepare('DELETE FROM threads WHERE id=?').run(id)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
  close(): void {
    for (const id of [...this.unsaved.keys()]) this.flush(id)
    this.db.close()
  }
}
