// 整理侧栏：设备级的工作区、会话的归属、置顶和自定义分区。
// 对着假的聚合面跑（fake-device.mts，声明了 deviceWorkspaces），不连任何真的东西。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PINNED_SECTION_ID } from '../../protocol/src/index.mjs'
import type { ChannelError } from '../src/index.mjs'
import { deviceWorld } from './device-world.mjs'
import { type FakeDevice, type FakeHarness, harness } from './fake-device.mjs'
import { project, thread } from './fixtures.mjs'
import { settle } from './helpers.mjs'

const DOWN = { kind: 'unreachable', message: '连不上这个运行时' }

/** 两个 harness；p1、c1 的工作目录在 app 这个工作区下面，c2 哪儿都不在 */
const pair = (): FakeHarness[] => [
  harness('pi', {
    displayName: 'Pi',
    threads: [
      thread({ id: 'p1', cwd: '/work/app', updatedAt: 1_700_000_400 }),
      thread({ id: 'p2', cwd: '/scratch/notes', updatedAt: 1_700_000_300 }),
    ],
  }),
  harness('cc', {
    displayName: 'Claude Code',
    threads: [
      thread({ id: 'c1', cwd: '/work/app/web', updatedAt: 1_700_000_200 }),
      thread({ id: 'c2', cwd: '/scratch/tmp', updatedAt: 1_700_000_100 }),
    ],
  }),
]

/** 声明了设备级工作区的设备，上面已经有两个工作区 */
const organized = (device: FakeDevice) => {
  device.extensions = ['harness', 'deviceWorkspaces']
  device.projects = [
    { ...project('app', 'app', '/work/app', 0), metadata: { 'litch.color': 'blue' } },
    project('docs', 'docs', '/work/docs', 1),
  ]
}

const setup = (prepare: (device: FakeDevice) => void = organized) =>
  deviceWorld(pair(), { prepare })

async function failureOf(run: Promise<unknown>): Promise<ChannelError> {
  try {
    await run
  } catch (error) {
    return error as ChannelError
  }
  throw new Error('这条命令本该失败')
}

test('握手时声明了设备级的工作区：声明了才收得到置顶和分区变化的通知', async () => {
  const { core, peer } = setup()
  core.start()
  await settle()
  const hello = peer.last().seen.find((entry) => entry.method === 'initialize')?.params as {
    capabilities: { litchExtensions: string[] }
  }
  assert.ok(hello.capabilities.litchExtensions.includes('deviceWorkspaces'))
})

test('完整模式：设备声明了设备级的工作区就去取；会话带着归属、置顶、分区；设备标成能整理', async () => {
  const { core, side, device, sent } = setup((fake) => {
    organized(fake)
    // 设备层记着的：c2 归在 docs，p2 置顶了，c1 在一个自定义分区里
    fake.assigned.set('c2', 'docs')
    fake.placed.set('p2', { id: PINNED_SECTION_ID, name: 'Pinned', at: 1_700_000_050 })
    fake.placed.set('c1', { id: 'sec-1', name: '稍后看', at: 1_700_000_060 })
  })
  assert.equal(device()?.organizable, false, '没连上之前不能整理')
  core.start()
  await settle()
  assert.equal(sent('project/list').length, 1)
  assert.equal(device()?.organizable, true)
  assert.deepEqual(side.workspaces, [
    { id: 'app', name: 'app', roots: ['/work/app'], color: 'blue', pinned: false, sectionId: null },
    {
      id: 'docs',
      name: 'docs',
      roots: ['/work/docs'],
      color: null,
      pinned: false,
      sectionId: null,
    },
  ])
  assert.deepEqual(
    [...side.sessions.values()]
      .map((entry) => [entry.id, entry.workspaceId, entry.pinned, entry.section, entry.placedAt])
      .sort(),
    [
      // 分区是分区，归属是归属：在分区里的会话照样算得出它属于哪个工作区
      ['c1', 'app', false, { id: 'sec-1', name: '稍后看' }, 1_700_000_060_000],
      // 记了归属的用记的，不看工作目录
      ['c2', 'docs', false, null, null],
      ['p1', 'app', false, null, null],
      ['p2', null, true, null, 1_700_000_050_000],
    ],
  )
})

