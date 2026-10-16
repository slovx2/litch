// 设备级的工作区、会话归属：聚合面上的 project/*、thread/metadata/update（设计文档 03 第 6.1 节）。
// 上游都是假的，看的是聚合面这一层自己的行为。分区与置顶、新建会话、列表筛选在 workspace-threads.test.mts。
import assert from 'node:assert/strict'
import test from 'node:test'
import { FAKE_PINNED, FakeUpstream } from './fake-upstream.mjs'
import { assertProject, rig, settle, type TestClient } from './helpers.mjs'

const BOTH = ['harness', 'deviceWorkspaces']
const STATUS = 'litch/harness/status/changed'

/** 这条连接收到的某种通知的参数，按到达顺序 */
const got = (client: TestClient, method: string): any[] =>
  client.notifications.filter((frame) => frame.method === method).map((frame) => frame.params)

test('工作区：建、读、改、重排、删都在设备层，变了通知所有连接，一个请求都不转给引擎', async () => {
  const pi = new FakeUpstream('pi')
  const claude = new FakeUpstream('claude-code')
  const env = rig({ pi, 'claude-code': claude })
  try {
    const a = env.connect()
    const b = env.connect()
    const quiet = env.connect()
    await a.initialize(BOTH)
    await b.initialize()
    await quiet.initialize(BOTH, { optOutNotificationMethods: ['project/changed'] })
    assert.deepEqual(await a.call('project/list', {}), { data: [], nextCursor: null })

    const app = (
      await a.call('project/create', {
        name: '应用',
        roots: [{ path: '/work/app' }],
        idempotencyKey: 'k-app',
      })
    ).project
    assertProject(app)
    assert.deepEqual(
      [app.name, app.roots, app.metadata, app.position, app.recencyAt],
      ['应用', [{ path: '/work/app' }], {}, 0, null],
    )
    // 幂等键用过了：返回原来那个，不新建，也不再通知。别的连接来重放也一样
    const replay = await b.call('project/create', {
      name: '换个名字',
      roots: [],
      idempotencyKey: 'k-app',
    })
    assert.deepEqual(replay.project, app)
    const notes = (
      await b.call('project/create', {
        name: '笔记',
        roots: [{ path: '/notes' }, { path: '/notes/archive' }],
        metadata: { color: 'blue' },
        idempotencyKey: 'k-notes',
      })
    ).project
    assert.deepEqual([notes.position, notes.metadata], [1, { color: 'blue' }])
    await settle()
    // 所有连接都收到，发起的那条也收；退订了的不收
    for (const client of [a, b])
      assert.deepEqual(got(client, 'project/changed'), [
        { projectId: app.id, changeType: 'created' },
        { projectId: notes.id, changeType: 'created' },
      ])
    assert.deepEqual(got(quiet, 'project/changed'), [])
    // 发起的那条连接上，请求的应答排在通知前面
    const frames = a.raw.map((text) => JSON.parse(text))
    assert.ok(
      frames.findIndex((frame) => frame.result?.project?.id === app.id) <
        frames.findIndex((frame) => frame.method === 'project/changed'),
    )

    // 改名、改根目录、改元数据：不带的不动
    const renamed = (await a.call('project/update', { projectId: app.id, name: '应用（新）' }))
      .project
    assert.deepEqual([renamed.name, renamed.roots], ['应用（新）', app.roots])
    const moved = (
      await a.call('project/update', {
        projectId: app.id,
        roots: [{ path: '/work/app2' }],
        metadata: { icon: 'x' },
      })
    ).project
    assert.deepEqual(
      [moved.name, moved.roots, moved.metadata],
      ['应用（新）', [{ path: '/work/app2' }], { icon: 'x' }],
    )
    assert.deepEqual((await b.call('project/read', { projectId: app.id })).project, moved)

    // 重排：笔记放到应用之前；位置没变的重排不通知
    assert.deepEqual(
      await a.call('project/move', { projectId: notes.id, beforeProjectId: app.id }),
      {},
    )
    await a.call('project/move', { projectId: notes.id, beforeProjectId: app.id })
    const listed = await b.call('project/list', {})
    for (const project of listed.data) assertProject(project)
    assert.deepEqual(
      listed.data.map((project: any) => [project.name, project.position]),
      [
        ['笔记', 0],
        ['应用（新）', 1],
      ],
    )
    // 翻页
    const first = await a.call('project/list', { limit: 1 })
    assert.deepEqual([first.data.length, typeof first.nextCursor], [1, 'string'])
    const rest = await a.call('project/list', { limit: 1, cursor: first.nextCursor })
    assert.deepEqual([rest.data[0].id, rest.nextCursor], [app.id, null])

    assert.deepEqual(await b.call('project/delete', { projectId: notes.id }), {})
    assert.deepEqual(
      (await a.call('project/list', {})).data.map((project: any) => project.id),
      [app.id],
    )
    await settle()
    assert.deepEqual(got(b, 'project/changed').slice(2), [
      { projectId: app.id, changeType: 'updated' },
      { projectId: app.id, changeType: 'updated' },
      { projectId: notes.id, changeType: 'updated' },
      { projectId: notes.id, changeType: 'deleted' },
    ])

    // 报错和引擎里的一样
    assert.deepEqual(await a.fails('project/read', { projectId: 'nope' }), {
      code: -32602,
      message: '未知项目',
    })
    for (const [method, params] of [
      ['project/create', { name: 'x', roots: [{ path: 'relative' }], idempotencyKey: 'k' }],
      ['project/create', { name: 'x', roots: [] }],
      ['project/update', { projectId: app.id, metadata: { n: 1 } }],
      ['project/move', { projectId: app.id, beforeProjectId: 'nope' }],
      ['project/list', { limit: 0 }],
      ['project/list', { cursor: 'garbage' }],
    ] as const)
      assert.equal(
        (await a.fails(method, params)).code,
        -32602,
        `${method} ${JSON.stringify(params)}`,
      )
    // 这组名字下设备层不认识的方法明确不支持，不猜、不转
    assert.equal(
      (await a.fails('project/archive', { projectId: app.id, harness: 'pi' })).data.litch,
      'unsupported',
    )
    for (const upstream of [pi, claude])
      assert.ok(!upstream.seen.some((entry) => entry.method.startsWith('project/')))
  } finally {
    await env.close()
  }
})

