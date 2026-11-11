import assert from 'node:assert/strict'
import test from 'node:test'
import {
  builtinTier,
  emptyRanking,
  mergeRanking,
  modelKey,
  moveRankedModel,
  type RankedModel,
  rankingAllows,
} from '../../protocol/src/model-ranking.mjs'

const model = (harness: string, id: string): RankedModel => ({
  key: modelKey(harness, id),
  harness,
  model: id,
  name: id,
  available: true,
})
const luna = model('codex', 'gpt-6-luna'),
  sol = model('codex', 'gpt-6-sol'),
  astra = model('codex', 'gpt-6-astra')

test('内置同引擎上限、并级、跨引擎放行与未知身份', () => {
  const config = emptyRanking()
  assert.equal(rankingAllows(config, sol, astra), false)
  assert.equal(rankingAllows(config, astra, sol), true)
  assert.equal(rankingAllows(config, sol, model('codex', 'gpt-6.1-sol')), true)
  assert.equal(rankingAllows(config, luna, model('claude-code', 'fable')), true)
  const unknown = model('codex', 'future')
  assert.equal(rankingAllows(config, unknown, unknown), true)
  assert.equal(rankingAllows(config, unknown, sol), false)
  assert.equal(builtinTier(model('codex', 'gpt-6-luna-pro')), null)
  assert.equal(
    builtinTier({ ...model('claude-code', 'haiku'), provider: 'gateway', trusted: false }),
    null,
  )
  assert.equal(
    builtinTier({
      ...model('claude-code', 'account/opus'),
      provider: 'account',
      trusted: true,
      resolved: 'claude-opus-5-5',
    }),
    2,
  )
})
test('自定义跨引擎比较，分组并级，更新只插入新型号', () => {
  const fable = model('claude-code', 'fable')
  const config = {
    ...mergeRanking(emptyRanking(), [luna, sol, astra, fable]),
    mode: 'custom' as const,
    crossHarness: true,
    tiers: [[luna.key], [sol.key, astra.key], [fable.key]],
  }
  assert.equal(rankingAllows(config, sol, fable), false)
  assert.equal(rankingAllows(config, sol, astra), true)
  const newer = model('codex', 'gpt-6.2-sol')
  const updated = mergeRanking(config, [luna, sol, astra, fable, newer])
  assert.deepEqual(updated.tiers, [[luna.key], [sol.key, astra.key, newer.key], [fable.key]])
  assert.deepEqual(mergeRanking(updated, [luna, sol, astra, fable, newer]), updated)
  const offline = mergeRanking(updated, [])
  assert.deepEqual(offline.tiers, updated.tiers)
  assert.ok(offline.models.every((row) => !row.available))
})
test('用户拆开同系列后，新型号未分级；手动未分级不被自动覆盖', () => {
  const previous = model('codex', 'gpt-5.6-sol'),
    future = model('codex', 'gpt-6.1-sol')
  const base = {
    ...emptyRanking(),
    mode: 'custom' as const,
    models: [previous, sol],
    tiers: [[previous.key], [sol.key]],
  }
  assert.deepEqual(mergeRanking(base, [previous, sol, future]).unranked, [future.key])
  const moved = moveRankedModel(mergeRanking(emptyRanking(), [luna, sol]), sol.key, null)
  assert.deepEqual(mergeRanking(moved, [luna, sol]).unranked, [sol.key])
  const merged = moveRankedModel(mergeRanking(emptyRanking(), [luna, sol]), sol.key, 0)
  assert.deepEqual(merged.tiers, [[luna.key, sol.key]])
})

test('后续内置表识别的自动未分级项可插入，用户主动未分级保持原样', () => {
  const saved = {
    ...emptyRanking(),
    mode: 'custom' as const,
    models: [luna, sol, astra],
    tiers: [[luna.key], [astra.key]],
    unranked: [sol.key],
  }
  assert.deepEqual(mergeRanking(saved, [luna, sol, astra]).tiers, [
    [luna.key],
    [sol.key],
    [astra.key],
  ])
  assert.deepEqual(mergeRanking({ ...saved, manual: [sol.key] }, [luna, sol, astra]).unranked, [
    sol.key,
  ])
})

test('跨 harness 开关独立于排序模式，缺字段的 custom 也只在各 harness 内比较', () => {
  const opus = model('claude-code', 'opus')
  const unknown = model('claude-code', 'future')
  for (const mode of ['builtin', 'custom'] as const) {
    const config = {
      ...emptyRanking(),
      mode,
      models: [luna, sol, astra, opus, unknown],
      tiers: [[luna.key], [sol.key], [astra.key], [opus.key]],
      unranked: [unknown.key],
    }
    for (const crossHarness of [undefined, false, true]) {
      const rule = crossHarness === undefined ? config : { ...config, crossHarness }
      if (crossHarness === undefined) delete rule.crossHarness
      assert.equal(rankingAllows(rule, sol, astra), false)
      assert.equal(rankingAllows(rule, astra, sol), true)
      assert.equal(rankingAllows(rule, sol, opus), crossHarness !== true)
      assert.equal(rankingAllows(rule, sol, unknown), crossHarness !== true)
      assert.equal(rankingAllows(rule, unknown, sol), crossHarness !== true)
      assert.equal(rankingAllows(rule, unknown, unknown), true)
    }
  }
  const reversed = { ...emptyRanking(), mode: 'custom' as const, tiers: [[astra.key], [sol.key]] }
  assert.equal(rankingAllows(reversed, sol, astra), true, '关跨引擎开关不影响同引擎自定义次序')
  const pi = model('pi', 'unknown'),
    otherPi = model('pi', 'other')
  assert.equal(rankingAllows(emptyRanking(), pi, otherPi), true)
  assert.equal(rankingAllows({ ...emptyRanking(), mode: 'custom' }, pi, otherPi), false)
})