test('工作区：添加、改名、换颜色、调顺序、删除；每次做完侧栏整份换过', async () => {
  const { core, side, command, sent } = setup()
  core.start()
  await settle()
  const names = () => side.workspaces.map((entry) => entry.name)

  // 添加：名字和目录都要合规矩，不合的不发
  const noName = await failureOf(command('workspace.create', { name: '  ', root: '/work/x' }))
  assert.deepEqual([noName.code, noName.text], ['rejected', { key: 'fault.workspaceName' }])
  const noRoot = await failureOf(command('workspace.create', { name: 'x', root: '~/work/x' }))
  assert.deepEqual([noRoot.code, noRoot.text], ['rejected', { key: 'fault.workspaceRoot' }])
  assert.equal(sent('project/create').length, 0)

  let before = side.snapshots
  const created = (await command('workspace.create', {
    name: ' infra ',
    root: '/scratch',
    color: 'orange',
  })) as { workspaceId: string }
  const [asked] = sent('project/create')
  assert.deepEqual(
    [asked?.name, asked?.roots, asked?.metadata],
    ['infra', [{ path: '/scratch' }], { 'litch.color': 'orange' }],
  )
  assert.equal(typeof asked?.idempotencyKey, 'string')
  assert.ok(side.snapshots > before, '侧栏整份换过')
  assert.deepEqual(names(), ['app', 'docs', 'infra'])
  assert.equal(side.workspaces.at(-1)?.color, 'orange')
  // 工作目录在新工作区下面的会话跟着归进去：归属是按整张表算的
  assert.equal(side.sessions.get('p2')?.workspaceId, created.workspaceId)
  assert.equal(side.sessions.get('c2')?.workspaceId, created.workspaceId)

  // 改名：只发名字，metadata 不碰
  await command('workspace.update', { workspaceId: 'docs', name: '文档站' })
  assert.deepEqual(sent('project/update').at(-1), { projectId: 'docs', name: '文档站' })
  assert.deepEqual(names(), ['app', '文档站', 'infra'])

  // 换颜色：只发 metadata，名字不碰；给 null 是去掉
  await command('workspace.update', { workspaceId: 'docs', color: 'violet' })
  assert.equal(side.workspaces.find((entry) => entry.id === 'docs')?.color, 'violet')
  assert.deepEqual(sent('project/update').at(-1), {
    projectId: 'docs',
    metadata: { 'litch.color': 'violet' },
  })
  await command('workspace.update', { workspaceId: 'docs', color: null })
  assert.deepEqual(sent('project/update').at(-1), { projectId: 'docs', metadata: {} })
  assert.equal(side.workspaces.find((entry) => entry.id === 'docs')?.color, null)
  await assert.rejects(command('workspace.update', { workspaceId: 'docs', color: 'pink' }), {
    code: 'rejected',
  })

  // 调顺序
  await command('workspace.move', { workspaceId: created.workspaceId, before: 'app' })
  assert.deepEqual(sent('project/move').at(-1), {
    projectId: created.workspaceId,
    beforeProjectId: 'app',
  })
  assert.deepEqual(names(), ['infra', 'app', '文档站'])
  await command('workspace.move', { workspaceId: created.workspaceId, before: null })
  assert.deepEqual(names(), ['app', '文档站', 'infra'])

  // 删除：只删这条记录，里面的会话回到“没有工作区”
  before = side.snapshots
  await command('workspace.delete', { workspaceId: created.workspaceId })
  assert.deepEqual(sent('project/delete'), [{ projectId: created.workspaceId }])
  assert.deepEqual(names(), ['app', '文档站'])
  assert.ok(side.snapshots > before)
  assert.equal(side.sessions.get('p2')?.workspaceId, null)
  assert.equal(side.sessions.size, 4, '会话一个都没少')

  // 已经不在了的工作区：说得出是哪一句
  const gone = await failureOf(command('workspace.update', { workspaceId: 'nope', name: 'x' }))
  assert.deepEqual([gone.code, gone.text], ['notFound', { key: 'fault.workspaceGone' }])
})

