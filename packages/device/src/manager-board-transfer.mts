// 经理库是看板的权威；可移植内容显式列出，绝不复制投递、授权或会话运行表。
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ManagerStore } from './manager-store.mjs'
import { ManagerError } from './manager-validate.mjs'
import type { SessionStore } from './session-store.mjs'
import { isObject } from './wire.mjs'

export const MANAGER_BOARD_TRANSFER_MIGRATION = `
CREATE TABLE manager_board_archived_suggestions(
  manager_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(manager_id,id)
);
CREATE TABLE manager_board_transfers(
  manager_id TEXT NOT NULL, export_id TEXT NOT NULL, digest TEXT NOT NULL,
  body TEXT NOT NULL, PRIMARY KEY(manager_id,export_id)
);`

const categories = {
  objects: ['id'],
  manager_reports: ['id'],
  manager_board_archived_suggestions: ['id'],
  questions: ['decision_id'],
  issues: ['id'],
  issue_comments: ['issue_id', 'comment_id'],
  issue_meta: ['issue_id'],
  manager_relations: ['id'],
  changes: [],
  issue_history: [],
  situations: [],
} as const
type Table = keyof typeof categories
type Entry = { keys: string[]; value: Record<string, unknown> }
type BoardRows = Record<Table, Entry[]>
export type ArchivedBoardSuggestion = {
  id: `S-${string}`
  title: string
  body: string
  revision: number
  createdAt: number
  updatedAt: number
  sourceStatus: string
  sourceDevice: string
}
type Archive = {
  format: 'litch-manager-board'
  version: 1
  exportId: string
  source: { device: string; managerId: string; name: string }
  tables: BoardRows
}
type Mapping = Record<string, string>
const tables = Object.keys(categories) as Table[]
const top = ['objects', 'manager_reports', 'manager_board_archived_suggestions', 'issues'] as const
const idPattern = /^(?:[DIRPX]-[1-9]\d{0,8}|S-[a-zA-Z0-9_-]{1,150})$/
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
const numbered = /^([DIRPX])-([1-9]\d{0,8})$/
const fail = (message: string): never => {
  throw new ManagerError('invalidManagerBoard', message)
}
const textFields = new Set([
  'title',
  'body',
  'description',
  'background',
  'summary',
  'question',
  'answer',
  'text',
  'reason',
  'why',
  'label',
  'unverified',
  'status',
])
const privateFields = new Set([
  'token',
  'credentialRef',
  'credentialId',
  'credentials',
  'env',
  'environment',
  'answerSource',
  'externalMandate',
  'externalRefs',
  'externalRef',
  'externalBinding',
  'externalBindings',
  'intakeMandates',
  'externalDelivery',
  'externalDeliveries',
  'externalIntake',
  'externalIntakeId',
  'runId',
  'turnId',
  'sourceTurnId',
  'nativeThreadId',
  'sourceThreadId',
  'threadHarnesses',
  'retiredThreads',
  'threads',
  'startedThreadId',
  'threadId',
  'parentThreadId',
])

function readRows(store: ManagerStore, managerId: string, table: Table) {
  return store.db
    .prepare(`SELECT rowid AS row_id,* FROM ${table} WHERE manager_id=? ORDER BY rowid`)
    .all(managerId)
    .map((row) => ({
      rowId: Number(row.row_id),
      keys: categories[table].map((key) => String(row[key])),
      value: JSON.parse(String(row.body)) as Record<string, unknown>,
    }))
}
const hasTable = (db: DatabaseSync, name: string) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name))

function objectId(row: Entry) {
  // 只用于带一个主对象 ID 的行，调用处已经校验了键数。
  return row.keys[0] as string
}
function archiveValue(value: unknown, device: string): unknown {
  if (Array.isArray(value)) return value.map((x) => archiveValue(x, device))
  if (!isObject(value)) return value
  if ((value.kind === 'file' || value.kind === 'thread') && typeof value.target === 'string') {
    // 原始路径和会话号仍可读；作为纯文字展示，不能在目标设备打开。
    const kind = value.kind
    return {
      kind: 'url',
      target: `litch-source-record:${kind}:${value.target}`,
      label: `[${device}] ${kind}: ${value.target}${value.label ? ` — ${String(value.label)}` : ''}`,
    }
  }
  const out = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !privateFields.has(key))
      .map(([key, entry]) => [key, archiveValue(entry, device)]),
  )
  if (isObject(value.owner) && value.owner.kind === 'line') {
    out.owner = { kind: 'manager' }
    const note = `[${device}] 源工作线：${String(value.owner.threadId ?? '未知')}`
    out.why = [out.why, note].filter(Boolean).join('\n')
  }
  if (value.status === 'running' && 'question' in value && !('answeredAt' in value)) {
    out.status = 'failed'
  }
  return out
}

