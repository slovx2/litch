import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from '../../../node_modules/esbuild/lib/main.js'

// 排序规则只依赖协议包的 moveRankedModel；直接打包正式实现，不经核心入口。
const bundled = await build({
  entryPoints: [new URL('../src/devices/manage/ranking-view.ts', import.meta.url).pathname],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  alias: {
    '@litch/core': new URL('../../protocol/src/model-ranking.mts', import.meta.url).pathname,
  },
})
const {
  applyDrop,
  applyRank,
  canDrop,
  canRank,
  gapsOf,
  ladderOf,
  laddersOf,
  readFailureOf,
  unrankedOf,
  writeOf,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

const model = (harness, id) => ({
  key: JSON.stringify([harness, '', id]),
  harness,
  model: id,
  name: id,
  available: true,
})
const haiku = model('claude-code', 'haiku')
const opus = model('claude-code', 'opus')
const fable = model('claude-code', 'fable')
const luna = model('codex', 'luna')
const sol = model('codex', 'sol')
const astra = model('codex', 'astra')
const odd = model('pi', 'odd')
const base = {
  schemaVersion: 1,
  revision: 3,
  mode: 'builtin',
  // 内置预排：Claude 和 Codex 的同档模型落在同一个全局等级里
  tiers: [[haiku.key, luna.key], [sol.key], [opus.key, astra.key], [fable.key]],
  unranked: [odd.key],
  models: [haiku, opus, fable, luna, sol, astra, odd],
}
const names = (ladder) => ladder.levels.map((level) => level.members.map((m) => m.model).join('+'))

test('开关关着：每个 harness 一条自己的阶梯，从高到低、各自从 1 数起', () => {
  const ladders = laddersOf(base, ['codex', 'claude-code'])
  assert.deepEqual(
    ladders.map((ladder) => ladder.harness),
    ['codex', 'claude-code'],
  )
  assert.deepEqual(names(ladders[0]), ['astra', 'sol', 'luna'])
  assert.deepEqual(names(ladders[1]), ['fable', 'opus', 'haiku'])
  assert.deepEqual(
    ladders[1].levels.map((level) => level.number),
    [3, 2, 1],
  )
})

test('开关打开：所有 harness 共用一条阶梯', () => {
  const ladders = laddersOf({ ...base, crossHarness: true })
  assert.equal(ladders.length, 1)
  assert.equal(ladders[0].harness, null)
  assert.deepEqual(names(ladders[0]), ['fable', 'opus+astra', 'sol', 'haiku+luna'])
})

test('开关关着时上一级是本 harness 的上一级，跨过别的 harness 独占的全局等级', () => {
  // haiku 的上一级在 Claude 阶梯上是 opus（全局下标 2），中间 sol 那一级不属于 Claude
  const next = applyRank(base, haiku.key, { kind: 'up' })
  assert.deepEqual(names(ladderOf(next, 'claude-code')), ['fable', 'opus+haiku'])
  // Codex 的阶梯不受影响
  assert.deepEqual(names(ladderOf(next, 'codex')), ['astra', 'sol', 'luna'])
  assert.equal(next.mode, 'custom')
})

test('同级有别的模型时，最高一级还能再升（拆成新的一级），独占最高一级时不能', () => {
  const cross = { ...base, crossHarness: true }
  assert.equal(canRank(cross, fable.key, { kind: 'up' }), false)
  assert.equal(canRank(cross, opus.key, { kind: 'split' }), true)
  const split = applyRank(cross, opus.key, { kind: 'split' })
  assert.deepEqual(names(ladderOf(split, null)), ['fable', 'opus', 'astra', 'sol', 'haiku+luna'])
  const down = applyRank(cross, luna.key, { kind: 'down' })
  assert.deepEqual(names(ladderOf(down, null)).slice(-2), ['haiku', 'luna'])
})

test('并入、放到最高、最低与未分级', () => {
  // 开关关着时只能并入本 harness 的等级；Pi 还没有任何等级
  assert.equal(canRank(base, odd.key, { kind: 'join', tier: 1 }), false)
  const joined = applyRank({ ...base, crossHarness: true }, odd.key, { kind: 'join', tier: 1 })
  assert.equal(joined.unranked.length, 0)
  assert.deepEqual(joined.tiers[1], [sol.key, odd.key])
  const top = applyRank(base, odd.key, { kind: 'top' })
  assert.deepEqual(names(ladderOf(top, 'pi')), ['odd'])
  assert.deepEqual(top.tiers.at(-1), [odd.key])
  const out = applyRank(base, sol.key, { kind: 'unrank' })
  assert.deepEqual(out.unranked, [odd.key, sol.key])
  assert.equal(canRank(base, odd.key, { kind: 'unrank' }), false)
})

test('拖放：关着时不能拖到别的 harness；插缝、并入、放回未分级', () => {
  const [codex] = laddersOf(base, ['codex'])
  assert.equal(canDrop(base, opus.key, codex), false)
  assert.equal(canDrop(base, sol.key, codex), true)
  assert.deepEqual(gapsOf(codex, base.tiers.length), [3, 2, 1, 0])
  const gap = applyDrop(base, sol.key, { kind: 'gap', at: 0 })
  assert.deepEqual(names(ladderOf(gap, 'codex')), ['astra', 'luna', 'sol'])
  // 独占一级时插在自己上下的缝里不算改动
  assert.equal(applyDrop(base, sol.key, { kind: 'gap', at: 2 }), base)
  const join = applyDrop(base, sol.key, { kind: 'join', tier: 2 })
  assert.deepEqual(names(ladderOf(join, 'codex')), ['astra+sol', 'luna'])
  assert.equal(applyDrop(base, odd.key, { kind: 'unranked' }), base)
})

test('未分级排序、读取失败分类、写入带上开关', () => {
  assert.deepEqual(
    unrankedOf({ ...base, unranked: [odd.key, sol.key] }, ['codex', 'pi']).map((m) => m.model),
    ['sol', 'odd'],
  )
  const harnesses = [
    { id: 'gemini', state: 'unavailable', down: 'notInstalled' },
    { id: 'qwen', state: 'disabled', down: null },
    { id: 'acp', state: 'unavailable', down: 'versionTooLow' },
    { id: 'pi', state: 'ready', down: null },
  ]
  assert.deepEqual(
    ['gemini', 'qwen', 'acp', 'pi', 'missing'].map((id) => readFailureOf(id, harnesses)),
    ['notInstalled', 'disabled', 'unavailable', 'readFailed', 'notInstalled'],
  )
  const write = writeOf({ ...base, builtinRevision: 'x', errors: {}, crossHarness: true })
  assert.equal(write.crossHarness, true)
  assert.equal(write.expectedRevision, 3)
  assert.deepEqual(write.manual, [])
})