test('换颜色时带着原来的别的键：metadata 在协议里是整份替换，不能把别人放的东西冲掉', async () => {
  const { core, command, sent } = setup((fake) => {
    organized(fake)
    const docs = fake.projects.find((entry) => entry.id === 'docs')
    if (docs) docs.metadata = { 'litch.import.sources': 'codex' }
  })
  core.start()
  await settle()
  await command('workspace.update', { workspaceId: 'docs', color: 'red' })
  assert.deepEqual(sent('project/update'), [
    { projectId: 'docs', metadata: { 'litch.import.sources': 'codex', 'litch.color': 'red' } },
  ])
})

test('会话：移到另一个工作区、置顶、取消置顶；做完这边自己先改，不等通知', async () => {
  const { core, side, command, sent, set } = setup()
  core.start()
  await settle()
  assert.equal(side.sessions.get('p1')?.workspaceId, 'app')

  await command('session.move', { sessionId: 'p1', workspaceId: 'docs' })
  assert.deepEqual(sent('thread/metadata/update'), [{ threadId: 'p1', projectId: 'docs' }])
  assert.equal(side.sessions.get('p1')?.workspaceId, 'docs')
  assert.equal(side.sessions.get('p1')?.harness, 'pi', '还是原来那个 harness 的会话')

  await command('session.place', { sessionId: 'p1', place: 'pinned' })
  assert.deepEqual(sent('thread/section/move'), [{ threadId: 'p1', sectionId: PINNED_SECTION_ID }])
  const pinned = side.sessions.get('p1')
  assert.deepEqual([pinned?.pinned, pinned?.section], [true, null])
  assert.equal(typeof pinned?.placedAt, 'number')
  // 置顶不改归属：取消之后回到原来的工作区
  assert.equal(pinned?.workspaceId, 'docs')

  await command('session.place', { sessionId: 'p1', place: null })
  assert.deepEqual(sent('thread/section/move').at(-1), { threadId: 'p1', sectionId: null })
  const back = side.sessions.get('p1')
  assert.deepEqual([back?.pinned, back?.placedAt, back?.workspaceId], [false, null, 'docs'])

  // 它所属的 harness 不可用了：置顶是设备层的事，照样能做；归属要它认这个会话，做不了并说得出原因
  set('pi', DOWN)
  await settle()
  await command('session.place', { sessionId: 'p1', place: 'pinned' })
  assert.equal(side.sessions.get('p1')?.pinned, true)
  const stuck = await failureOf(command('session.move', { sessionId: 'p1', workspaceId: 'app' }))
  assert.deepEqual(
    [stuck.code, stuck.text],
    ['remote', { key: 'fault.harnessUnavailable', args: { name: 'Pi' } }],
  )
  assert.equal(side.sessions.get('p1')?.workspaceId, 'docs')
})

