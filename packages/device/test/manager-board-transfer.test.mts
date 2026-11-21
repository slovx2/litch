import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { type TestContext, test } from 'node:test'
import {
  MANAGER_BOARD_TRANSFER_METHOD,
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
  type Manager,
} from '../../protocol/src/manager.mjs'
import { ManagerBoardWriter } from '../src/manager-board.mjs'
import {
  archivedBoardSuggestion,
  exportManagerBoard,
  importManagerBoard,
} from '../src/manager-board-transfer.mjs'
import { ManagerStore, openPreviewManagerDatabase } from '../src/manager-store.mjs'
import { TestClient } from './helpers.mjs'
import { treeRig } from './tree-kit.mjs'

const source = '10000000-0000-4000-a000-000000000001'
const target = '10000000-0000-4000-a000-000000000002'

test('看板迁移接口只对声明扩展的设备管理员开放；原看板读取仍可用', async (t) => {
  const env = treeRig()
  t.after(() => env.close())
  env.device.managers?.store.saveManager(record(target))
  const plain = env.connect()
  const nonAdmin = env.connect()
  const admin = new TestClient((wire) => env.device.attach(wire, true))
  await plain.initialize(['harness', 'litchManager'])
  await nonAdmin.initialize(['harness', 'litchManagerBoardTransfer'])
  await admin.initialize(['harness', 'litchManagerBoardTransfer'])
  const params = { managerId: target }
  await assert.rejects(
    plain.call(MANAGER_BOARD_TRANSFER_METHOD.export, params),
    (error: { data?: { litch: string } }) => error.data?.litch === 'extensionRequired',
  )
  await assert.rejects(
    nonAdmin.call(MANAGER_BOARD_TRANSFER_METHOD.export, params),
    (error: { data?: { litch: string } }) => error.data?.litch === 'deviceAdminRequired',
  )
  assert.equal((await plain.call(MANAGER_METHOD.boardRead, params)).board.managerId, target)
  assert.equal(
    (await admin.call(MANAGER_BOARD_TRANSFER_METHOD.export, params)).source.managerId,
    target,
  )
})

const record = (id: string): Manager => ({
  id,
  threadId: `thread-${id}`,
  name: '示例经理',
  scope: '',
  cwd: '/示例',
  harness: 'pi',
  model: null,
  effort: null,
  template: 'blank',
  dispatch: MANAGER_DEFAULT_DISPATCH,
  contact: MANAGER_DEFAULT_CONTACT,
  rules: '',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
  endedAt: null,
  pendingDecisions: 0,
  runningLines: 0,
  latestActivity: null,
})