export function exportManagerBoard(
  store: ManagerStore,
  managerId: string,
  suggestions: readonly ArchivedBoardSuggestion[],
  device = hostname(),
): Archive {
  const manager = store.manager(managerId)
  if (!manager) return fail('Manager does not exist.')
  const complete = {} as BoardRows
  for (const table of tables) {
    complete[table] = (hasTable(store.db, table) ? readRows(store, managerId, table) : [])
      .filter(({ value }) => table !== 'changes' || idPattern.test(String(value.objectId)))
      .map(({ keys, value }) => ({ keys, value: archiveValue(value, device) as Entry['value'] }))
  }
  const ids = new Set(complete.manager_board_archived_suggestions.map((entry) => entry.keys[0]))
  for (const suggestion of suggestions)
    if (!ids.has(suggestion.id))
      complete.manager_board_archived_suggestions.push({
        keys: [suggestion.id],
        value: { ...suggestion },
      })
  return {
    format: 'litch-manager-board',
    version: 1,
    exportId: randomUUID(),
    source: { device, managerId, name: manager.name },
    tables: complete,
  }
}

/** 已处理的建议仍属于历史，不能用只返回 pending 的会话树投影来导出。 */
export function boardSuggestions(
  store: ManagerStore,
  sessions: SessionStore,
  managerId: string,
  device = hostname(),
): ArchivedBoardSuggestion[] {
  const manager = store.manager(managerId)
  if (!manager) return fail('Manager does not exist.')
  const threads = [manager.threadId, ...store.history(managerId)]
  const result = new Map<string, ArchivedBoardSuggestion>()
  for (const thread of threads)
    for (const row of sessions.boardSuggestions(thread)) {
      const owning = store.forThread(row.threadId)
      if (owning && owning.id !== managerId) continue
      const id = `S-${row.id}` as const
      const version = store.suggestionVersion(managerId, id)
      const body = [row.background, row.prompt, row.cwd ? `[${device}] 源目录：${row.cwd}` : null]
        .filter(Boolean)
        .join('\n\n')
      result.set(id, {
        id,
        title: row.title,
        body,
        sourceStatus: row.status,
        sourceDevice: device,
        revision: version?.revision ?? 1,
        createdAt: row.createdAt,
        updatedAt: version?.updatedAt ?? row.settledAt ?? row.createdAt,
      })
    }
  return [...result.values()]
}