test('会话归属：记在设备层、跨 harness，别的字段照旧到引擎，会话对象上是设备层的值', async () => {
  // 引擎自己那一份归属和置顶（官方桌面端在它的入口上记的）不能带到聚合面上来
  const pi = new FakeUpstream('pi', [
    {
      id: 'p1',
      updatedAt: 500,
      projectId: 'engine-own-project',
      section: { ...FAKE_PINNED },
      sectionEnteredAt: 7,
      isPinned: true,
      sectionId: FAKE_PINNED.id,
    },
    { id: 'p2', updatedAt: 300 },
  ])
  const claude = new FakeUpstream('claude-code', [{ id: 'c1', updatedAt: 400 }])
  const env = rig({ pi, 'claude-code': claude })
  try {
    const a = env.connect()
    const b = env.connect()
    await a.initialize(BOTH)
    await b.initialize(BOTH)
    const app = (
      await a.call('project/create', { name: '应用', roots: [], idempotencyKey: 'k-app' })
    ).project
    const fields = (thread: any) => [
      thread.id,
      thread.projectId,
      thread.section,
      thread.sectionEnteredAt,
      thread.isPinned,
      thread.sectionId,
    ]
    assert.deepEqual((await a.call('thread/list', {})).data.map(fields), [
      // 适配器的引擎多给的 isPinned、sectionId：对面给了才换，没给的不添
      ['p1', null, null, null, false, null],
      ['c1', null, null, null, undefined, undefined],
      ['p2', null, null, null, undefined, undefined],
    ])

    // 只改归属：不动引擎，只向它要一份会话对象来答
    let from = pi.seen.length
    const moved = await a.call('thread/metadata/update', { threadId: 'p1', projectId: app.id })
    assert.deepEqual(Object.keys(moved), ['thread'])
    assert.deepEqual(fields(moved.thread), ['p1', app.id, null, null, false, null])
    assert.equal(moved.thread.harness, 'pi')
    assert.deepEqual(
      pi.seen.slice(from).map((entry) => [entry.method, entry.params]),
      [['thread/read', { threadId: 'p1', includeTurns: false }]],
    )
    // 带着别的字段：那些字段到会话所属的引擎，归属和 harness 不带过去
    const tagged = await b.call('thread/metadata/update', {
      threadId: 'c1',
      harness: 'claude-code',
      projectId: app.id,
      gitInfo: { branch: 'main' },
    })
    assert.deepEqual(claude.seen.at(-1), {
      method: 'thread/metadata/update',
      params: { threadId: 'c1', gitInfo: { branch: 'main' } },
      id: claude.seen.at(-1)?.id,
    })
    assert.deepEqual(
      [tagged.thread.projectId, tagged.thread.gitInfo, tagged.thread.harness],
      [app.id, { branch: 'main' }, 'claude-code'],
    )
    // 再归一次、不带、给 null 都是没变：不通知
    await a.call('thread/metadata/update', { threadId: 'p1', projectId: app.id })
    await a.call('thread/metadata/update', { threadId: 'p1', projectId: null })
    await a.call('thread/metadata/update', { threadId: 'p1' })
    await settle()
    for (const client of [a, b])
      assert.deepEqual(got(client, 'thread/project/updated'), [
        { threadId: 'p1', projectId: app.id },
        { threadId: 'c1', projectId: app.id },
      ])

    // 之后各处读到的都是设备层的值；工作区的最近活动时间是成员里最新的那个
    assert.equal(
      (await b.call('thread/read', { threadId: 'p1', includeTurns: false })).thread.projectId,
      app.id,
    )
    assert.equal((await b.call('thread/resume', { threadId: 'c1' })).thread.projectId, app.id)
    assert.deepEqual(
      (await b.call('thread/list', {})).data.map((thread: any) => [thread.id, thread.projectId]),
      [
        ['p1', app.id],
        ['c1', app.id],
        ['p2', null],
      ],
    )
    const recency = async () =>
      (await a.call('project/read', { projectId: app.id })).project.recencyAt
    assert.equal(await recency(), 500)
    // 空字符串是解除
    const cleared = await a.call('thread/metadata/update', { threadId: 'p1', projectId: '' })
    assert.equal(cleared.thread.projectId, null)
    assert.equal(await recency(), 400)

    // 工作区不存在：失败，引擎也没有被动
    from = claude.seen.length
    assert.deepEqual(
      await a.fails('thread/metadata/update', {
        threadId: 'c1',
        projectId: 'nope',
        gitInfo: { branch: 'x' },
      }),
      { code: -32602, message: '未知项目' },
    )
    assert.equal(claude.seen.length, from)
    assert.equal(
      (await a.fails('thread/metadata/update', { threadId: 'nobody', projectId: app.id })).data
        .litch,
      'unknownThread',
    )

    // project/import：建工作区的同时把会话归进去；有哪个 harness 都不认识的会话就整个不做
    await settle()
    from = got(b, 'thread/project/updated').length
    const notes = (
      await a.call('project/import', {
        name: '笔记',
        roots: [{ path: '/notes' }],
        threads: ['p2', 'c1'],
        idempotencyKey: 'k-import',
      })
    ).project
    assert.deepEqual(
      await a.fails('project/import', {
        name: 'x',
        roots: [],
        threads: ['p1', 'nobody'],
        idempotencyKey: 'k-bad',
      }),
      { code: -32602, message: '导入包含未知会话' },
    )
    assert.equal((await a.call('project/list', {})).data.length, 2)
    await settle()
    assert.deepEqual(got(b, 'thread/project/updated').slice(from), [
      { threadId: 'p2', projectId: notes.id },
      { threadId: 'c1', projectId: notes.id },
    ])

    // 删工作区只解除归属，不删会话
    await settle()
    from = got(a, 'thread/project/updated').length
    await a.call('project/delete', { projectId: notes.id })
    await settle()
    assert.deepEqual(
      got(a, 'thread/project/updated')
        .slice(from)
        .map((update) => [update.threadId, update.projectId])
        .sort(),
      [
        ['c1', null],
        ['p2', null],
      ],
    )
    assert.deepEqual(
      (await a.call('thread/list', {})).data.map((thread: any) => thread.projectId),
      [null, null, null],
    )
    assert.deepEqual([pi.threads.length, claude.threads.length], [2, 1])

    // 会话所属的 harness 不可用：拿不到会话对象来答，改不了
    claude.crash()
    await a.waitFor(
      (frame) => frame.method === STATUS && (frame.params as any).harness === 'claude-code',
    )
    const refused = await a.fails('thread/metadata/update', { threadId: 'c1', projectId: app.id })
    assert.equal(refused.data.litch, 'harnessUnavailable')
    assert.equal((await a.call('project/read', { projectId: app.id })).project.recencyAt, null)
  } finally {
    await env.close()
  }
})
