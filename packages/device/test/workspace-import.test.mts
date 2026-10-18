// 设备级的工作区第一次启用时从各引擎现有的项目导入：经一个真的设备、假的上游。
// 合并规则的边角在 workspace-merge.test.mts。
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { FAKE_PINNED, FakeUpstream, fakeProject } from './fake-upstream.mjs'
import { assertProject, PINNED, type Rig, rig, settle, type TestClient } from './helpers.mjs'

const BOTH = ['harness', 'deviceWorkspaces']
const SOURCES = 'litch.import.sources'
const IMPORTING = { importExisting: true }

const got = (client: TestClient, method: string): any[] =>
  client.notifications.filter((frame) => frame.method === method).map((frame) => frame.params)

/** 三个引擎各自现有的东西：Pi 和 Claude 都有项目，dsh 没有项目这组方法 */
function engines() {
  const later = { id: 'sec-pi-later', name: '稍后看', appearance: null }
  const pi = new FakeUpstream('pi', [
    { id: 'p1', updatedAt: 500, projectId: 'pi-app', section: FAKE_PINNED, sectionEnteredAt: 77 },
    { id: 'p2', updatedAt: 300, projectId: 'pi-solo' },
    { id: 'p3', updatedAt: 200, section: later, sectionEnteredAt: 55 },
    { id: 'p4', updatedAt: 100, projectId: 'pi-app', archived: true },
    // 它的项目在引擎里已经没有了
    { id: 'p5', updatedAt: 50, projectId: 'gone-project' },
    // 早先的数据：只有置顶的标记，没有分区
    { id: 'p6', updatedAt: 40, isPinned: true },
  ])
  pi.projects = [
    fakeProject('pi-app', '应用（Pi）', ['/work/app'], {
      createdAt: 2000,
      updatedAt: 2500,
      metadata: { color: 'red', pi: 'yes' },
    }),
    fakeProject('pi-solo', '只在 Pi', ['/work/solo'], { position: 1, createdAt: 1500 }),
    fakeProject('pi-bare', '没有目录', [], { position: 2, createdAt: 1000 }),
    fakeProject('pi-dup', '同名', ['/a'], { position: 3, createdAt: 1200 }),
  ]
  pi.sections = [later]
  const claudeLater = { id: 'sec-cc-later', name: '稍后看', appearance: { icon: 'c', color: null } }
  const done = { id: 'sec-cc-done', name: '做完的', appearance: null }
  const claude = new FakeUpstream('claude-code', [
    { id: 'c1', updatedAt: 400, projectId: 'cc-app' },
    { id: 'c2', updatedAt: 350, section: claudeLater, sectionEnteredAt: 66 },
    { id: 'c3', updatedAt: 250, projectId: 'cc-two', section: done },
  ])
  claude.projects = [
    // 和 Pi 的“应用”根目录相同（多一个结尾的斜杠），建得更早
    fakeProject('cc-app', '应用', ['/work/app/'], {
      createdAt: 1000,
      updatedAt: 1100,
      metadata: { color: 'blue' },
    }),
    fakeProject('cc-two', '两个目录', ['/x', '/y'], { position: 1, createdAt: 3000 }),
    fakeProject('cc-bare', '没有目录', [], { position: 2, createdAt: 900 }),
    fakeProject('cc-dup', '同名', ['/b'], { position: 3, createdAt: 1300 }),
  ]
  claude.sections = [claudeLater, done]
  const dsh = new FakeUpstream('dsh', [{ id: 'd1', updatedAt: 10 }])
  return { pi, claude, dsh, upstreams: { pi, 'claude-code': claude, dsh } }
}

/** 聚合面上现在看到的全部：工作区、分区、每个会话的归属和分区 */
async function view(client: TestClient) {
  const projects = (await client.call('project/list', {})).data
  const sections = (await client.call('threadSection/list', {})).data
  const threads = [
    ...(await client.call('thread/list', { limit: 100 })).data,
    ...(await client.call('thread/list', { limit: 100, archived: true })).data,
  ].map((thread: any) => [
    thread.id,
    thread.harness,
    thread.projectId,
    thread.section?.id ?? null,
    thread.sectionEnteredAt,
  ])
  return { projects, sections, threads }
}

const WRITES =
  /^(project\/(create|import|update|move|delete)|threadSection\/(create|update|delete)|thread\/(section\/move|metadata\/update|start|fork|archive|unarchive|delete))$/

