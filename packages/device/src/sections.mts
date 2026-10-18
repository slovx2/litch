// 设备层的分区与置顶。协议里会话没有“置顶”字段：置顶就是会话在一个固定标识的分区里，
// 这个标识是 Codex 客户端内置的（packages/shared/src/thread-sections.mts），各引擎和这里用的是同一个。
// 语义照引擎里现有的实现：置顶分区一直在、不能改不能删；删掉一个分区只是把里面的会话放出来，不删会话。
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import { PINNED_SECTION, PINNED_SECTION_ID } from '../../shared/src/thread-sections.mjs'
import { newId, nowSeconds } from '../../shared/src/util.mjs'
import { isObject } from './wire.mjs'

export interface SectionAppearance {
  icon: string | null
  color: string | null
}

export interface Section {
  id: string
  name: string
  appearance: SectionAppearance | null
}

/** 一个会话现在在哪个分区、什么时候进去的 */
export interface Placement {
  section: Section
  enteredAt: number
}

export function sectionAppearance(value: unknown): SectionAppearance | null {
  if (value == null) return null
  if (!isObject(value)) throw new ProtocolError(-32602, 'appearance 必须是对象或 null')
  return {
    icon: typeof value.icon === 'string' ? value.icon : null,
    color: typeof value.color === 'string' ? value.color : null,
  }
}

function sectionName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name) throw new ProtocolError(-32602, '分区名称不能为空')
  return name
}

export class SectionStore {
  private readonly db: DatabaseSync
  private readonly selectPlacement: StatementSync

  constructor(db: DatabaseSync) {
    this.db = db
    db.exec(`
      CREATE TABLE IF NOT EXISTS sections(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, appearance_json TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_sections(
        thread_id TEXT PRIMARY KEY, section_id TEXT NOT NULL, entered_at INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_section_members ON thread_sections(section_id);
      -- 上一次留下的临时会话已经从 threads 里清掉了，它们的分区跟着清
      DELETE FROM thread_sections WHERE thread_id NOT IN (SELECT id FROM threads);
    `)
    this.selectPlacement = db.prepare(
      `SELECT m.section_id, m.entered_at, s.name, s.appearance_json
       FROM thread_sections m LEFT JOIN sections s ON s.id=m.section_id WHERE m.thread_id=?`,
    )
  }

  private row(id: unknown, name: unknown, appearance: unknown): Section {
    return {
      id: String(id),
      name: String(name),
      appearance: appearance == null ? null : (JSON.parse(String(appearance)) as SectionAppearance),
    }
  }

  /** 置顶分区排在最前，其余按建的先后（同一秒里建的按写进库的先后，导入来的就是引擎里的顺序） */
  list(): Section[] {
    const rows = this.db
      .prepare('SELECT id, name, appearance_json FROM sections ORDER BY created_at, rowid')
      .all()
    return [PINNED_SECTION, ...rows.map((row) => this.row(row.id, row.name, row.appearance_json))]
  }

  get(id: string): Section | null {
    if (id === PINNED_SECTION_ID) return PINNED_SECTION
    const row = this.db.prepare('SELECT id, name, appearance_json FROM sections WHERE id=?').get(id)
    return row ? this.row(row.id, row.name, row.appearance_json) : null
  }

  private require(id: unknown): Section {
    const section = typeof id === 'string' ? this.get(id) : null
    if (!section) throw new ProtocolError(-32602, '未知分区')
    if (section.id === PINNED_SECTION_ID)
      throw new ProtocolError(-32602, '内置的置顶分区不能修改或删除')
    return section
  }

  /** id、createdAt 只有导入时才给：导入来的分区沿用引擎里的标识 */
  create(
    name: unknown,
    appearance: unknown,
    id: string = newId(),
    createdAt = nowSeconds(),
  ): Section {
    const section = { id, name: sectionName(name), appearance: sectionAppearance(appearance) }
    this.db
      .prepare(
        'INSERT INTO sections(id, name, appearance_json, created_at, updated_at) VALUES(?,?,?,?,?)',
      )
      .run(
        id,
        section.name,
        section.appearance ? JSON.stringify(section.appearance) : null,
        createdAt,
        createdAt,
      )
    return section
  }

  /** 名称不给就不改；外观不给是不改，给 null 是清掉 */
  update(id: unknown, name: unknown, appearance: unknown): Section {
    const old = this.require(id)
    const section = {
      id: old.id,
      name: name == null ? old.name : sectionName(name),
      appearance: appearance === undefined ? old.appearance : sectionAppearance(appearance),
    }
    this.db
      .prepare('UPDATE sections SET name=?, appearance_json=?, updated_at=? WHERE id=?')
      .run(
        section.name,
        section.appearance ? JSON.stringify(section.appearance) : null,
        nowSeconds(),
        section.id,
      )
    return section
  }

  /** 删掉一个分区，返回原来在里面的会话（它们变成不在任何分区里） */
  delete(id: unknown): string[] {
    const section = this.require(id)
    const members = this.members(section.id)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM thread_sections WHERE section_id=?').run(section.id)
      this.db.prepare('DELETE FROM sections WHERE id=?').run(section.id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return members
  }

  members(sectionId: string): string[] {
    return this.db
      .prepare(
        'SELECT thread_id FROM thread_sections WHERE section_id=? ORDER BY entered_at, thread_id',
      )
      .all(sectionId)
      .map((row) => String(row.thread_id))
  }

  placement(threadId: string): Placement | null {
    const row = this.selectPlacement.get(threadId)
    if (!row) return null
    const section =
      row.section_id === PINNED_SECTION_ID
        ? PINNED_SECTION
        : row.name == null
          ? null
          : this.row(row.section_id, row.name, row.appearance_json)
    return section ? { section, enteredAt: Number(row.entered_at) } : null
  }

  /**
   * 把会话放进一个分区，或者（null）从分区里拿出来。返回变了没有：
   * 本来就在这个分区里的不动，进去的时间也不变。enteredAt 只有导入时才给。
   */
  place(threadId: string, sectionId: string | null, enteredAt = nowSeconds()): boolean {
    if (sectionId !== null && !this.get(sectionId)) throw new ProtocolError(-32602, '未知分区')
    const current = this.placement(threadId)?.section.id ?? null
    if (current === sectionId) return false
    if (sectionId === null)
      this.db.prepare('DELETE FROM thread_sections WHERE thread_id=?').run(threadId)
    else
      this.db
        .prepare(
          `INSERT INTO thread_sections(thread_id, section_id, entered_at) VALUES(?,?,?)
           ON CONFLICT(thread_id) DO UPDATE SET
             section_id=excluded.section_id, entered_at=excluded.entered_at`,
        )
        .run(threadId, sectionId, enteredAt)
    return true
  }
}
