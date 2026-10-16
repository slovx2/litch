// 从各引擎读到的项目怎么并进设备库：规则的边角（设计文档 03 第 6.1 节）。不经设备进程，直接对着库。
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import test from 'node:test'
import { WorkspaceImporter } from '../src/importer.mjs'
import { openDeviceStore } from '../src/store.mjs'
import { ThreadIndex } from '../src/thread-index.mjs'
import {
  type HarnessSnapshot,
  IMPORT_SOURCES_KEY,
  mergeSnapshots,
  type SourceProject,
  type SourceThread,
} from '../src/workspace-import.mjs'
import { Workspaces } from '../src/workspaces.mjs'
import { PINNED, tempDir } from './helpers.mjs'

function bench(options: { imports?: boolean } = {}) {
  const directory = tempDir()
  const db = openDeviceStore(directory)
  const index = new ThreadIndex(db)
  const announced: [string, any][] = []
  const workspaces = new Workspaces(db, (method, params) => announced.push([method, params]))
  // 记“导入过没有”的那张表是它建的
  if (options.imports !== false)
    new WorkspaceImporter({
      db,
      index,
      workspaces,
      harnesses: () => [],
      version: '0',
      timeoutMs: 100,
      log: () => {},
    })
  return {
    db,
    index,
    workspaces,
    announced,
    merge: (snapshots: HarnessSnapshot[]) => mergeSnapshots(db, index, workspaces, snapshots, 7000),
    projects: () =>
      workspaces.projects.list().map((project) => ({
        ...project,
        sources: JSON.parse(project.metadata[IMPORT_SOURCES_KEY] ?? '[]') as {
          harness: string
          projectId: string
          name: string
        }[],
      })),
    close() {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

const project = (
  id: string,
  name: string,
  roots: string[],
  more: Partial<SourceProject> = {},
): SourceProject => ({
  id,
  name,
  roots: roots.map((path) => ({ path })),
  metadata: {},
  position: 0,
  createdAt: 1000,
  updatedAt: 1000,
  ...more,
})

const thread = (id: string, more: Partial<SourceThread> = {}): SourceThread => ({
  id,
  updatedAt: 100,
  archived: false,
  projectId: null,
  sectionId: null,
  sectionEnteredAt: null,
  ...more,
})

const snapshot = (harness: string, more: Partial<HarnessSnapshot> = {}): HarnessSnapshot => ({
  harness,
  projects: [],
  sections: [],
  threads: [],
  ...more,
})

test('根目录集合相同才合：不看顺序、重复和结尾的斜杠；同一个引擎里的也合；没有根目录的、只是同名的不合', () => {
  const env = bench()
  try {
    const counts = env.merge([
      snapshot('pi', {
        projects: [
          project('a', '甲', ['/x', '/y'], { position: 0, createdAt: 30 }),
          // 同一个引擎里根目录相同的另一个：也合，它建得更早，名字用它的
          project('b', '乙', ['/y/', '/x', '/x'], { position: 1, createdAt: 10 }),
          project('c', '空一', [], { position: 2 }),
          project('d', '空二', [], { position: 3 }),
          // 只有一个根目录相同：不算
          project('e', '甲', ['/x'], { position: 4 }),
          // 根目录就是 /：结尾的斜杠不能去掉成空的
          project('f', '根', ['/'], { position: 5 }),
        ],
        threads: [thread('t1', { projectId: 'a' }), thread('t2', { projectId: 'b' })],
      }),
      snapshot('claude-code', {
        projects: [project('g', '丙', ['/y', '/x'], { createdAt: 20, updatedAt: 5000 })],
        threads: [thread('t3', { projectId: 'g', archived: true })],
      }),
    ])
    assert.deepEqual(counts, { created: 5, merged: 0, sections: 0, assigned: 3, placed: 0 })
    const projects = env.projects()
    assert.deepEqual(
      projects.map((item) => [item.id, item.name, item.position, item.createdAt, item.updatedAt]),
      [
        ['b', '乙', 0, 10, 5000],
        ['c', '空一', 1, 1000, 1000],
        ['d', '空二', 2, 1000, 1000],
        ['e', '甲', 3, 1000, 1000],
        ['f', '根', 4, 1000, 1000],
      ],
    )
    assert.deepEqual(projects[0]?.roots, [{ path: '/y/' }, { path: '/x' }, { path: '/x' }])
    // 来源按 harness 的顺序、引擎里的顺序记，哪个都没有丢
    assert.deepEqual(projects[0]?.sources, [
      { harness: 'pi', projectId: 'a', name: '甲' },
      { harness: 'pi', projectId: 'b', name: '乙' },
      { harness: 'claude-code', projectId: 'g', name: '丙' },
    ])
    for (const threadId of ['t1', 't2', 't3']) assert.equal(env.workspaces.projectOf(threadId), 'b')
    assert.deepEqual([env.index.lookup('t1'), env.index.lookup('t3')], ['pi', 'claude-code'])
    // 归档了的会话不算进最近活动时间
    assert.equal(projects[0]?.recencyAt, 100)
  } finally {
    env.close()
  }
})

test('设备上已经有的不被盖掉：同根的并进去不改名，会话已有的归属和分区不动，分区按名称合', () => {
  const env = bench()
  try {
    // 用户在聚合面上已经建了一个工作区、一个分区，把一个会话归了进去
    const mine = (
      env.workspaces.call('project/create', {
        name: '我起的名字',
        roots: [{ path: '/x' }],
        metadata: { color: 'green' },
        idempotencyKey: 'k1',
      }) as any
    ).project
    const other = (
      env.workspaces.call('project/create', {
        name: '别的',
        roots: [],
        idempotencyKey: 'k2',
      }) as any
    ).project
    const later = (env.workspaces.call('threadSection/create', { name: '稍后看' }) as any).section
    env.index.see({ id: 't1', updatedAt: 50 }, 'pi')
    env.workspaces.assign('t1', other.id)
    env.workspaces.place('t1', later.id)
    env.announced.length = 0

    const counts = env.merge([
      snapshot('pi', {
        projects: [
          project('a', '引擎里的名字', ['/x/'], {
            createdAt: 1,
            updatedAt: 2,
            metadata: { color: 'red', icon: 'i' },
          }),
          // 标识撞上了设备上已有的工作区：当作同一个
          project(other.id, '撞标识的', ['/z'], { position: 1 }),
        ],
        sections: [
          { id: PINNED, name: 'Pinned', appearance: null },
          { id: 's-later', name: ' 稍后看 ', appearance: { icon: 'x', color: null } },
          { id: 's-new', name: '新的', appearance: { icon: 'n', color: 'red' } },
          { id: 's-blank', name: '   ', appearance: null },
        ],
        threads: [
          thread('t1', { projectId: 'a', sectionId: PINNED, sectionEnteredAt: 9 }),
          thread('t2', { projectId: 'a', sectionId: 's-later', sectionEnteredAt: 8 }),
          thread('t3', { projectId: 'nope', sectionId: 's-new' }),
          thread('t4', { sectionId: 's-blank' }),
          thread('t5', { sectionId: 's-gone' }),
        ],
      }),
    ])
    assert.deepEqual(counts, { created: 0, merged: 2, sections: 1, assigned: 1, placed: 2 })
    const projects = env.projects()
    assert.deepEqual(
      projects.map((item) => [item.id, item.name, item.roots]),
      [
        [mine.id, '我起的名字', [{ path: '/x' }]],
        [other.id, '别的', []],
      ],
    )
    // 已有的元数据说了算，引擎里多出来的键补上
    assert.deepEqual(
      [projects[0]?.metadata.color, projects[0]?.metadata.icon, projects[0]?.sources],
      ['green', 'i', [{ harness: 'pi', projectId: 'a', name: '引擎里的名字' }]],
    )
    assert.deepEqual(projects[1]?.sources, [
      { harness: 'pi', projectId: other.id, name: '撞标识的' },
    ])
    // 只补不盖：t1 在设备层已经有归属和分区
    assert.equal(env.workspaces.projectOf('t1'), other.id)
    assert.equal(env.workspaces.sections.placement('t1')?.section.id, later.id)
    assert.equal(env.workspaces.projectOf('t2'), mine.id)
    // 同名的分区并进已有的（名称比的是去掉首尾空白之后的），没有的才新建、沿用引擎里的标识
    assert.deepEqual(env.workspaces.sections.placement('t2'), {
      section: { id: later.id, name: '稍后看', appearance: null },
      enteredAt: 8,
    })
    assert.deepEqual(
      env.workspaces.sections
        .list()
        .map((section) => section.id)
        .sort(),
      [PINNED, later.id, 's-new'].sort(),
    )
    assert.deepEqual(env.workspaces.sections.placement('t3'), {
      section: { id: 's-new', name: '新的', appearance: { icon: 'n', color: 'red' } },
      enteredAt: 100,
    })
    // 项目、分区在引擎里对不上号的：会话照样登记，只是没有归属、不在分区里
    assert.deepEqual(
      ['t3', 't4', 't5'].map((id) => [env.index.lookup(id), env.workspaces.projectOf(id)]),
      [
        ['pi', null],
        ['pi', null],
        ['pi', null],
      ],
    )
    assert.equal(env.workspaces.sections.placement('t4'), null)
    assert.equal(env.workspaces.sections.placement('t5'), null)
    // 变了什么都有通知，没变的（t1）没有
    assert.deepEqual(
      env.announced.map(([method, params]) => [
        method,
        params.projectId ?? params.sectionId,
        params.threadId,
      ]),
      [
        ['project/changed', mine.id, undefined],
        ['project/changed', other.id, undefined],
        ['litch/threadSection/changed', 's-new', undefined],
        ['thread/project/updated', mine.id, 't2'],
        ['litch/thread/section/updated', undefined, 't2'],
        ['litch/thread/section/updated', undefined, 't3'],
      ],
    )
  } finally {
    env.close()
  }
})

test('并到一半出错：整个不算，库里什么都没有留下，下次可以原样重来', () => {
  // 没有记“导入过没有”的表：并到最后一步才出错
  const env = bench({ imports: false })
  try {
    const input = [
      snapshot('pi', {
        projects: [project('a', '甲', ['/x'])],
        sections: [{ id: 's1', name: '分区', appearance: null }],
        threads: [thread('t1', { projectId: 'a', sectionId: 's1' })],
      }),
    ]
    assert.throws(() => env.merge(input), /imports/)
    assert.deepEqual(env.projects(), [])
    assert.deepEqual(
      env.workspaces.sections.list().map((section) => section.id),
      [PINNED],
    )
    assert.equal(env.index.lookup('t1'), null)
    assert.equal(env.workspaces.projectOf('t1'), null)
    // 没成的改动一条通知都不发
    assert.deepEqual(env.announced, [])
    // 表有了之后重来：成
    env.db.exec(
      'CREATE TABLE imports(harness TEXT PRIMARY KEY, imported_at INTEGER NOT NULL, summary TEXT NOT NULL) WITHOUT ROWID',
    )
    assert.deepEqual(env.merge(input), {
      created: 1,
      merged: 0,
      sections: 1,
      assigned: 1,
      placed: 1,
    })
    assert.equal(env.workspaces.projectOf('t1'), 'a')
    assert.deepEqual(
      env.db
        .prepare('SELECT harness, imported_at FROM imports')
        .all()
        .map((row) => ({ ...row })),
      [{ harness: 'pi', imported_at: 7000 }],
    )
  } finally {
    env.close()
  }
})
