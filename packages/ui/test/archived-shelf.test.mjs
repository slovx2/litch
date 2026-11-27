// 已归档对话页不靠浏览器的那部分：筛选、日期分组、默认看哪台设备。跑法：npm run test --prefix packages/ui。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from '../../../node_modules/esbuild/lib/main.js'

const saved = new Map()
globalThis.localStorage = {
  getItem: (key) => saved.get(key) ?? null,
  setItem: (key, value) => void saved.set(key, value),
}

const root = new URL('../../..', import.meta.url).pathname
const bundled = await build({
  entryPoints: [`${root}packages/ui/src/archived/shelf.ts`],
  alias: { '@litch/core': `${root}packages/core/src/index.mts` },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const shelf = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime()
const row = (id, title, project, updatedAt) => ({
  session: { id, updatedAt },
  title,
  project,
})

test('按标题或项目名筛，忽略大小写与全半角，结果按时间倒序', () => {
  const rows = [
    row('a', 'Fix Sidebar', 'litch', 1),
    row('b', '整理发布说明', 'docs-site', 3),
    row('c', '排查日志', null, 2),
    row('d', 'ＳＩＤＥＢＡＲ 拖拽', 'infra', 4),
  ]
  assert.deepEqual(
    shelf.matchShelf(rows, 'sidebar').map((r) => r.session.id),
    ['d', 'a'],
  )
  assert.deepEqual(
    shelf.matchShelf(rows, 'DOCS').map((r) => r.session.id),
    ['b'],
  )
  // 不属于项目的不拿“无项目”的文案去匹配
  assert.deepEqual(
    shelf.matchShelf(rows, '  ').map((r) => r.session.id),
    ['d', 'b', 'c', 'a'],
  )
  assert.deepEqual(shelf.matchShelf(rows, 'nothing'), [])
})

test('按自然日分组：今天、昨天、7 天内、30 天内，再早按月', () => {
  const now = at(2026, 11, 27, 9)
  const rows = [
    row('t', 'a', null, at(2026, 11, 27, 1)),
    row('y', 'b', null, at(2026, 11, 26, 23)),
    row('w', 'c', null, at(2026, 11, 21)),
    row('m', 'd', null, at(2026, 11, 2)),
    row('o1', 'e', null, at(2026, 10, 20)),
    row('o2', 'f', null, at(2026, 10, 3)),
    row('s', 'g', null, at(2026, 9, 30)),
  ]
  const groups = shelf.groupShelf(rows, now)
  assert.deepEqual(
    groups.map((g) => [g.key, g.rows.map((r) => r.session.id)]),
    [
      ['today', ['t']],
      ['yesterday', ['y']],
      ['week', ['w']],
      ['month', ['m']],
      ['2026-10', ['o1', 'o2']],
      ['2026-9', ['s']],
    ],
  )
  // 时钟没对齐、落在将来的按今天算
  assert.deepEqual(shelf.bucketOf(now + 3_600_000 * 30, now), { kind: 'today' })
})

test('默认设备：先上次选的，再当前对话所在的，都不在了取第一台；选过的记下来', () => {
  const ids = ['local', 'build', 'nas']
  assert.equal(shelf.pickShelfDevice(ids, 'nas', 'build'), 'nas')
  assert.equal(shelf.pickShelfDevice(ids, 'gone', 'build'), 'build')
  assert.equal(shelf.pickShelfDevice(ids, null, null), 'local')
  assert.equal(shelf.pickShelfDevice([], 'nas', 'build'), null)
  assert.equal(shelf.rememberedShelfDevice(), null)
  shelf.rememberShelfDevice('build')
  assert.equal(shelf.rememberedShelfDevice(), 'build')
})