function rig(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'litch-board-'))
  const backupDir = join(dir, 'backups')
  const origin = new ManagerStore(openPreviewManagerDatabase())
  const dest = new ManagerStore(openPreviewManagerDatabase())
  t.after(() => {
    origin.close()
    dest.close()
    rmSync(dir, { recursive: true, force: true })
  })
  origin.saveManager(record(source))
  dest.saveManager(record(target))
  const writer = new ManagerBoardWriter(origin, (_, id) => id === 'source-workline')
  writer.tool(source, 'add', {
    kind: 'item',
    item: {
      title: '整理',
      owner: { kind: 'line', threadId: 'source-workline' },
      links: [{ kind: 'file', target: 'docs/notes.md', label: null }],
    },
  })
  writer.tool(source, 'add', {
    kind: 'decision',
    decision: {
      title: '选择',
      background: '见 I-1',
      options: [{ id: 'yes', label: '可以', description: '' }],
      blocks: ['I-1'],
    },
  })
  origin.saveQuestion({
    managerId: source,
    decisionId: 'D-1',
    threadId: 'old-discussion',
    threads: ['old-discussion'],
    source: 'old-source',
    revision: 2,
    discussion: {
      forwarded: 0,
      light: false,
      summary: '总结',
      messages: [
        {
          id: 'question-1',
          at: 1,
          question: '进展？',
          answer: '已完成 I-1',
          status: 'completed',
          refreshed: false,
        },
      ],
    },
  })
  origin.savePublishedReport(source, {
    id: 'P-4',
    title: '原报告',
    body: '见 I-1',
    createdAt: 1,
    updatedAt: 2,
    revision: 2,
    readRevision: 1,
  })
  const sql = (store: ManagerStore, manager: string, title: string) =>
    store.db.prepare('INSERT INTO issues VALUES(?,?,?)').run(
      manager,
      'X-1',
      JSON.stringify({
        id: 'X-1',
        kind: 'ordinary',
        title,
        body: '关联 D-1',
        status: 'open',
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        author: { kind: 'user' },
        followUp: { state: 'off' },
        discussion: { comments: [], questions: [] },
        timeline: [],
        relations: [],
        quick: {},
      }),
    )
  sql(origin, source, '来自源设备')
  origin.db.prepare('INSERT INTO issue_comments VALUES(?,?,?,?)').run(
    source,
    'X-1',
    'comment-1',
    JSON.stringify({
      id: 'comment-1',
      author: { kind: 'manager' },
      body: '见 D-1',
      createdAt: 1,
      updatedAt: 1,
      replyTo: null,
      revision: 1,
    }),
  )
  origin.db.prepare('INSERT INTO manager_relations VALUES(?,?,?)').run(
    source,
    'relation-1',
    JSON.stringify({
      id: 'relation-1',
      from: { kind: 'item', target: 'I-1' },
      to: { kind: 'issue', target: 'X-1' },
      kind: 'related',
      at: 1,
      by: 'user',
    }),
  )
  origin.db.prepare('INSERT INTO situations VALUES(?,?)').run(source, '{"text":"见 D-1","at":123}')
  const archive = exportManagerBoard(
    origin,
    source,
    [
      {
        id: 'S-card',
        title: '建议',
        body: '见 I-1',
        revision: 2,
        createdAt: 1,
        updatedAt: 2,
        sourceDevice: 'source-device',
        sourceStatus: 'started',
      },
    ],
    'source-device',
  )
  return {
    origin,
    dest,
    backupDir,
    archive,
    targetIssue: () => sql(dest, target, '目标现有 issue'),
  }
}

test('导出导入正文、关系、历史和讨论；目标备份可读，重复执行不新增内容', (t) => {
  const { origin, dest, backupDir, archive } = rig(t)
  const preview = importManagerBoard(dest, target, archive, { backupDir, preview: true })
  assert.equal(preview.counts.decisions, 1)
  assert.equal(preview.counts.items, 1)
  assert.equal(preview.counts.discussions, 1)
  assert.equal(dest.objects(target).length, 0)
  const result = importManagerBoard(dest, target, archive, { backupDir })
  assert.equal(result.reportId, 'P-5')
  const item = dest.objects(target).find((row) => row.id === 'I-1')
  assert.equal(item?.links[0]?.target, 'litch-source-record:file:docs/notes.md')
  assert.match(item?.links[0]?.label ?? '', /source-device/)
  assert.match(JSON.stringify(item), /源工作线/)
  assert.doesNotMatch(JSON.stringify(item), /"threadId"/)
  const discussion = dest.question(target, 'D-1')
  assert.equal(discussion?.threadId, null)
  assert.deepEqual(discussion?.threads, [])
  assert.equal(discussion?.discussion.messages[0]?.answer, '已完成 I-1')
  assert.equal(archivedBoardSuggestion(dest, target, 'S-card')?.sourceStatus, 'started')
  assert.equal(dest.situation(target)?.text, '见 D-1')
  assert.equal(dest.changes(target).length, origin.changes(source).length)
  assert.equal(dest.db.prepare('SELECT count(*) n FROM manager_relations').get()?.n, 1)
  assert.equal(dest.db.prepare('SELECT count(*) n FROM issue_comments').get()?.n, 1)
  assert.equal(dest.nextIssueId(target), 'X-2')
  assert.equal(dest.nextId(target, 'D'), 'D-2')
  if (process.platform !== 'win32') assert.equal(statSync(result.backupPath).mode & 0o777, 0o600)
  const backup = new DatabaseSync(result.backupPath, { readOnly: true })
  assert.equal(backup.prepare('SELECT count(*) n FROM objects').get()?.n, 0)
  backup.close()
  const again = importManagerBoard(dest, target, archive, { backupDir })
  assert.equal(again.alreadyImported, true)
  assert.equal(again.reportId, result.reportId)
  assert.equal(readdirSync(backupDir).length, 1)
  assert.equal(dest.objects(target).length, 2)
  assert.equal(dest.publishedReports(target).length, 2)
  assert.throws(
    () =>
      importManagerBoard(
        dest,
        target,
        {
          ...archive,
          source: { ...archive.source, name: '更改' },
        },
        { backupDir },
      ),
    /different contents/,
  )
})