function validRow(table: Table, e: Record<string, unknown>): e is Record<string, unknown> & Entry {
  if (
    !Array.isArray(e.keys) ||
    e.keys.length !== categories[table].length ||
    !e.keys.every((k) => typeof k === 'string' && k.length > 0 && k.length <= 200) ||
    !isObject(e.value)
  )
    return false
  const d = e.value
  const id = e.keys[0]
  const time = (t: unknown) => typeof t === 'number' && Number.isSafeInteger(t) && t >= 0
  const base = () =>
    d.id === id &&
    typeof d.title === 'string' &&
    time(d.createdAt) &&
    time(d.updatedAt) &&
    time(d.revision)
  switch (table) {
    case 'objects':
      return (
        base() &&
        /^[DIR]-\d+$/.test(id) &&
        typeof d.status === 'string' &&
        Array.isArray(d.links) &&
        Array.isArray(d.basis) &&
        (id.startsWith('D-')
          ? Array.isArray(d.options) && Array.isArray(d.blocks)
          : id.startsWith('I-')
            ? Array.isArray(d.blockedBy) && isObject(d.owner)
            : typeof d.description === 'string')
      )
    case 'manager_reports':
      return base() && /^P-\d+$/.test(id) && typeof d.body === 'string' && time(d.readRevision)
    case 'manager_board_archived_suggestions':
      return (
        base() &&
        id.startsWith('S-') &&
        idPattern.test(id) &&
        typeof d.body === 'string' &&
        typeof d.sourceStatus === 'string' &&
        typeof d.sourceDevice === 'string'
      )
    case 'issues':
      return (
        base() &&
        /^X-\d+$/.test(id) &&
        d.kind === 'ordinary' &&
        typeof d.body === 'string' &&
        typeof d.status === 'string' &&
        isObject(d.author) &&
        isObject(d.followUp) &&
        isObject(d.discussion) &&
        Array.isArray(d.timeline) &&
        Array.isArray(d.relations) &&
        isObject(d.quick)
      )
    case 'questions':
      return (
        idPattern.test(id) &&
        d.decisionId === id &&
        isObject(d.discussion) &&
        Array.isArray(d.discussion.messages) &&
        time(d.revision)
      )
    case 'issue_meta':
      return idPattern.test(id) && time(d.revision) && time(d.updatedAt)
    case 'issue_comments':
      return (
        idPattern.test(id) &&
        d.id === e.keys[1] &&
        typeof d.body === 'string' &&
        isObject(d.author) &&
        time(d.revision) &&
        time(d.createdAt) &&
        time(d.updatedAt)
      )
    case 'manager_relations':
      return (
        d.id === id &&
        isObject(d.from) &&
        isObject(d.to) &&
        typeof d.from.target === 'string' &&
        typeof d.to.target === 'string' &&
        time(d.at)
      )
    case 'changes':
    case 'issue_history':
      return (
        typeof d.id === 'string' &&
        idPattern.test(String(d.objectId)) &&
        time(d.at) &&
        Array.isArray(d.fields) &&
        typeof d.why === 'string'
      )
    case 'situations':
      return typeof d.text === 'string' && time(d.at)
  }
}

function parse(value: unknown): Archive {
  if (
    !isObject(value) ||
    value.format !== 'litch-manager-board' ||
    value.version !== 1 ||
    typeof value.exportId !== 'string' ||
    !uuid.test(value.exportId) ||
    !isObject(value.source) ||
    !isObject(value.tables)
  )
    return fail('Unsupported board archive.')
  const source = value.source
  if (
    typeof source.device !== 'string' ||
    !source.device.trim() ||
    source.device.length > 240 ||
    typeof source.managerId !== 'string' ||
    !uuid.test(source.managerId) ||
    typeof source.name !== 'string' ||
    source.name.length > 1024
  )
    return fail('Invalid board archive origin.')
  let total = 0
  const result = {} as BoardRows
  for (const table of tables) {
    const rows = value.tables[table]
    if (
      !Array.isArray(rows) ||
      (total += rows.length) > 80_000 ||
      !rows.every((row) => isObject(row) && validRow(table, row))
    )
      return fail(`Invalid board records in ${table}.`)
    if (table === 'situations' && rows.length > 1)
      return fail('The archive contains multiple current situations.')
    if (
      categories[table].length &&
      new Set(rows.map((row) => JSON.stringify(row.keys))).size !== rows.length
    )
      return fail(`Duplicate board records in ${table}.`)
    result[table] = rows
  }
  const ids = new Set(top.flatMap((table) => result[table].map(objectId)))
  if (top.some((table) => result[table].some((row) => !idPattern.test(objectId(row)))))
    return fail('Invalid numbered board ID.')
  for (const table of ['issue_comments', 'issue_meta'] as const)
    if (result[table].some((row) => !ids.has(objectId(row))))
      return fail('Board metadata has no target.')
  return {
    format: 'litch-manager-board',
    version: 1,
    exportId: value.exportId,
    source: { device: source.device, managerId: source.managerId, name: source.name },
    tables: result,
  }
}

function remap(value: unknown, ids: Mapping, uids: Mapping, field = ''): unknown {
  if (Array.isArray(value)) return value.map((x) => remap(x, ids, uids, field))
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        field === 'options' && k === 'id' ? v : remap(v, ids, uids, k),
      ]),
    )
  if (typeof value !== 'string') return value
  if (['id', 'replyTo', 'commentId', 'changeId'].includes(field) && Object.hasOwn(uids, value))
    return uids[value]
  if (field === 'id') {
    const part = /^(comment|change):(.+)$/.exec(value)
    if (part?.[2] && Object.hasOwn(uids, part[2])) return `${part[1]}:${uids[part[2]]}`
  }
  if (
    [
      'id',
      'objectId',
      'decisionId',
      'issueId',
      'blockedBy',
      'blocks',
      'target',
      'relatedIssueId',
    ].includes(field) &&
    Object.hasOwn(ids, value)
  )
    return ids[value]
  return textFields.has(field)
    ? value.replace(
        /(?<![\w-])(?:[DIRPX]-[1-9]\d{0,8}|S-[a-zA-Z0-9_-]{1,150})(?![\w-])/g,
        (id) => ids[id] ?? id,
      )
    : value
}