test('别处改了：工作区、归属、置顶、分区的通知到了，侧栏跟着变，不用刷新', async () => {
  const { core, side, peer, sent, fake, logs } = setup()
  core.start()
  await settle()
  const server = peer.last()
  const lists = sent('thread/list').length

  // 别的连接加了一个工作区
  fake.projects.push(project('lab', 'lab', '/scratch', 2))
  const before = side.snapshots
  server.notify('project/changed', { projectId: 'lab', changeType: 'created' })
  await settle()
  assert.deepEqual(
    side.workspaces.map((entry) => entry.name),
    ['app', 'docs', 'lab'],
  )
  assert.equal(side.snapshots, before + 1)
  assert.equal(side.sessions.get('c2')?.workspaceId, 'lab')

  // 别的连接把会话移走了
  server.notify('thread/project/updated', { threadId: 'p1', projectId: 'docs' })
  await settle()
  assert.equal(side.sessions.get('p1')?.workspaceId, 'docs')

  // 别的连接置顶、放进自定义分区、又拿出来
  const moved = (section: { id: string; name: string } | null, at: number | null) =>
    server.notify('litch/thread/section/updated', {
      threadId: 'c1',
      section: section && { ...section, appearance: null },
      sectionEnteredAt: at,
      isPinned: section?.id === PINNED_SECTION_ID,
    })
  moved({ id: PINNED_SECTION_ID, name: 'Pinned' }, 1_700_000_900)
  await settle()
  assert.deepEqual(
    [side.sessions.get('c1')?.pinned, side.sessions.get('c1')?.placedAt],
    [true, 1_700_000_900_000],
  )
  moved({ id: 'sec-9', name: '稍后看' }, 1_700_000_950)
  await settle()
  const placed = side.sessions.get('c1')
  assert.deepEqual([placed?.pinned, placed?.section], [false, { id: 'sec-9', name: '稍后看' }])
  moved(null, null)
  await settle()
  assert.deepEqual(
    [side.sessions.get('c1')?.pinned, side.sessions.get('c1')?.section],
    [false, null],
  )

  // 别的连接建了一个组：组的列表和工作区一起重新取，空的组也在
  fake.sections.push({ id: 'sec-9', name: '稍后看' })
  const sectionLists = sent('threadSection/list').length
  server.notify('litch/threadSection/changed', { sectionId: 'sec-9', changeType: 'created' })
  await settle()
  assert.ok(!logs.some((line) => line.includes('不处理的通知')))
  assert.equal(sent('threadSection/list').length, sectionLists + 1)
  assert.deepEqual(side.sections, [{ id: 'sec-9', name: '稍后看' }])
  // 这些都不引起重新取会话列表
  assert.equal(sent('thread/list').length, lists)
})

test('组：建、改名、删除；会话放进组；工作区置顶、放进组，两样只能有一样', async () => {
  const { core, side, command, sent, fake } = setup((device) => {
    organized(device)
    const docs = device.projects.find((entry) => entry.id === 'docs')
    if (docs) docs.metadata = { 'litch.import.sources': 'codex' }
  })
  core.start()
  await settle()
  assert.deepEqual(side.sections, [], '置顶那个不算组')

  const noName = await failureOf(command('section.create', { name: ' ' }))
  assert.deepEqual([noName.code, noName.text], ['rejected', { key: 'fault.sectionName' }])
  const { sectionId } = (await command('section.create', { name: ' 稍后看 ' })) as {
    sectionId: string
  }
  assert.deepEqual(sent('threadSection/create'), [{ name: '稍后看' }])
  assert.deepEqual(side.sections, [{ id: sectionId, name: '稍后看' }], '建好是空的，也在列表里')

  // 会话放进组：这边先改，名字取这边知道的
  await command('session.place', { sessionId: 'c1', place: { sectionId } })
  assert.deepEqual(sent('thread/section/move').at(-1), { threadId: 'c1', sectionId })
  const placed = side.sessions.get('c1')
  assert.deepEqual([placed?.pinned, placed?.section], [false, { id: sectionId, name: '稍后看' }])

  // 工作区置顶，再放进组：放进组就取消置顶；metadata 带着原来的别的键
  await command('workspace.update', { workspaceId: 'docs', pinned: true })
  assert.deepEqual(sent('project/update').at(-1), {
    projectId: 'docs',
    metadata: { 'litch.import.sources': 'codex', 'litch.pinned': '1' },
  })
  assert.deepEqual(
    side.workspaces.map((entry) => [entry.id, entry.pinned, entry.sectionId]),
    [
      ['app', false, null],
      ['docs', true, null],
    ],
  )
  await command('workspace.update', { workspaceId: 'docs', sectionId })
  assert.deepEqual(sent('project/update').at(-1), {
    projectId: 'docs',
    metadata: { 'litch.import.sources': 'codex', 'litch.section': sectionId },
  })
  assert.deepEqual(
    side.workspaces.find((entry) => entry.id === 'docs'),
    { id: 'docs', name: 'docs', roots: ['/work/docs'], color: null, pinned: false, sectionId },
  )

  await command('section.rename', { sectionId, name: '以后再说' })
  assert.deepEqual(sent('threadSection/update'), [{ sectionId, name: '以后再说' }])
  assert.deepEqual(side.sections, [{ id: sectionId, name: '以后再说' }])

  // 删组：里面的会话由设备放出来；工作区上记着的组不去改，组不在了就当没放
  await command('section.delete', { sectionId })
  assert.deepEqual(sent('threadSection/delete'), [{ sectionId }])
  assert.deepEqual(side.sections, [])
  assert.equal(side.workspaces.find((entry) => entry.id === 'docs')?.sectionId, null)
  assert.equal(
    fake.projects.find((entry) => entry.id === 'docs')?.metadata['litch.section'],
    sectionId,
  )
})

