import assert from 'node:assert/strict'
import { readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { parseArgs } from '../src/args.mjs'
import { describeHarness } from '../src/harness-info.mjs'
import { classify } from '../src/routes.mjs'
import { openDeviceStore } from '../src/store.mjs'
import { ThreadIndex } from '../src/thread-index.mjs'
import { tempDir } from './helpers.mjs'

test('路由分类：设备级、会话、harness、汇总、不支持', () => {
  // 设备层自己处理
  for (const method of [
    'runtime/info',
    'fs/readFile',
    'fs/watch',
    'process/spawn',
    'process/writeStdin',
    'process/resizePty',
    'process/kill',
    'fuzzyFileSearch',
    'fuzzyFileSearch/sessionStart',
  ])
    assert.deepEqual(classify(method, { threadId: 't', harness: 'pi' }), { kind: 'device' }, method)

  assert.deepEqual(classify('thread/list', { harness: 'pi' }), { kind: 'list' })

  // 带会话标识的按会话走，harness 只是索引里没有时的指路
  assert.deepEqual(classify('turn/start', { threadId: 't1', input: [] }), {
    kind: 'thread',
    threadId: 't1',
    harness: null,
  })
  assert.deepEqual(classify('thread/resume', { threadId: 't1', harness: 'pi' }), {
    kind: 'thread',
    threadId: 't1',
    harness: 'pi',
  })
  assert.equal(classify('thread/fork', { threadId: 't1' }).kind, 'thread')

  // 不带会话标识、带 harness 的转给对应上游
  assert.deepEqual(classify('thread/start', { harness: 'pi', cwd: '/' }), {
    kind: 'harness',
    harness: 'pi',
  })
  assert.deepEqual(classify('model/list', { harness: 'claude-code' }), {
    kind: 'harness',
    harness: 'claude-code',
  })

  // 工作区、分区与置顶归设备层：带不带 harness、带不带会话标识都不转给引擎
  for (const method of [
    'project/list',
    'project/read',
    'project/create',
    'project/import',
    'project/update',
    'project/move',
    'project/delete',
    'threadSection/list',
    'threadSection/create',
    'threadSection/update',
    'threadSection/delete',
    'thread/section/move',
  ])
    assert.deepEqual(
      classify(method, { threadId: 't', harness: 'pi' }),
      { kind: 'workspace' },
      method,
    )
  // 改会话的元数据按会话走：归属以外的字段还要到引擎，由连接那一层拆
  assert.equal(classify('thread/metadata/update', { threadId: 't1' }).kind, 'thread')

  // 其余明确不支持，不猜
  for (const [method, params] of [
    ['thread/start', { cwd: '/' }],
    ['model/list', {}],
    ['model/list', undefined],
    ['command/exec', { command: ['ls'], harness: 'pi' }],
    ['command/exec/write', { processId: 'p' }],
    ['process/somethingElse', {}],
    // 这几组名字下设备层不认识的方法也不转给引擎
    ['project/somethingElse', { harness: 'pi' }],
    ['threadSection/somethingElse', { harness: 'pi' }],
    ['thread/section/somethingElse', { threadId: 't1' }],
    ['turn/start', { threadId: '' }],
    ['turn/start', { threadId: 7 }],
  ] as const)
    assert.equal(
      classify(method, params).kind,
      'unsupported',
      `${method} ${JSON.stringify(params)}`,
    )
})

test('启动参数：写法照计划，上游保持出现的顺序', () => {
  const args = parseArgs([
    '--listen',
    'unix:///h/device/device.sock',
    '--state',
    '/h/device',
    '--upstream',
    'claude-code=unix:///h/claude-code/runtime.sock',
    '--upstream',
    'pi=unix:///h/pi/runtime.sock',
  ])
  assert.deepEqual(args, {
    listen: '/h/device/device.sock',
    stateDir: '/h/device',
    upstreams: [
      { id: 'claude-code', path: '/h/claude-code/runtime.sock' },
      { id: 'pi', path: '/h/pi/runtime.sock' },
    ],
  })
  // 一个上游都没有也能启动
  assert.deepEqual(parseArgs(['--listen', 'unix:///a.sock', '--state', '/s']).upstreams, [])
  assert.throws(() => parseArgs(['--state', '/s']), /--listen/)
  assert.throws(() => parseArgs(['--listen', 'ws://127.0.0.1:1', '--state', '/s']), /unix:\/\//)
  assert.throws(() => parseArgs(['--listen', 'unix:///a.sock', '--state', 'relative']), /绝对路径/)
  assert.throws(
    () => parseArgs(['--listen', 'unix:///a.sock', '--state', '/s', '--upstream', 'pi']),
    /标识=unix/,
  )
  assert.throws(
    () =>
      parseArgs([
        '--listen',
        'unix:///a.sock',
        '--state',
        '/s',
        '--upstream',
        'pi=unix:///a',
        '--upstream',
        'pi=unix:///b',
      ]),
    /不止一次/,
  )
  assert.throws(() => parseArgs(['--port', '1']), /不认识的参数/)
})

test('harness 的名字和版本取自上游自己报的，标识只在没有别的可用时才用', () => {
  const pi = { engine: 'pi', cliBuild: '0.99.1' }
  assert.deepEqual(describeHarness('pi', { userAgent: 'x/0.163.0', runtime: pi }, null), {
    id: 'pi',
    displayName: 'Pi',
    badge: 'PI',
    version: '0.99.1',
    engine: 'pi',
    available: true,
    unavailable: null,
  })
  // 同一种引擎配了两份：名字和徽标要分得开
  const second = describeHarness('pi-b', { userAgent: null, runtime: pi }, null)
  assert.equal(second.displayName, 'Pi (pi-b)')
  assert.equal(second.badge, 'PB')
  // 引擎自己报了显示名和徽标也一样：两份报的是同一个徽标，标识和引擎名不同时徽标仍然从标识来
  const selfNamed = { ...pi, displayName: 'Pi', badge: 'PI' }
  assert.equal(describeHarness('pi', { userAgent: null, runtime: selfNamed }, null).badge, 'PI')
  const aliased = describeHarness('pi-b', { userAgent: null, runtime: selfNamed }, null)
  assert.deepEqual([aliased.displayName, aliased.badge], ['Pi (pi-b)', 'PB'])
  // 引擎的结构化声明原样带上：报了哪项带哪项，没报的不出现
  const features = { steer: true, approvals: { kinds: [], uncovered: [] } }
  const presets = [{ id: ':workspace', risk: 'medium' }]
  const declared = describeHarness(
    'pi',
    {
      userAgent: null,
      runtime: {
        ...selfNamed,
        extensions: ['declineWithNote'],
        features,
        permissionPresets: presets,
      },
    },
    null,
  )
  assert.deepEqual(declared.extensions, ['declineWithNote'])
  assert.deepEqual(declared.features, features)
  assert.deepEqual(declared.permissionPresets, presets)
  const partial = describeHarness(
    'pi',
    { userAgent: null, runtime: { ...pi, extensions: [], features: 'nonsense' } },
    null,
  )
  assert.deepEqual(partial.extensions, [])
  assert.ok(!('features' in partial) && !('permissionPresets' in partial))
  // 版本是 cliBuild 里的版本号，不是握手应答里的协议版本
  const claude = describeHarness(
    'claude-code',
    {
      userAgent: 'x/0.163.0',
      runtime: { engine: 'claude-code', cliBuild: '2.1.282 (Claude Code)' },
    },
    null,
  )
  assert.equal(claude.displayName, 'Claude Code')
  assert.equal(claude.badge, 'CC')
  assert.equal(claude.version, '2.1.282')
  // 上游自己带了显示名和徽标的话，用它的
  const named = describeHarness(
    'x',
    { userAgent: null, runtime: { engine: 'x', displayName: 'Some Harness', badge: 'SH' } },
    null,
  )
  assert.equal(named.displayName, 'Some Harness')
  assert.equal(named.badge, 'SH')
  assert.equal(named.version, null)
  // 不认识 runtime/info 的上游（原生 codex）：版本从握手应答里取
  const codex = describeHarness(
    'codex',
    { userAgent: 'codex_cli_rs/0.160.0 (mac)', runtime: null },
    null,
  )
  assert.equal(codex.displayName, 'Codex')
  assert.equal(codex.badge, 'CX')
  assert.equal(codex.version, '0.160.0')
  assert.equal(codex.engine, null)
  // 从没连上过：只有标识
  const never = describeHarness(
    'my-harness',
    { userAgent: null, runtime: null },
    { kind: 'unreachable', message: '连不上' },
  )
  assert.equal(never.displayName, 'my-harness')
  assert.equal(never.badge, 'MH')
  assert.equal(never.available, false)
  assert.deepEqual(never.unavailable, { kind: 'unreachable', message: '连不上' })
})

test('索引：记得住、落了库、临时会话活不过进程、能忘掉；会话的近况跟着记', () => {
  const dir = tempDir()
  try {
    let db = openDeviceStore(dir)
    let index = new ThreadIndex(db)
    // 库和它附带的文件只有属主可读写
    for (const name of readdirSync(dir))
      assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600, name)
    assert.equal(index.lookup('t1'), null)
    index.see({ id: 't1', updatedAt: 100 }, 'pi')
    index.see({ id: 't2', updatedAt: 200 }, 'claude-code', true)
    index.see({ id: 'tmp', updatedAt: 300, ephemeral: true }, 'dsh')
    index.batch(() => {
      index.see({ id: 't3', updatedAt: 1 }, 'pi')
      index.see({ id: 't4', updatedAt: 2 }, 'pi')
    })
    assert.equal(index.lookup('t1'), 'pi')
    assert.equal(index.lookup('tmp'), 'dsh')
    db.close()

    // 重新打开：落了库的还在，临时会话清掉了
    db = openDeviceStore(dir)
    index = new ThreadIndex(db)
    const row = (id: string) =>
      db.prepare('SELECT harness, updated_at, archived, ephemeral FROM threads WHERE id=?').get(id)
    assert.equal(index.lookup('t1'), 'pi')
    assert.equal(index.lookup('t2'), 'claude-code')
    assert.equal(index.lookup('t4'), 'pi')
    assert.equal(index.lookup('tmp'), null)
    assert.deepEqual(
      { ...row('t2') },
      {
        harness: 'claude-code',
        updated_at: 200,
        archived: 1,
        ephemeral: 0,
      },
    )
    // 先是临时的、后来不是了的，要留得下来
    index.see({ id: 'late', updatedAt: 5, ephemeral: true }, 'pi')
    index.see({ id: 'late', updatedAt: 5 }, 'pi')
    // 归属变了以后以新的为准；没说归没归档、没带更新时间的保持原来记的
    index.see({ id: 't2' }, 'pi')
    assert.deepEqual(
      { ...row('t2') },
      {
        harness: 'pi',
        updated_at: 200,
        archived: 1,
        ephemeral: 0,
      },
    )
    index.setArchived('t2', false)
    index.setArchived('never-seen', true)
    assert.equal(row('t2')?.archived, 0)
    assert.equal(row('never-seen'), undefined)
    index.forget('t1')
    db.close()

    db = openDeviceStore(dir)
    index = new ThreadIndex(db)
    assert.equal(index.lookup('late'), 'pi')
    assert.equal(index.lookup('t2'), 'pi')
    assert.equal(index.lookup('t1'), null)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('设备库：结构版本对不上的旧库直接换掉，不是我们的库拒绝', () => {
  const dir = tempDir()
  try {
    let db = openDeviceStore(dir)
    new ThreadIndex(db).see({ id: 't1', updatedAt: 1 }, 'pi')
    // 装成上一版结构留下的库
    db.exec('PRAGMA user_version=1')
    db.close()
    db = openDeviceStore(dir)
    assert.equal(new ThreadIndex(db).lookup('t1'), null)
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 2)
    db.close()
    // 空文件就是还没写过的新库
    rmSync(join(dir, 'device.sqlite'))
    writeFileSync(join(dir, 'device.sqlite'), '')
    openDeviceStore(dir).close()
    // 别的程序的库（没有我们的标记）不碰
    const foreign = new DatabaseSync(join(dir, 'device.sqlite'))
    foreign.exec('PRAGMA application_id=7')
    foreign.close()
    assert.throws(() => openDeviceStore(dir), /旧适配器数据库不受支持/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
