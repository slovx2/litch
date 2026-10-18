// 设备级的分区与置顶、按工作区和分区筛会话列表。上游都是假的。
// 工作区本身和会话归属在 workspaces.test.mts，带工作区新建、删除归档、重启在 workspace-lifecycle.test.mts。
import assert from 'node:assert/strict'
import test from 'node:test'
import { FakeUpstream } from './fake-upstream.mjs'
import {
  assertSection,
  assertSectionsChanged,
  assertSectionUpdated,
  assertThreadList,
  PINNED,
  rig,
  settle,
  type TestClient,
} from './helpers.mjs'

const BOTH = ['harness', 'deviceWorkspaces']
const STATUS = 'litch/harness/status/changed'
const SECTION_UPDATED = 'litch/thread/section/updated'
const SECTIONS_CHANGED = 'litch/threadSection/changed'
const PINNED_SECTION = { id: PINNED, name: 'Pinned', appearance: null }

const got = (client: TestClient, method: string): any[] =>
  client.notifications.filter((frame) => frame.method === method).map((frame) => frame.params)

test('分区与置顶：记在设备层，形状照协议；变化的通知只给声明过 deviceWorkspaces 的连接', async () => {
  const pi = new FakeUpstream('pi', [
    { id: 'p1', updatedAt: 500, isPinned: false, sectionId: null },
    { id: 'p2', updatedAt: 300 },
  ])
  const claude = new FakeUpstream('claude-code', [{ id: 'c1', updatedAt: 400 }])
  const env = rig({ pi, 'claude-code': claude })
  try {
    const a = env.connect()
    const plain = env.connect()
    await a.initialize(BOTH)
    await plain.initialize()
    // 置顶用的那个分区一直在
    assert.deepEqual(await a.call('threadSection/list', {}), {
      data: [PINNED_SECTION],
      nextCursor: null,
    })

    const later = (
      await a.call('threadSection/create', {
        name: '  稍后看 ',
        appearance: { icon: 'clock', color: null },
      })
    ).section
    assertSection(later)
    assert.deepEqual([later.name, later.appearance], ['稍后看', { icon: 'clock', color: null }])
    const done = (await plain.call('threadSection/create', { name: '做完的' })).section
    assert.equal(done.appearance, null)
    const listed = await plain.call('threadSection/list', {})
    for (const section of listed.data) assertSection(section)
    assert.deepEqual(
      listed.data.map((section: any) => section.id),
      [PINNED, later.id, done.id],
    )
    const first = await a.call('threadSection/list', { limit: 2 })
    assert.deepEqual([first.data.length, first.nextCursor], [2, '2'])
    assert.deepEqual(await a.call('threadSection/list', { limit: 2, cursor: first.nextCursor }), {
      data: [done],
      nextCursor: null,
    })
    // 改：名称不给就不改；外观不给是不改，给 null 是清掉
    const renamed = { id: later.id, name: '回头看', appearance: { icon: 'clock', color: null } }
    assert.deepEqual(
      (await a.call('threadSection/update', { sectionId: later.id, name: '回头看' })).section,
      renamed,
    )
    const bare = { ...renamed, appearance: null }
    assert.deepEqual(
      (await a.call('threadSection/update', { sectionId: later.id, appearance: null })).section,
      bare,
    )

    // 放进分区；会话对象上带着分区和进去的时间
    assert.deepEqual(
      await a.call('thread/section/move', {
        threadId: 'p1',
        sectionId: later.id,
        beforeThreadId: null,
      }),
      {},
    )
    const read = (await plain.call('thread/read', { threadId: 'p1', includeTurns: false })).thread
    assert.deepEqual(
      [read.section, typeof read.sectionEnteredAt, read.isPinned, read.sectionId],
      [bare, 'number', false, later.id],
    )
    // 本来就在这个分区里：不动，也不通知
    await a.call('thread/section/move', { threadId: 'p1', sectionId: later.id })
    // 置顶就是进固定的那个分区：直接从别的分区换过来
    await a.call('thread/section/move', { threadId: 'p1', sectionId: PINNED })
    // 用 isPinned 置顶：记在设备层，引擎只被要了一份会话对象
    const from = claude.seen.length
    const pinned = (await plain.call('thread/metadata/update', { threadId: 'c1', isPinned: true }))
      .thread
    assert.deepEqual([pinned.section, pinned.harness], [PINNED_SECTION, 'claude-code'])
    await plain.call('thread/metadata/update', { threadId: 'c1', isPinned: true })
    assert.ok(claude.seen.length > from)
    assert.ok(claude.seen.slice(from).every((entry) => entry.method === 'thread/read'))
    // 在别的分区里的会话“取消置顶”不动它
    await a.call('thread/section/move', { threadId: 'p2', sectionId: done.id })
    const kept = (await a.call('thread/metadata/update', { threadId: 'p2', isPinned: false }))
      .thread
    assert.equal(kept.section.id, done.id)
    await a.call('thread/metadata/update', { threadId: 'c1', isPinned: false })
    await a.call('thread/section/move', { threadId: 'p1', sectionId: null })
    await settle()
    const updates = got(a, SECTION_UPDATED)
    for (const update of updates) assertSectionUpdated(update)
    assert.deepEqual(
      updates.map((update) => [update.threadId, update.section?.id ?? null, update.isPinned]),
      [
        ['p1', later.id, false],
        ['p1', PINNED, true],
        ['c1', PINNED, true],
        ['p2', done.id, false],
        ['c1', null, false],
        ['p1', null, false],
      ],
    )
    assert.deepEqual(
      updates.map((update) => typeof update.sectionEnteredAt),
      ['number', 'number', 'number', 'number', 'object', 'object'],
    )
    const changes = got(a, SECTIONS_CHANGED)
    for (const change of changes) assertSectionsChanged(change)
    assert.deepEqual(changes, [
      { sectionId: later.id, changeType: 'created' },
      { sectionId: done.id, changeType: 'created' },
      { sectionId: later.id, changeType: 'updated' },
      { sectionId: later.id, changeType: 'updated' },
    ])

    // 分区改了名，里面的会话带着的分区对象也变了：给它们各发一条。删分区只是把里面的会话放出来
    await a.call('threadSection/update', { sectionId: done.id, name: '完成' })
    assert.deepEqual(await a.call('threadSection/delete', { sectionId: done.id }), {})
    await settle()
    assert.deepEqual(
      got(a, SECTION_UPDATED)
        .slice(updates.length)
        .map((update) => [update.threadId, update.section?.name ?? null]),
      [
        ['p2', '完成'],
        ['p2', null],
      ],
    )
    assert.deepEqual(got(a, SECTIONS_CHANGED).slice(changes.length), [
      { sectionId: done.id, changeType: 'updated' },
      { sectionId: done.id, changeType: 'deleted' },
    ])
    assert.equal(
      (await a.call('thread/read', { threadId: 'p2', includeTurns: false })).thread.section,
      null,
    )
    assert.equal(pi.threads.length, 2)
    // 没声明这个扩展的连接：方法照样能用，这两条通知一条都收不到
    assert.deepEqual(
      plain.notifications.filter((frame) => String(frame.method).startsWith('litch/thread')),
      [],
    )

    // 报错
    const builtin = { code: -32602, message: '内置的置顶分区不能修改或删除' }
    assert.deepEqual(
      await a.fails('threadSection/update', { sectionId: PINNED, name: 'x' }),
      builtin,
    )
    assert.deepEqual(await a.fails('threadSection/delete', { sectionId: PINNED }), builtin)
    const unknown = { code: -32602, message: '未知分区' }
    assert.deepEqual(await a.fails('threadSection/update', { sectionId: 'nope' }), unknown)
    assert.deepEqual(await a.fails('threadSection/delete', { sectionId: done.id }), unknown)
    assert.deepEqual(
      await a.fails('thread/section/move', { threadId: 'p1', sectionId: 'nope' }),
      unknown,
    )
    assert.equal((await a.fails('threadSection/create', { name: '   ' })).code, -32602)
    assert.equal((await a.fails('thread/section/move', { threadId: 'p1' })).code, -32602)
    assert.equal(
      (await a.fails('thread/section/move', { threadId: 'nobody', sectionId: PINNED })).data.litch,
      'unknownThread',
    )

    // 会话所属的 harness 不在场也能改分区（改归属要它在场：要拿会话对象来答）
    claude.crash()
    await a.waitFor(
      (frame) => frame.method === STATUS && (frame.params as any).harness === 'claude-code',
    )
    await a.call('thread/section/move', { threadId: 'c1', sectionId: PINNED })
    assert.deepEqual(
      (await a.call('thread/list', { isPinned: true })).skippedHarnesses.map(
        (entry: any) => entry.harness,
      ),
      ['claude-code'],
    )
    // 分区的事一件都没有到引擎那里
    for (const upstream of [pi, claude]) {
      assert.ok(
        !upstream.seen.some(
          (entry) =>
            entry.method.startsWith('threadSection/') || entry.method.startsWith('thread/section/'),
        ),
      )
      assert.ok(!upstream.seen.some((entry) => entry.method === 'thread/metadata/update'))
    }
  } finally {
    await env.close()
  }
})

