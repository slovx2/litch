// 会话一生里和设备级工作区有关的几个时刻：带工作区新建、分叉、归档、删除、设备进程重启（设计文档 03 第 6.1 节）。
// 上游都是假的。
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { FakeUpstream } from './fake-upstream.mjs'
import { PINNED, type Rig, rig, settle, type TestClient } from './helpers.mjs'

const BOTH = ['harness', 'deviceWorkspaces']
const STATUS = 'litch/harness/status/changed'

const got = (client: TestClient, method: string): any[] =>
  client.notifications.filter((frame) => frame.method === method).map((frame) => frame.params)

/** 这条连接收到的帧里，某个会话的新建应答和会话开始通知各排在第几 */
function order(client: TestClient, threadId: string): { answered: number; started: number } {
  const frames = client.raw.map((text) => JSON.parse(text))
  return {
    answered: frames.findIndex((frame) => frame.result?.thread?.id === threadId),
    started: frames.findIndex(
      (frame) => frame.method === 'thread/started' && frame.params.thread.id === threadId,
    ),
  }
}

test('带工作区新建会话：工作区不带给引擎，会话建好了记进设备层，应答和会话开始的通知都带着；重启后还在', async () => {
  const pi = new FakeUpstream('pi')
  const claude = new FakeUpstream('claude-code')
  // 引擎把会话开始的通知发给它的每一条连接。Pi 先回应答再发通知，Claude 反过来
  const piStart = pi.handlers['thread/start']
  pi.handlers['thread/start'] = (params, connection) => {
    const result = piStart?.(params, connection) as any
    queueMicrotask(() =>
      pi.notify('thread/started', { threadId: result.thread.id, thread: { ...result.thread } }),
    )
    return result
  }
  const claudeStart = claude.handlers['thread/start']
  claude.handlers['thread/start'] = (params, connection) => {
    const result = claudeStart?.(params, connection) as any
    claude.notify('thread/started', { thread: { ...result.thread } })
    return result
  }
  const upstreams = { pi, 'claude-code': claude }
  const first = rig(upstreams)
  let second: Rig | null = null
  try {
    // b 先连：引擎的通知先到它的那条上游连接，再到发起新建的 a 的
    const b = first.connect()
    const a = first.connect()
    await b.initialize(BOTH)
    await a.initialize(BOTH)
    const app = (await a.call('project/create', { name: '应用', roots: [], idempotencyKey: 'k' }))
      .project

    const born = (await a.call('thread/start', { harness: 'pi', projectId: app.id, cwd: '/w' }))
      .thread
    assert.deepEqual([born.projectId, born.harness, born.section], [app.id, 'pi', null])
    // 工作区和 harness 都没有带给引擎
    assert.deepEqual(pi.seen.at(-1)?.params, { cwd: '/w' })
    const piStarted = await a.waitFor(
      (frame) => frame.method === 'thread/started' && (frame.params as any).thread.id === born.id,
    )
    assert.equal((piStarted.params as any).thread.projectId, app.id)

    // 通知先于应答的引擎：发起的那条连接上通知被扣到应答之后，两处都带着工作区
    const other = (await a.call('thread/start', { harness: 'claude-code', projectId: app.id }))
      .thread
    assert.equal(other.projectId, app.id)
    const claudeStarted = await a.waitFor(
      (frame) => frame.method === 'thread/started' && (frame.params as any).thread.id === other.id,
    )
    assert.equal((claudeStarted.params as any).thread.projectId, app.id)
    for (const threadId of [born.id, other.id]) {
      const { answered, started } = order(a, threadId)
      assert.ok(answered >= 0 && started > answered, `${threadId} 的通知排到了应答前面`)
    }
    // 别的连接各自从引擎收到会话开始的通知，可能比设备层记下归属来得早：有一条归属通知补上
    await settle()
    for (const client of [a, b])
      assert.deepEqual(got(client, 'thread/project/updated'), [
        { threadId: born.id, projectId: app.id },
        { threadId: other.id, projectId: app.id },
      ])
    assert.equal(got(b, 'thread/started').length, 2)

    // 工作区不存在：失败，引擎没有收到新建
    const before = pi.seen.length
    assert.deepEqual(await a.fails('thread/start', { harness: 'pi', projectId: 'nope' }), {
      code: -32602,
      message: '未知项目',
    })
    assert.equal(pi.seen.length, before)
    // 不带工作区的照旧：不归属，也不扣通知；给 null 一样，而且不带给引擎
    const loose = (await a.call('thread/start', { harness: 'pi', projectId: null })).thread
    assert.equal(loose.projectId, null)
    assert.deepEqual(pi.seen.at(-1)?.params, {})

    // 分叉出来的跟着原会话
    const fork = (await a.call('thread/fork', { threadId: born.id })).thread
    assert.deepEqual([fork.projectId, fork.harness], [app.id, 'pi'])
    assert.equal((await a.call('thread/fork', { threadId: loose.id })).thread.projectId, null)
    // 临时会话也能落进工作区，但只活在这次运行里
    const temp = (
      await a.call('thread/start', { harness: 'pi', projectId: app.id, ephemeral: true })
    ).thread
    assert.equal(temp.projectId, app.id)
    await a.call('thread/metadata/update', { threadId: born.id, isPinned: true })
    const members = async (client: TestClient) =>
      (await client.call('thread/list', { projectId: app.id })).data
        .map((thread: any) => thread.id)
        .sort()
    assert.deepEqual(await members(a), [born.id, fork.id, other.id].sort())

    // 设备进程重启：库里的都还在，临时会话的归属没有了
    await first.device.close()
    second = rig(upstreams, {}, { stateDir: first.stateDir })
    const c = second.connect()
    await c.initialize(BOTH)
    assert.deepEqual(
      (await c.call('project/list', {})).data.map((project: any) => [project.id, project.name]),
      [[app.id, '应用']],
    )
    assert.deepEqual(await members(c), [born.id, fork.id, other.id].sort())
    const again = (await c.call('thread/read', { threadId: born.id, includeTurns: false })).thread
    assert.deepEqual([again.projectId, again.section?.id], [app.id, PINNED])
    assert.equal(
      (await c.call('thread/read', { threadId: temp.id, includeTurns: false })).thread.projectId,
      null,
    )
  } finally {
    await (second ?? first).close()
  }
})