test('导入：根目录相同的合成一个，名字取最早建的，归属、分区、置顶一并带过来；只读引擎；删掉设备库重来结果一样', async () => {
  const { pi, claude, dsh, upstreams } = engines()
  const untouched = JSON.stringify([pi.projects, pi.threads, claude.projects, claude.threads])
  const first = rig(upstreams, {}, IMPORTING)
  let current: Rig = first
  try {
    const a = first.connect()
    // 握手会等导入做完：握手一成，列出来的就是导入后的
    await a.initialize(BOTH)
    const seen = await view(a)
    for (const project of seen.projects) assertProject(project)
    assert.deepEqual(
      seen.projects.map((project: any) => [
        project.id,
        project.name,
        project.roots,
        project.position,
      ]),
      [
        // 两个引擎里根目录相同的合成了一个：标识、名称、根目录取最早建的那个（Claude 的）
        ['cc-app', '应用', [{ path: '/work/app/' }], 0],
        ['pi-solo', '只在 Pi', [{ path: '/work/solo' }], 1],
        // 没有根目录的不和谁合；名称相同但根目录不同的不合
        ['pi-bare', '没有目录', [], 2],
        ['pi-dup', '同名', [{ path: '/a' }], 3],
        ['cc-two', '两个目录', [{ path: '/x' }, { path: '/y' }], 4],
        ['cc-bare', '没有目录', [], 5],
        ['cc-dup', '同名', [{ path: '/b' }], 6],
      ],
    )
    const app = seen.projects[0]
    // 其余的名字记在元数据里备查；元数据里别的键，最早建的那个说了算
    assert.deepEqual(JSON.parse(app.metadata[SOURCES]), [
      { harness: 'pi', projectId: 'pi-app', name: '应用（Pi）' },
      { harness: 'claude-code', projectId: 'cc-app', name: '应用' },
    ])
    assert.deepEqual(
      [app.metadata.color, app.metadata.pi, app.createdAt, app.updatedAt, app.recencyAt],
      ['blue', 'yes', 1000, 2500, 500],
    )
    assert.deepEqual(JSON.parse(seen.projects[1].metadata[SOURCES]), [
      { harness: 'pi', projectId: 'pi-solo', name: '只在 Pi' },
    ])
    // 自定义分区按名称合，标识和外观是先见到的那个的
    assert.deepEqual(seen.sections, [
      { id: PINNED, name: 'Pinned', appearance: null },
      { id: 'sec-pi-later', name: '稍后看', appearance: null },
      { id: 'sec-cc-done', name: '做完的', appearance: null },
    ])
    assert.deepEqual(seen.threads, [
      // 合成的那个工作区下面有两边的会话
      ['p1', 'pi', 'cc-app', PINNED, 77],
      ['c1', 'claude-code', 'cc-app', null, null],
      ['c2', 'claude-code', null, 'sec-pi-later', 66],
      ['p2', 'pi', 'pi-solo', null, null],
      // 引擎没记进分区的时间：用会话的更新时间
      ['c3', 'claude-code', 'cc-two', 'sec-cc-done', 250],
      ['p3', 'pi', null, 'sec-pi-later', 55],
      // 项目在引擎里已经没有了的：没有归属
      ['p5', 'pi', null, null, null],
      ['p6', 'pi', null, PINNED, 40],
      ['d1', 'dsh', null, null, null],
      // 归档了的会话也带着归属
      ['p4', 'pi', 'cc-app', null, null],
    ])
    assert.deepEqual(
      (await a.call('thread/list', { projectId: 'cc-app' })).data.map((thread: any) => thread.id),
      ['p1', 'c1'],
    )

    // 只读引擎：没有发过一个写的请求，它们的数据原样
    for (const upstream of [pi, claude, dsh])
      assert.deepEqual(
        upstream.seen.filter((entry) => WRITES.test(entry.method)),
        [],
      )
    assert.equal(
      JSON.stringify([pi.projects, pi.threads, claude.projects, claude.threads]),
      untouched,
    )

    // 删掉设备库再启动：重新导入，得到同样的结果
    await first.device.close()
    for (const suffix of ['', '-wal', '-shm'])
      rmSync(join(first.stateDir, `device.sqlite${suffix}`), { force: true })
    current = rig(upstreams, {}, { ...IMPORTING, stateDir: first.stateDir })
    const b = current.connect()
    await b.initialize(BOTH)
    assert.deepEqual(await view(b), seen)

    // 一个 harness 只导入一次：之后两边各管各的。设备层删掉、改掉的不会被再导回来，引擎后来建的也不跟过来
    await b.call('project/delete', { projectId: 'pi-solo' })
    await b.call('project/update', { projectId: 'cc-app', name: '改过的名字' })
    await b.call('thread/metadata/update', { threadId: 'p1', isPinned: false })
    pi.projects?.push(fakeProject('pi-late', '后来建的', ['/late'], { position: 9 }))
    const edited = await view(b)
    await current.device.close()
    const reads = () =>
      [pi, claude, dsh].map(
        (upstream) => upstream.seen.filter((entry) => entry.method === 'project/list').length,
      )
    const before = reads()
    current = rig(upstreams, {}, { ...IMPORTING, stateDir: first.stateDir })
    const c = current.connect()
    await c.initialize(BOTH)
    assert.deepEqual(await view(c), edited)
    assert.deepEqual(reads(), before)
    assert.deepEqual(
      edited.projects.map((project: any) => project.name),
      ['改过的名字', '没有目录', '同名', '两个目录', '没有目录', '同名'],
    )
  } finally {
    await current.close()
  }
})