test('对外引用保留目标编号；核证无引用时移动目标并重写本地引用', (t) => {
  const { dest, targetIssue, backupDir, archive } = rig(t)
  targetIssue()
  dest.db
    .prepare('INSERT INTO external_refs VALUES(?,?,?,?,?,?)')
    .run('github', 'repo', '27', target, 'X-1', '{}')
  const writer = new ManagerBoardWriter(dest, () => false)
  writer.tool(target, 'add', { kind: 'item', item: { title: '目标自己的事项' } })
  writer.tool(target, 'add', {
    kind: 'decision',
    decision: {
      title: '目标自己的决策',
      background: '依据 I-1',
      blocks: ['I-1'],
      options: [{ id: 'yes', label: '可以', description: '' }],
    },
  })
  const options = { backupDir, verifiedUnreferenced: ['X-1', 'I-1'] }
  const preview = importManagerBoard(dest, target, archive, { ...options, preview: true })
  assert.deepEqual({ ...preview.importedRenumbered }, { 'D-1': 'D-2', 'X-1': 'X-2' })
  assert.deepEqual({ ...preview.destinationRenumbered }, { 'I-1': 'I-2' })
  const result = importManagerBoard(dest, target, archive, options)
  assert.deepEqual(result.importedRenumbered, preview.importedRenumbered)
  assert.match(JSON.stringify(dest.issue(target, 'X-1')), /目标现有 issue/)
  assert.match(JSON.stringify(dest.issue(target, 'X-2')), /关联 D-2/)
  assert.match(JSON.stringify(dest.objects(target).find((row) => row.id === 'D-1')), /依据 I-2/)
  assert.match(JSON.stringify(dest.question(target, 'D-2')), /已完成 I-1/)
  const comment = dest.db.prepare('SELECT issue_id,body FROM issue_comments').get()
  assert.equal(comment?.issue_id, 'X-2')
  assert.match(String(comment?.body), /见 D-2/)
  const report = dest.publishedReport(target, result.reportId)
  assert.match(report?.body ?? '', /X-1 → X-2/)
  assert.match(report?.body ?? '', /I-1 → I-2/)
})

test('事务中途失败回滚改号、导入、计数器和回执；保留可核验的备份', (t) => {
  const { dest, targetIssue, backupDir, archive } = rig(t)
  targetIssue()
  dest.db.exec(
    "CREATE TRIGGER abort_report BEFORE INSERT ON manager_reports BEGIN SELECT raise(ABORT, 'injected rollback'); END",
  )
  const options = { backupDir, verifiedUnreferenced: ['X-1'] }
  assert.throws(() => importManagerBoard(dest, target, archive, options), /injected rollback/)
  assert.match(JSON.stringify(dest.issue(target, 'X-1')), /目标现有 issue/)
  assert.equal(dest.issue(target, 'X-2'), null)
  assert.equal(dest.objects(target).length, 0)
  assert.equal(dest.db.prepare('SELECT count(*) n FROM counters').get()?.n, 0)
  assert.equal(dest.db.prepare('SELECT count(*) n FROM manager_board_transfers').get()?.n, 0)
  assert.equal(readdirSync(backupDir).length, 1)
  dest.db.exec('DROP TRIGGER abort_report')
  assert.equal(importManagerBoard(dest, target, archive, options).alreadyImported, false)
})

test('连续导入只保留四份可读私有备份，轮换不删除无关文件', (t) => {
  const { dest, backupDir, archive } = rig(t)
  for (let n = 0; n < 6; n++) {
    importManagerBoard(dest, target, { ...archive, exportId: randomUUID() }, { backupDir })
    if (n === 0) writeFileSync(join(backupDir, 'keep.txt'), '保留', { mode: 0o600 })
  }
  const files = readdirSync(backupDir)
  const backups = files.filter((name) => name.startsWith('manager-before-board-'))
  assert.equal(backups.length, 4)
  assert.ok(files.includes('keep.txt'))
  for (const name of backups) {
    const path = join(backupDir, name)
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      assert.equal(db.prepare('PRAGMA quick_check').get()?.quick_check, 'ok')
    } finally {
      db.close()
    }
  }
})