test('带工作区的新建迟迟没有应答：扣着的会话开始通知到点放出去，不一直扣着；迟到的应答照样把归属补上', async () => {
  const pi = new FakeUpstream('pi')
  // 引擎收下了新建、发了会话开始的通知，就是不回应答。late 让它把迟到的应答补回来
  let late: (() => void) | null = null
  let created = 0
  pi.handlers['thread/start'] = (_params, connection) => {
    const id = pi.seen.at(-1)?.id
    const thread = { id: `slow-${++created}`, updatedAt: 9100, cwd: '/w' }
    pi.threads.push(thread)
    connection.send({
      method: 'thread/started',
      params: { threadId: thread.id, thread: { ...thread } },
    })
    late = () =>
      connection.send({ id, result: { thread: { ...thread, turns: [] }, model: 'fake' } })
    return undefined
  }
  const logs: string[] = []
  const setup = rig({ pi }, { startedHoldMs: 200 }, { log: (line) => logs.push(line) })
  const released = () => logs.filter((line) => line.includes('会话开始通知先放出去'))
  try {
    const a = setup.connect()
    await a.initialize(BOTH)
    const app = (await a.call('project/create', { name: '应用', roots: [], idempotencyKey: 'k' }))
      .project
    const pending = a.call('thread/start', { harness: 'pi', projectId: app.id, cwd: '/w' })
    await settle(60)
    // 这段工夫里这个上游上别的会话开始的通知也扣着：应答没到，分不出哪一条是自己的
    pi.notify('thread/started', { threadId: 'other', thread: { id: 'other', updatedAt: 9200 } })
    await settle(40)
    assert.deepEqual(got(a, 'thread/started'), [], '应答没到，期限也没到：先扣着')

    // 期限到了：两条都放出来，按到的先后；归属这时候还不知道
    await a.waitFor(
      (frame) => frame.method === 'thread/started' && (frame.params as any).thread.id === 'other',
      2000,
    )
    assert.deepEqual(
      got(a, 'thread/started').map((params) => [
        params.thread.id,
        params.thread.projectId,
        params.thread.harness,
      ]),
      [
        ['slow-1', null, 'pi'],
        ['other', null, 'pi'],
      ],
    )
    // 放掉之后不再扣：那个新建还悬着，后面来的通知直接过
    pi.notify('thread/started', { threadId: 'third', thread: { id: 'third', updatedAt: 9300 } })
    await a.waitFor(
      (frame) => frame.method === 'thread/started' && (frame.params as any).thread.id === 'third',
      1000,
    )
    assert.deepEqual(got(a, 'thread/project/updated'), [])

    // 应答迟到了：照样回给客户端，带着工作区；先放出去的那条通知上归属是空的，靠归属通知补上
    ;(late as unknown as () => void)()
    const born = (await pending).thread
    assert.deepEqual([born.id, born.projectId, born.harness], ['slow-1', app.id, 'pi'])
    await settle()
    assert.deepEqual(got(a, 'thread/project/updated'), [{ threadId: 'slow-1', projectId: app.id }])
    assert.deepEqual(
      (await a.call('thread/list', { projectId: app.id })).data.map((thread: any) => thread.id),
      ['slow-1'],
    )
    assert.equal(got(a, 'thread/started').length, 3, '没有哪一条通知发了两遍')
    assert.equal(released().length, 1, '日志里记了一笔')

    // 扣着的时候连接关了：计时撤掉，到点不会再往一条关掉的连接上放
    const b = setup.connect()
    await b.initialize(BOTH)
    void b.call('thread/start', { harness: 'pi', projectId: app.id }).catch(() => {})
    await settle(60)
    b.close()
    await settle(300)
    assert.equal(released().length, 1)
  } finally {
    await setup.close()
  }
})

