// 界面这一侧的文件树（packages/core/src/replica/file-trees.mts）：经真的通道对着模拟核心。
// 看的是摊平出来的行，和“向对面要过几次”：每展开一层只要一次，收起再展开不重复要。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  type FileRow,
  type FileTreeState,
  keys,
  serveChannel,
} from '../src/index.mjs'
import { MANY_ENTRIES } from '../src/mock/sample-files.mjs'
import { fakeClock, settle } from './helpers.mjs'

const ROOT = '~/work/litch'

async function setup(deviceId = 'local', root = ROOT) {
  const time = fakeClock()
  const [uiPort, corePort] = createPortPair()
  serveChannel(corePort, createMockCore({ clock: time.clock, chunkMs: 10 }), { clock: time.clock })
  const channel = connectChannel(uiPort)
  const replica = createReplica(channel)
  replica.start()
  /** 让对面把欠着的应答都回完：命令过通道、对面“过一会儿才回”、符号链接再问一轮，各要几拍 */
  const flush = async () => {
    for (let round = 0; round < 6; round++) {
      await settle()
      time.advance(20)
    }
    await settle()
  }
  await flush()
  const { store, files } = replica
  const rows = () => store.get<FileRow[]>(keys.fileRows(deviceId, root)) ?? []
  const state = () => store.get<FileTreeState>(keys.fileTree(deviceId, root))
  /** 行画成一串字：缩进是层级，目录后面带斜杠，展开着的带星号 */
  const shape = () =>
    rows().map((row) => {
      const name = row.name === '' ? `<${row.kind}>` : row.name
      return `${'  '.repeat(row.depth)}${name}${row.kind === 'dir' ? '/' : ''}${row.expanded ? '*' : ''}`
    })
  const asked = async () =>
    (await channel.command('files.requests', { deviceId })) as {
      lists: Record<string, number>
      reads: Record<string, number>
    }
  return { time, channel, store, files, flush, rows, state, shape, asked, deviceId, root }
}

const TOP = [
  'cmd/',
  'crates/',
  'docs/',
  'fixtures/',
  'link-to-docs/',
  'packages/',
  'scripts/',
  'AGENTS.md',
  'Makefile',
  'package.json',
  'README.md',
]

test('打开一棵树：先是“正在取”，取到之后是根那一层，目录在前、隐藏的不显示', async () => {
  const { files, flush, shape, state, asked } = await setup()
  files.open('local', ROOT)
  assert.deepEqual(shape(), ['<loading>'])
  assert.equal(state()?.phase, 'loading')
  await flush()
  assert.deepEqual(shape(), TOP)
  assert.deepEqual(state(), { phase: 'ready', error: null, refreshing: false })
  assert.deepEqual((await asked()).lists, { [ROOT]: 1 })
})

test('展开一层要一次；收起不丢，再展开先照旧显示，几秒之内不再去要', async () => {
  const { files, flush, shape, asked, store } = await setup()
  files.open('local', ROOT)
  await flush()
  files.expand('local', ROOT, `${ROOT}/docs`)
  assert.deepEqual(shape().slice(2, 5), ['docs/*', '  <loading>', 'fixtures/'])
  await flush()
  assert.deepEqual(shape().slice(2, 7), [
    'docs/*',
    '  images/',
    '  guide.md',
    '  snippet.html',
    'fixtures/',
  ])

  files.collapse('local', ROOT, `${ROOT}/docs`)
  assert.deepEqual(shape(), TOP)
  let changes = 0
  store.subscribe(keys.fileRows('local', ROOT), () => changes++)
  files.expand('local', ROOT, `${ROOT}/docs`)
  // 不等对面：上次取到的当场就在
  assert.deepEqual(shape().slice(2, 7), [
    'docs/*',
    '  images/',
    '  guide.md',
    '  snippet.html',
    'fixtures/',
  ])
  await flush()
  // 重新对了一遍，内容没变：行只在展开那一下变过一次
  assert.equal(changes, 1)
  assert.deepEqual((await asked()).lists, { [ROOT]: 1, [`${ROOT}/docs`]: 1 })
})

test('展开过的子目录跟着上一级一起回来；重复展开、展开根之外的不做事', async () => {
  const { files, flush, shape, asked } = await setup()
  files.open('local', ROOT)
  await flush()
  files.expand('local', ROOT, `${ROOT}/packages`)
  await flush()
  files.expand('local', ROOT, `${ROOT}/packages/core`)
  await flush()
  files.collapse('local', ROOT, `${ROOT}/packages`)
  files.expand('local', ROOT, `${ROOT}/packages`)
  files.expand('local', ROOT, `${ROOT}/packages`)
  files.expand('local', ROOT, '~/work/elsewhere')
  files.expand('local', ROOT, ROOT)
  await flush()
  assert.deepEqual(shape().slice(5, 10), [
    'packages/*',
    '  core/*',
    '    src/',
    '  ui/',
    'scripts/',
  ])
  const { lists } = await asked()
  assert.deepEqual(Object.keys(lists).sort(), [ROOT, `${ROOT}/packages`, `${ROOT}/packages/core`])
})

