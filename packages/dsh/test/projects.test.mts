import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { DshServer } from '../src/server.mjs'
import { client, isolate, violations } from './client.mjs'

// dsh 入口上的项目（project/*）和会话归属。项目存在适配器的库里，会话在 dsh 自己手里：
// 共用的项目存储要问“会话在不在、最近什么时候动过”，由入口去问 dsh（server.mts 的 sessions）。
// 此前它直接查库里的 threads 表，dsh 的库里没有这张表，project/list、project/create 一调就是内部错误。

const text = (value: string) => [{ type: 'text', text: value }]

test('dsh：项目能建、能列、能改、能排、能删；会话归属与最近活动时间按 dsh 现有的会话算，重启后照旧', {
  timeout: 180000,
}, async () => {
  const env = await isolate((body) =>
    body.tools?.length
      ? [{ type: 'text', chunks: ['好的。'] }]
      : [{ type: 'text', chunks: ['项目里的会话'] }],
  )
  const home = join(env.root, 'home')
  let server = new DshServer(home)
  try {
    const desktop = client(server)
    await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })

    // 一个项目都没有时列得出来，是空的
    assert.deepEqual(await desktop.call('project/list', { limit: 100 }), {
      data: [],
      nextCursor: null,
    })
    const fields = { idempotencyKey: 'dsh-project', name: '项目甲', roots: [{ path: env.cwd }] }
    const { project } = await desktop.call('project/create', fields)
    assert.equal(project.name, '项目甲')
    assert.deepEqual(project.roots, [{ path: env.cwd }])
    assert.equal(project.recencyAt, null, '还没有会话，没有最近活动时间')
    assert.deepEqual((await desktop.until('project/changed')).changeType, 'created')
    // 幂等键相同：还是那一个
    assert.equal((await desktop.call('project/create', fields)).project.id, project.id)
    assert.equal((await desktop.call('project/list', {})).data.length, 1)

    // 带着不存在的项目新建会话：拒绝，而且不在 dsh 里留下会话（它没有删除会话的接口）
    await assert.rejects(
      desktop.call('thread/start', {
        cwd: env.cwd,
        permissions: ':workspace',
        projectId: '没有的',
      }),
      (error: any) => error.code === -32602,
    )
    assert.deepEqual(await server.sessions(), [])

    // 新建会话时带着项目；另一个会话建好之后再放进去
    const born = await desktop.call('thread/start', {
      cwd: env.cwd,
      permissions: ':workspace',
      projectId: project.id,
    })
    assert.equal(born.thread.projectId, project.id)
    const later = await desktop.call('thread/start', { cwd: env.cwd, permissions: ':workspace' })
    assert.equal(later.thread.projectId, null)
    const moved = await desktop.call('thread/metadata/update', {
      threadId: later.thread.id,
      projectId: project.id,
    })
    assert.equal(moved.thread.projectId, project.id)
    assert.deepEqual(
      await desktop.until('thread/project/updated', (params) => params.projectId === project.id),
      { threadId: later.thread.id, projectId: project.id },
    )
    await assert.rejects(
      desktop.call('thread/metadata/update', { threadId: later.thread.id, projectId: '没有的' }),
      (error: any) => error.code === -32602,
    )

    // 说过话的会话才进列表：在其中一个里跑一轮，按项目筛出来的就是它
    const { turn } = await desktop.call('turn/start', {
      threadId: born.thread.id,
      input: text('说一句话。'),
    })
    await desktop.until('turn/completed', (params) => params.turn.id === turn.id)
    const inProject = await desktop.call('thread/list', { projectId: project.id, limit: 50 })
    assert.deepEqual(
      inProject.data.map((thread: any) => thread.id),
      [born.thread.id],
    )
    // 项目的最近活动时间就是成员会话里最新的更新时间，和会话对象上报的是同一个数。
    // 前后各读一遍会话把它夹住：回合结束之后 dsh 还会给会话起标题，更新时间可能正好在变
    const newest = async () => {
      const members = [born.thread.id, later.thread.id].map((threadId) =>
        desktop.call('thread/read', { threadId, includeTurns: false }),
      )
      return Math.max(...(await Promise.all(members)).map((reply) => reply.thread.updatedAt))
    }
    const low = await newest()
    const read = await desktop.call('project/read', { projectId: project.id })
    assert.ok(low <= read.project.recencyAt && read.project.recencyAt <= (await newest()))

    // 导入：会话要是 dsh 真有的
    await assert.rejects(
      desktop.call('project/import', {
        idempotencyKey: 'dsh-import-unknown',
        name: '导入',
        roots: [],
        threads: ['没有这个会话'],
      }),
      (error: any) => error.code === -32602,
    )
    const imported = await desktop.call('project/import', {
      idempotencyKey: 'dsh-import',
      name: '导入',
      roots: [],
      threads: [later.thread.id],
    })
    assert.equal(
      (await desktop.call('thread/read', { threadId: later.thread.id })).thread.projectId,
      imported.project.id,
    )

    // 归档了的不算最近活动：项目甲只剩归档的那个会话
    await desktop.call('thread/archive', { threadId: born.thread.id })
    assert.equal(
      (await desktop.call('project/read', { projectId: project.id })).project.recencyAt,
      null,
    )
    await desktop.call('thread/unarchive', { threadId: born.thread.id })

    // 适配器重启：会话都没打开，最近活动时间按向 dsh 问来的算，还是和会话列表里报的同一个数
    await server.close()
    server = new DshServer(home)
    const again = client(server)
    await again.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const unloaded = async (): Promise<number> =>
      (await again.call('thread/list', { limit: 50 })).data.find(
        (thread: any) => thread.id === born.thread.id,
      ).updatedAt
    const floor = await unloaded()
    const listed = await again.call('project/list', { limit: 100 })
    assert.deepEqual(
      listed.data.map((entry: any) => entry.name),
      ['项目甲', '导入'],
    )
    assert.ok(floor <= listed.data[0].recencyAt && listed.data[0].recencyAt <= (await unloaded()))
    // 另一个项目里是那个还没说过话的会话：会话列表不列它，最近活动时间照样有
    assert.equal(typeof listed.data[1].recencyAt, 'number')

    // 重排：把后建的挪到前面
    assert.deepEqual(
      await again.call('project/move', {
        projectId: listed.data[1].id,
        beforeProjectId: project.id,
      }),
      {},
    )
    assert.deepEqual(
      (await again.call('project/list', {})).data.map((entry: any) => entry.name),
      ['导入', '项目甲'],
    )

    // 改名、删除；删了项目，里面的会话只是解除归属
    const renamed = await again.call('project/update', { projectId: project.id, name: '项目乙' })
    assert.equal(renamed.project.name, '项目乙')
    assert.deepEqual(await again.call('project/delete', { projectId: project.id }), {})
    assert.equal(
      (await again.call('thread/read', { threadId: born.thread.id })).thread.projectId,
      null,
    )
    assert.equal((await again.call('project/list', {})).data.length, 1)
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await server.close()
    await env.restore()
  }
})