function backup(store: ManagerStore, dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dir)
  if (
    !stat.isDirectory() ||
    (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
  )
    return fail('The board backup directory is not private.')
  const path = join(
    dir,
    `manager-before-board-${new Date().toISOString().replaceAll(':', '')}-${randomUUID()}.sqlite`,
  )
  const fd = openSync(path, 'wx', 0o600)
  try {
    store.db.prepare('VACUUM INTO ?').run(path)
    fsyncSync(fd)
    const snapshot = new DatabaseSync(path, { readOnly: true })
    try {
      if (snapshot.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
        return fail('The board backup did not pass SQLite integrity verification.')
    } finally {
      snapshot.close()
    }
  } catch (error) {
    closeSync(fd)
    unlinkSync(path)
    throw error
  }
  closeSync(fd)
  return path
}
function rotate(dir: string) {
  const paths = readdirSync(dir)
    .filter((name) => /^manager-before-board-[0-9TZ.-]+[0-9a-f-]{36}\.sqlite$/.test(name))
    .sort()
    .reverse()
  for (const name of paths.slice(4)) {
    const p = join(dir, name)
    if (lstatSync(p).isFile()) unlinkSync(p)
  }
}

function references(store: ManagerStore, managerId: string): Set<string> {
  const protectedIds = new Set<string>()
  for (const table of [
    'external_refs',
    'external_mandates',
    'external_intakes',
    'external_inbox',
    'external_deliveries',
    'external_outbox',
  ] as const) {
    // 外部绑定及现有运行引用不随看板行重写，故编号必须原样留在目标端。
    for (const row of store.db
      .prepare(`SELECT body AS value FROM ${table} WHERE manager_id=?`)
      .iterate(managerId))
      for (const match of String(row.value).matchAll(/(?<![\w-])[DIRPX]-[1-9]\d{0,8}(?![\w-])/g))
        protectedIds.add(match[0])
  }
  for (const table of ['external_refs', 'external_mandates'])
    for (const row of store.db
      .prepare(`SELECT issue_id FROM ${table} WHERE manager_id=?`)
      .all(managerId))
      protectedIds.add(String(row.issue_id))
  return protectedIds
}

function importedRow(
  table: Table,
  row: Entry,
  source: Archive['source'],
  ids: Mapping,
  uids: Mapping,
) {
  let value = remap(archiveValue(row.value, source.device), ids, uids) as Entry['value']
  if (table === 'questions')
    value = { ...value, threadId: null, threads: [], source: `board-import:${source.device}` }
  return {
    keys: row.keys.map((key, i) =>
      table === 'manager_relations' || (table === 'issue_comments' && i === 1)
        ? (uids[key] ?? key)
        : (ids[key] ?? key),
    ),
    value,
  }
}

function insert(store: ManagerStore, managerId: string, table: Table, row: Entry) {
  const columns = ['manager_id', ...categories[table], 'body']
  store.db
    .prepare(
      `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
    )
    .run(managerId, ...row.keys, JSON.stringify(row.value))
}

export function archivedBoardSuggestions(
  store: ManagerStore,
  managerId: string,
): ArchivedBoardSuggestion[] {
  return readRows(store, managerId, 'manager_board_archived_suggestions').map(
    (row) => row.value as ArchivedBoardSuggestion,
  )
}

export function archivedBoardSuggestion(
  store: ManagerStore,
  managerId: string,
  id: string,
): ArchivedBoardSuggestion | null {
  const row = store.db
    .prepare('SELECT body FROM manager_board_archived_suggestions WHERE manager_id=? AND id=?')
    .get(managerId, id)
  return row ? (JSON.parse(String(row.body)) as ArchivedBoardSuggestion) : null
}

export function importManagerBoard(
  store: ManagerStore,
  managerId: string,
  payload: unknown,
  options: {
    preview?: boolean
    verifiedUnreferenced?: string[]
    backupDir: string
    liveSuggestions?: readonly string[]
  },
) {
  const encoded = JSON.stringify(payload)
  if (!encoded || Buffer.byteLength(encoded) > 24 * 1024 * 1024)
    return fail('Board archive exceeds 24 MiB or is missing.')
  const archive = parse(payload)
  if (!store.manager(managerId)) return fail('Manager does not exist.')
  if (archive.source.managerId === managerId)
    return fail('Cannot import a board into the same manager.')
  const digest = createHash('sha256').update(JSON.stringify(archive)).digest('hex')
  const receipt = () =>
    store.db
      .prepare('SELECT digest,body FROM manager_board_transfers WHERE manager_id=? AND export_id=?')
      .get(managerId, archive.exportId)
  const previous = receipt()
  if (previous) {
    if (previous.digest !== digest)
      return fail('The archive ID was already imported with different contents.')
    return { ...JSON.parse(String(previous.body)), alreadyImported: true }
  }
  const counts = {
    decisions: archive.tables.objects.filter((row) => objectId(row).startsWith('D-')).length,
    items: archive.tables.objects.filter((row) => objectId(row).startsWith('I-')).length,
    requests: archive.tables.objects.filter((row) => objectId(row).startsWith('R-')).length,
    reports: archive.tables.manager_reports.length,
    suggestions: archive.tables.manager_board_archived_suggestions.length,
    issues: archive.tables.issues.length,
    discussions: archive.tables.questions.length,
    comments: archive.tables.issue_comments.length,
    relations: archive.tables.manager_relations.length,
    changes: archive.tables.changes.length + archive.tables.issue_history.length,
    situation: archive.tables.situations.length,
  }
  const plan = () => {
    const source = top.flatMap((table) => archive.tables[table].map(objectId))
    const existing = new Set([
      ...top.flatMap((table) => readRows(store, managerId, table).map(objectId)),
      ...(options.liveSuggestions ?? []),
    ])
    const protectedIds = references(store, managerId)
    const renumberTargets = new Set(options.verifiedUnreferenced ?? [])
    const high = new Map<string, number>()
    for (const row of store.db
      .prepare('SELECT kind,value FROM counters WHERE manager_id=?')
      .all(managerId))
      high.set(row.kind === 'issue' ? 'X' : String(row.kind), Number(row.value))
    for (const id of [...source, ...existing]) {
      const m = numbered.exec(id)
      if (m?.[1]) high.set(m[1], Math.max(high.get(m[1]) ?? 0, Number(m[2])))
    }
    const next = (kind: string) => {
      const number = (high.get(kind) ?? 0) + 1
      if (!Number.isSafeInteger(number) || number > 999_999_999)
        return fail('Board ID range exhausted.')
      high.set(kind, number)
      return `${kind}-${number}`
    }
    const destinationIds: Mapping = Object.create(null),
      importedIds: Mapping = Object.create(null)
    const conflicts = source
      .filter((id) => existing.has(id))
      .map((id) => ({
        id,
        externalReference: protectedIds.has(id),
        destinationRenumbered: false,
      }))
    for (const collision of conflicts) {
      const { id, externalReference } = collision
      const kind = numbered.exec(id)?.[1]
      if (kind && !externalReference && renumberTargets.has(id)) {
        destinationIds[id] = next(kind)
        collision.destinationRenumbered = true
      } else if (kind) importedIds[id] = next(kind)
      else {
        for (let attempt = 0; ; attempt++) {
          const candidate = `S-import-${createHash('sha256')
            .update(`${archive.exportId}:${id}:${attempt}`)
            .digest('hex')
            .slice(0, 32)}`
          if (!existing.has(candidate) && !source.includes(candidate)) {
            importedIds[id] = candidate
            existing.add(candidate)
            break
          }
        }
      }
    }
    if ([...renumberTargets].some((id) => !conflicts.some((row) => row.id === id)))
      return fail('The confirmed unreferenced IDs no longer match current collisions.')
    return { high, next, conflicts, destinationIds, importedIds }
  }
  const describe = (p: ReturnType<typeof plan>) => ({
    source: archive.source,
    exportId: archive.exportId,
    counts,
    conflicts: p.conflicts,
    destinationRenumbered: p.destinationIds,
    importedRenumbered: p.importedIds,
  })
  if (options.preview) return { ...describe(plan()), preview: true }
  plan()
  const snapshot = backup(store, options.backupDir)
  const result = store.transaction(() => {
    const p = plan()
    if (Object.keys(p.destinationIds).length) {
      for (const table of tables) {
        for (const row of readRows(store, managerId, table)) {
          const nextKeys = row.keys.map((key, i) =>
            table === 'manager_relations' || (table === 'issue_comments' && i === 1)
              ? key
              : (p.destinationIds[key] ?? key),
          )
          const value = remap(row.value, p.destinationIds, {})
          if (
            JSON.stringify(row.keys) === JSON.stringify(nextKeys) &&
            JSON.stringify(value) === JSON.stringify(row.value)
          )
            continue
          store.db
            .prepare(
              `UPDATE ${table} SET ${categories[table].map((col) => `${col}=?,`).join('')}body=? WHERE manager_id=? AND rowid=?`,
            )
            .run(...nextKeys, JSON.stringify(value), managerId, row.rowId)
        }
      }
      for (const table of ['issue_notifications', 'issue_idempotency'] as const) {
        const column = table === 'issue_notifications' ? 'body' : 'result'
        for (const row of store.db
          .prepare(`SELECT rowid AS row_id,* FROM ${table} WHERE manager_id=?`)
          .all(managerId)) {
          const value = JSON.stringify(remap(JSON.parse(String(row[column])), p.destinationIds, {}))
          if (table === 'issue_notifications') {
            const old = String(row.issue_id)
            const id = p.destinationIds[old] ?? old
            if (old !== id || value !== row.body)
              store.db
                .prepare('UPDATE issue_notifications SET body=?,issue_id=? WHERE rowid=?')
                .run(value, id, Number(row.row_id))
          } else if (value !== row.result) {
            store.db
              .prepare('UPDATE issue_idempotency SET result=? WHERE rowid=?')
              .run(value, Number(row.row_id))
          }
        }
      }
    }
    const uids: Mapping = Object.create(null)
    for (const table of [
      'issue_comments',
      'manager_relations',
      'changes',
      'issue_history',
    ] as const)
      for (const row of archive.tables[table])
        if (typeof row.value.id === 'string') uids[row.value.id] ??= randomUUID()
    const originalSituation = store.situation(managerId)
    if (counts.situation)
      store.db.prepare('DELETE FROM situations WHERE manager_id=?').run(managerId)
    for (const table of tables)
      for (const entry of archive.tables[table]) {
        const row = importedRow(table, entry, archive.source, p.importedIds, uids)
        if (table === 'questions') row.value.managerId = managerId
        insert(store, managerId, table, row)
      }
    const reportId = p.next('P')
    const now = Math.floor(Date.now() / 1000)
    const mappingLines = (map: Mapping) =>
      Object.entries(map)
        .map(([from, to]) => `- ${from} → ${to}`)
        .join('\n') || '无'
    store.savePublishedReport(managerId, {
      id: reportId as `P-${number}`,
      title: '经理看板迁移',
      body:
        `来源设备：${archive.source.device}；经理：${archive.source.name}。\n\n` +
        `### 导入对象改号\n${mappingLines(p.importedIds)}\n\n### 目标原有对象改号\n${mappingLines(p.destinationIds)}` +
        (counts.situation && originalSituation
          ? `\n\n### 导入前的目标现状\n${originalSituation.text}`
          : ''),
      revision: 1,
      readRevision: 0,
      createdAt: now,
      updatedAt: now,
    })
    for (const [kind, value] of p.high)
      store.db
        .prepare(
          'INSERT INTO counters VALUES(?,?,?) ON CONFLICT(manager_id,kind) DO UPDATE SET value=max(value,excluded.value)',
        )
        .run(managerId, kind === 'X' ? 'issue' : kind, value)
    const response = { ...describe(p), backupPath: snapshot, reportId, alreadyImported: false }
    store.db
      .prepare('INSERT INTO manager_board_transfers VALUES(?,?,?,?)')
      .run(managerId, archive.exportId, digest, JSON.stringify(response))
    return response
  })
  try {
    rotate(options.backupDir)
  } catch {
    // 导入已提交，失败的轮转由调用方处理，不能误报导入失败。
    return { ...result, backupRotationFailed: true }
  }
  return result
}