test('自己改完要取、通知到了也要取：前后脚的两次合成一趟，取到的是改动之后的', async () => {
  const { core, side, peer, command, sent } = setup()
  core.start()
  await settle()
  const before = sent('project/list').length
  const done = command('workspace.create', { name: 'lab', root: '/scratch' })
  // 对面的通知和应答前后脚到
  peer.last().notify('project/changed', { projectId: 'x', changeType: 'created' })
  await done
  await settle()
  assert.ok(side.workspaces.some((entry) => entry.name === 'lab'))
  assert.ok(sent('project/list').length - before <= 2, '不为同一件事反复去取')
})

test('新建会话带着工作区：对面有这组方法、这个工作区也还在才带', async () => {
  const { core, side, command, sent } = setup()
  core.start()
  await settle()
  const create = (workspaceId?: string) =>
    command('session.create', {
      harness: 'cc',
      cwd: '/elsewhere',
      text: '你好',
      ...(workspaceId ? { workspaceId } : {}),
    }) as Promise<{ sessionId: string }>

  const first = await create('docs')
  assert.equal(sent('thread/start').at(-1)?.projectId, 'docs')
  // 工作目录不在这个工作区下面，照样归在选的那个里
  assert.equal(side.sessions.get(first.sessionId)?.workspaceId, 'docs')

  await create()
  assert.ok(!('projectId' in (sent('thread/start').at(-1) ?? {})), '没说的不带')
  await create('nope')
  assert.ok(!('projectId' in (sent('thread/start').at(-1) ?? {})), '已经不在了的不带')

  // 没声明设备级工作区的设备：不带，整理的命令报“不支持”
  const bare = setup(() => {})
  bare.core.start()
  await settle()
  await bare.command('session.create', { harness: 'cc', cwd: null, text: '你好', workspaceId: 'x' })
  assert.ok(!('projectId' in (bare.sent('thread/start').at(-1) ?? {})))
  for (const [name, params] of [
    ['workspace.create', { name: 'x', root: '/x' }],
    ['session.place', { sessionId: 'p1', place: 'pinned' }],
    ['session.move', { sessionId: 'p1', workspaceId: 'x' }],
  ] as const) {
    const refused = await failureOf(bare.command(name, params))
    assert.deepEqual(
      [refused.code, refused.text],
      ['unsupported', { key: 'fault.organizeUnsupported' }],
      name,
    )
  }
  assert.equal(bare.sent('project/create').length, 0)
})

test('加工作区时的候选目录：没归进任何工作区的会话的工作目录，最近用过的在前，不重复', async () => {
  const { core, command, fake } = setup((device) => {
    organized(device)
    const cc = device.harnesses.find((entry) => entry.id === 'cc')
    cc?.threads.push(thread({ id: 'c3', cwd: '/scratch/notes', updatedAt: 1_700_000_900 }))
    cc?.threads.push(thread({ id: 'c4', cwd: '', updatedAt: 1_700_000_950 }))
  })
  core.start()
  await settle()
  assert.equal(fake.harnesses.length, 2)
  assert.deepEqual(await command('workspace.candidates', {}), {
    roots: ['/scratch/notes', '/scratch/tmp'],
  })
})

test('没连上的时候整理不了：说是没连上，不是“不支持”', async () => {
  const { command } = setup()
  await assert.rejects(command('workspace.create', { name: 'x', root: '/x' }), {
    code: 'offline',
  })
  await assert.rejects(command('session.place', { sessionId: 'p1', place: 'pinned' }), {
    code: 'offline',
  })
})