test('定位到一个文件：一路把上面的目录展开，每层要一次；路径上有不存在的目录就是没定位到', async () => {
  const { files, flush, shape, asked } = await setup()
  files.open('local', ROOT)
  await flush()
  const target = `${ROOT}/packages/core/src/device/files.mts`
  const revealed = files.reveal('local', ROOT, target)
  await flush()
  await flush()
  assert.equal(await revealed, true)
  assert.deepEqual(shape().slice(5, 12), [
    'packages/*',
    '  core/*',
    '    src/*',
    '      device/*',
    '        files.mts',
    '      index.mts',
    '  ui/',
  ])
  assert.deepEqual((await asked()).lists, {
    [ROOT]: 1,
    [`${ROOT}/packages`]: 1,
    [`${ROOT}/packages/core`]: 1,
    [`${ROOT}/packages/core/src`]: 1,
    [`${ROOT}/packages/core/src/device`]: 1,
  })

  const lost = files.reveal('local', ROOT, `${ROOT}/nowhere/deep/x.ts`)
  await flush()
  assert.equal(await lost, false)
  assert.equal(await files.reveal('local', ROOT, '~/work/elsewhere/x.ts'), false)
})

test('隐藏的文件：开关一开就出来，不用重新去要', async () => {
  const { files, flush, shape, store, asked } = await setup()
  files.open('local', ROOT)
  await flush()
  assert.equal(store.get(keys.filesShowHidden), false)
  files.setShowHidden(true)
  assert.equal(store.get(keys.filesShowHidden), true)
  assert.deepEqual(shape().slice(0, 3), ['.github/', 'cmd/', 'crates/'])
  assert.equal(shape().includes('.gitignore'), true)
  files.setShowHidden(false)
  assert.deepEqual(shape(), TOP)
  assert.deepEqual((await asked()).lists, { [ROOT]: 1 })
})

test('刷新：根和展开着的各层都重新要一遍，收起来的不要', async () => {
  const { files, flush, state, asked } = await setup()
  files.open('local', ROOT)
  await flush()
  files.expand('local', ROOT, `${ROOT}/docs`)
  files.expand('local', ROOT, `${ROOT}/scripts`)
  await flush()
  files.collapse('local', ROOT, `${ROOT}/scripts`)
  const done = files.refresh('local', ROOT)
  assert.equal(state()?.refreshing, true)
  await flush()
  await done
  assert.equal(state()?.refreshing, false)
  assert.deepEqual((await asked()).lists, {
    [ROOT]: 2,
    [`${ROOT}/docs`]: 2,
    [`${ROOT}/scripts`]: 1,
  })
})

test('列不了的目录：下面是一行说明，带着原因；空目录是一行“空的”', async () => {
  const { files, flush, rows } = await setup()
  files.open('local', ROOT)
  await flush()
  files.expand('local', ROOT, `${ROOT}/fixtures`)
  await flush()
  files.expand('local', ROOT, `${ROOT}/fixtures/locked`)
  files.expand('local', ROOT, `${ROOT}/fixtures/empty`)
  await flush()
  // 说明行没有名字，路径是它所属的目录
  const under = (path: string) => rows().find((row) => row.path === path && row.name === '')
  const locked = under(`${ROOT}/fixtures/locked`)
  assert.equal(locked?.kind, 'failed')
  assert.equal(locked?.note?.kind === 'failed' && locked.note.error.code, 'remote')
  assert.match(locked?.note?.kind === 'failed' ? locked.note.error.message : '', /EACCES/)
  assert.equal(under(`${ROOT}/fixtures/empty`)?.kind, 'empty')
})

test('几万个条目的目录：展开只要一次，行全都在', async () => {
  const { files, flush, rows, asked } = await setup()
  files.open('local', ROOT)
  await flush()
  files.expand('local', ROOT, `${ROOT}/fixtures`)
  await flush()
  files.expand('local', ROOT, `${ROOT}/fixtures/many`)
  await flush()
  const inside = rows().filter(
    (row) => row.depth === 2 && row.path.startsWith(`${ROOT}/fixtures/many/`),
  )
  assert.equal(inside.length, MANY_ENTRIES)
  assert.equal(inside[0]?.kind, 'dir')
  assert.equal(inside[inside.length - 1]?.kind, 'file')
  assert.equal((await asked()).lists[`${ROOT}/fixtures/many`], 1)
})

test('对面不提供文件访问、设备没连上：树停在“没取到”，原因说得出是哪一句', async () => {
  const nas = await setup('nas', '~/backup-scripts')
  nas.files.open('nas', '~/backup-scripts')
  await nas.flush()
  assert.equal(nas.state()?.phase, 'failed')
  assert.deepEqual(
    [nas.state()?.error?.code, nas.state()?.error?.text?.key],
    ['unsupported', 'files.unsupported'],
  )
  assert.deepEqual(
    nas.rows().map((row) => row.kind),
    ['failed'],
  )

  const gpu = await setup('gpu', '~/train-lab')
  gpu.files.open('gpu', '~/train-lab')
  await gpu.flush()
  assert.deepEqual([gpu.state()?.phase, gpu.state()?.error?.code], ['failed', 'offline'])
})

test('设备重新连上：正看着的树不用缓存重新对一遍；没人看的不动', async () => {
  const { files, flush, asked } = await setup()
  const close = files.open('local', ROOT)
  await flush()
  files.reconnected('local')
  await flush()
  assert.deepEqual((await asked()).lists, { [ROOT]: 2 })
  close()
  files.reconnected('local')
  await flush()
  assert.deepEqual((await asked()).lists, { [ROOT]: 2 })
})