test('导入：引擎当时不可用的，等它可用了补导入，并进已有的工作区，在线的连接收到通知', async () => {
  const { pi, claude, upstreams } = engines()
  claude.down = true
  const lines: string[] = []
  const env = rig(upstreams, {}, { ...IMPORTING, log: (line) => lines.push(line) })
  try {
    const a = env.connect()
    await a.initialize(BOTH)
    // 先只有连得上的那几个引擎的
    assert.deepEqual(
      (await a.call('project/list', {})).data.map((project: any) => project.id),
      ['pi-app', 'pi-solo', 'pi-bare', 'pi-dup'],
    )
    assert.ok(lines.some((line) => line.includes('claude-code') && line.includes('没有导入成')))
    const failed = lines.filter((line) => line.includes('没有导入成')).length
    // 每次握手都会再看一遍，原因没变的不重复写日志
    const other = env.connect()
    await other.initialize()
    assert.equal(lines.filter((line) => line.includes('没有导入成')).length, failed)

    // Claude 起来了：这条连接连上它的时候补导入
    claude.down = false
    await a.waitFor(
      (frame) => frame.method === 'project/changed' && (frame.params as any).projectId === 'cc-dup',
    )
    // 这一次导入的通知是一条条排着发的：等它们都到
    await settle()
    const projects = (await a.call('project/list', {})).data
    assert.deepEqual(
      projects.map((project: any) => [project.id, project.name, project.position]),
      [
        // 根目录相同的并进了已有的那个：不改它的标识、名称和根目录，只把来源记上
        ['pi-app', '应用（Pi）', 0],
        ['pi-solo', '只在 Pi', 1],
        ['pi-bare', '没有目录', 2],
        ['pi-dup', '同名', 3],
        // 没有根目录相同的才新建，排在现有的后面
        ['cc-two', '两个目录', 4],
        ['cc-bare', '没有目录', 5],
        ['cc-dup', '同名', 6],
      ],
    )
    assert.deepEqual(projects[0].roots, [{ path: '/work/app' }])
    assert.deepEqual(JSON.parse(projects[0].metadata[SOURCES]), [
      { harness: 'pi', projectId: 'pi-app', name: '应用（Pi）' },
      { harness: 'claude-code', projectId: 'cc-app', name: '应用' },
    ])
    assert.equal(projects[0].metadata.color, 'red')
    assert.deepEqual(
      (await a.call('thread/list', { projectId: 'pi-app' })).data.map((thread: any) => thread.id),
      ['p1', 'c1'],
    )
    // 在线的连接收到的通知：工作区变了、会话的归属和分区有了
    assert.deepEqual(got(a, 'project/changed'), [
      { projectId: 'pi-app', changeType: 'updated' },
      { projectId: 'cc-two', changeType: 'created' },
      { projectId: 'cc-bare', changeType: 'created' },
      { projectId: 'cc-dup', changeType: 'created' },
    ])
    assert.deepEqual(got(a, 'thread/project/updated'), [
      { threadId: 'c1', projectId: 'pi-app' },
      { threadId: 'c3', projectId: 'cc-two' },
    ])
    assert.deepEqual(
      got(a, 'litch/thread/section/updated').map((update) => [update.threadId, update.section.id]),
      [
        ['c2', 'sec-pi-later'],
        ['c3', 'sec-cc-done'],
      ],
    )
    assert.deepEqual(got(a, 'litch/threadSection/changed'), [
      { sectionId: 'sec-cc-done', changeType: 'created' },
    ])
    assert.deepEqual(
      pi.seen.filter((entry) => WRITES.test(entry.method)),
      [],
    )
  } finally {
    await env.close()
  }
})