test('会话归档、删除、harness 不在：归档和不在的归属留着，删了的一起清掉；引擎自己的项目通知不上聚合面', async () => {
  const pi = new FakeUpstream('pi', [
    { id: 'p1', updatedAt: 500 },
    { id: 'p2', updatedAt: 300 },
  ])
  const claude = new FakeUpstream('claude-code', [{ id: 'c1', updatedAt: 400 }])
  const env = rig({ pi, 'claude-code': claude })
  try {
    const a = env.connect()
    await a.initialize(BOTH)
    const app = (await a.call('project/create', { name: '应用', roots: [], idempotencyKey: 'k' }))
      .project
    for (const threadId of ['p1', 'p2', 'c1'])
      await a.call('thread/metadata/update', { threadId, projectId: app.id })
    await a.call('thread/metadata/update', { threadId: 'p1', isPinned: true })
    const recency = async () =>
      (await a.call('project/read', { projectId: app.id })).project.recencyAt
    const members = async (more: Record<string, unknown> = {}) =>
      (await a.call('thread/list', { projectId: app.id, ...more })).data.map(
        (thread: any) => thread.id,
      )
    assert.equal(await recency(), 500)

    // 归档：归属和置顶留着（恢复之后回到原处），工作区的最近活动时间不算它
    await a.call('thread/archive', { threadId: 'p1' })
    assert.equal(await recency(), 400)
    assert.deepEqual(await members(), ['c1', 'p2'])
    const shelved = (await a.call('thread/list', { projectId: app.id, archived: true })).data
    assert.deepEqual(
      shelved.map((thread: any) => [thread.id, thread.projectId, thread.section?.id]),
      [['p1', app.id, PINNED]],
    )
    const back = (await a.call('thread/unarchive', { threadId: 'p1' })).thread
    assert.deepEqual([back.projectId, back.section?.id], [app.id, PINNED])
    assert.equal(await recency(), 500)
    // 在别处归档、恢复的：引擎的通知到了，设备层跟着记
    pi.notify('thread/archived', { threadId: 'p1' })
    await a.waitFor((frame) => frame.method === 'thread/archived')
    assert.equal(await recency(), 400)
    pi.notify('thread/unarchived', { threadId: 'p1' })
    await a.waitFor((frame) => frame.method === 'thread/unarchived')
    assert.equal(await recency(), 500)

    // harness 不在了（崩了、被停用）：归属留着，它回来之后会话还在原来的工作区里
    claude.crash()
    await a.waitFor(
      (frame) =>
        frame.method === STATUS &&
        (frame.params as any).harness === 'claude-code' &&
        (frame.params as any).info.available === false,
    )
    assert.deepEqual(await members(), ['p1', 'p2'])
    const old = new Set(a.notifications)
    claude.down = false
    await a.waitFor(
      (frame) =>
        !old.has(frame) &&
        frame.method === STATUS &&
        (frame.params as any).harness === 'claude-code' &&
        (frame.params as any).info.available === true,
    )
    assert.deepEqual(await members(), ['p1', 'c1', 'p2'])

    // 删除：归属、置顶一起清掉，库里不留
    assert.deepEqual(await a.call('thread/delete', { threadId: 'p1' }), {})
    assert.deepEqual(await members(), ['c1', 'p2'])
    assert.deepEqual((await a.call('thread/list', { isPinned: true })).data, [])
    assert.equal(await recency(), 400)
    // 在别处删的：引擎的通知到了，一样清掉
    claude.threads = []
    claude.notify('thread/deleted', { threadId: 'c1' })
    await a.waitFor((frame) => frame.method === 'thread/deleted')
    assert.deepEqual(await members(), ['p2'])
    assert.equal(await recency(), 300)
    const db = new DatabaseSync(join(env.stateDir, 'device.sqlite'), { readOnly: true })
    try {
      const column = (sql: string) =>
        db
          .prepare(sql)
          .all()
          .map((row) => Object.values(row)[0])
      assert.deepEqual(column('SELECT id FROM threads ORDER BY id'), ['p2'])
      assert.deepEqual(column('SELECT thread_id FROM project_threads'), ['p2'])
      assert.deepEqual(column('SELECT thread_id FROM thread_sections'), [])
    } finally {
      db.close()
    }
    // 删没成（引擎回了错误）的不清
    pi.handlers['thread/delete'] = () => {
      throw Object.assign(new Error('现在删不了'), { code: -32000 })
    }
    assert.equal((await a.fails('thread/delete', { threadId: 'p2' })).message, '现在删不了')
    assert.deepEqual(await members(), ['p2'])

    // 引擎自己那一份项目存储的通知（官方桌面端在它的入口上改项目时发的）不上聚合面
    pi.notify('project/changed', { projectId: 'engine-own', changeType: 'created' })
    pi.notify('thread/project/updated', { threadId: 'p2', projectId: 'engine-own' })
    pi.notify('skills/changed')
    await a.waitFor((frame) => frame.method === 'skills/changed')
    assert.deepEqual(got(a, 'project/changed'), [{ projectId: app.id, changeType: 'created' }])
    assert.ok(!got(a, 'thread/project/updated').some((update) => update.projectId === 'engine-own'))
  } finally {
    await env.close()
  }
})