test('会话列表：按工作区、分区、置顶筛由设备层做，翻页不漏不重，筛选条件不交给上游', async () => {
  // 合并后的顺序：p0 c0 p1 c1 p2 c2 p3 c3 p4 c4 p5 c5 d0
  const pi = new FakeUpstream(
    'pi',
    Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, updatedAt: 1000 - i * 20 })),
  )
  const claude = new FakeUpstream(
    'claude-code',
    Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, updatedAt: 990 - i * 20 })),
  )
  const dsh = new FakeUpstream('dsh', [{ id: 'd0', updatedAt: 5 }])
  const env = rig({ pi, 'claude-code': claude, dsh })
  try {
    const a = env.connect()
    await a.initialize(BOTH)
    const create = async (name: string) =>
      (await a.call('project/create', { name, roots: [], idempotencyKey: name })).project
    const app = await create('应用')
    const notes = await create('笔记')
    const later = (await a.call('threadSection/create', { name: '稍后看' })).section
    for (const threadId of ['p1', 'p4', 'c0', 'c5'])
      await a.call('thread/metadata/update', { threadId, projectId: app.id })
    await a.call('thread/metadata/update', { threadId: 'c2', projectId: notes.id })
    for (const threadId of ['p4', 'c3'])
      await a.call('thread/metadata/update', { threadId, isPinned: true })
    for (const threadId of ['c0', 'p2'])
      await a.call('thread/section/move', { threadId, sectionId: later.id })

    /** 按给的页大小翻到底。每一页都不超过页大小，形状对，会话对象上是设备层的值 */
    const walk = async (params: Record<string, unknown>, limit: number): Promise<string[]> => {
      const ids: string[] = []
      let cursor: string | null = null
      for (let page = 0; page < 40; page++) {
        const result: any = await a.call('thread/list', { ...params, limit, cursor })
        assertThreadList(result)
        assert.ok(result.data.length <= limit)
        for (const thread of result.data) {
          assert.ok('projectId' in thread && 'section' in thread && 'sectionEnteredAt' in thread)
          ids.push(thread.id)
        }
        if (result.nextCursor === null) return ids
        cursor = result.nextCursor
      }
      throw new Error('翻了 40 页还没有到头')
    }
    const all = ['p0', 'c0', 'p1', 'c1', 'p2', 'c2', 'p3', 'c3', 'p4', 'c4', 'p5', 'c5', 'd0']
    const without = (...gone: string[]) => all.filter((id) => !gone.includes(id))
    const cases: [Record<string, unknown>, string[]][] = [
      [{}, all],
      [{ projectId: app.id }, ['c0', 'p1', 'p4', 'c5']],
      [{ projectId: notes.id }, ['c2']],
      // null 是“没有归属的”“不在分区里的”
      [{ projectId: null }, without('c0', 'p1', 'p4', 'c5', 'c2')],
      [{ isPinned: true }, ['c3', 'p4']],
      [{ isPinned: false }, without('c3', 'p4')],
      [{ sectionId: PINNED }, ['c3', 'p4']],
      [{ sectionId: later.id }, ['c0', 'p2']],
      [{ sectionId: null }, without('c3', 'p4', 'c0', 'p2')],
      // 几个条件一起给：都要满足
      [{ projectId: app.id, isPinned: true }, ['p4']],
      [{ projectId: app.id, sectionId: null }, ['p1', 'c5']],
      [{ projectId: app.id, harness: 'pi' }, ['p1', 'p4']],
      [{ projectId: 'nope' }, []],
    ]
    for (const [params, expected] of cases)
      for (const limit of [1, 2, 3, 50])
        assert.deepEqual(
          await walk(params, limit),
          expected,
          `${JSON.stringify(params)} 每页 ${limit}`,
        )

    // 这几个条件一个都没有交给上游
    for (const upstream of [pi, claude, dsh])
      for (const entry of upstream.seen.filter((item) => item.method === 'thread/list'))
        for (const key of ['projectId', 'sectionId', 'isPinned', 'harness'])
          assert.ok(!(key in entry.params), `${key} 被带给了上游`)
    // 要的会话都属于哪个 harness 是知道的：别的 harness 不用问
    const asked = () =>
      [pi, claude, dsh].map(
        (upstream) => upstream.seen.filter((entry) => entry.method === 'thread/list').length,
      )
    const before = asked()
    await a.call('thread/list', { projectId: notes.id })
    await a.call('thread/list', { projectId: 'nope' })
    assert.deepEqual(
      asked().map((count, index) => count - (before[index] ?? 0)),
      [0, 1, 0],
    )

    // 归档了的会话归属还在：按工作区列归档的也筛得出来
    await a.call('thread/archive', { threadId: 'c5' })
    assert.deepEqual(await walk({ projectId: app.id }, 2), ['c0', 'p1', 'p4'])
    assert.deepEqual(await walk({ projectId: app.id, archived: true }, 2), ['c5'])
  } finally {
    await env.close()
  }
})
