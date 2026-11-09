import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readBaseline, schemaHashes, schemaSources } from './schema-baseline.mjs'

test('独立合同的工具定义、说明和指令符合已审查的哈希基线', () => {
  assert.deepEqual(schemaHashes(), readBaseline().sha256)
})

test('所有平台和批量变体的命名空间说明符合 Codex 硬上限，浏览器预留修改余量', () => {
  // 独立于可重录的哈希基线；仅更新基线也不能让超长说明过关。
  for (const [variant, value] of Object.entries(schemaSources())) {
    if (!value || typeof value !== 'object' || !('description' in value)) continue
    const spec = value as { name: string; description: string }
    const limit = spec.name === 'litch_browser' ? 950 : 1024
    assert.ok(
      spec.description.length <= limit,
      `${variant}/${spec.name} 的说明有 ${spec.description.length} 字，上限 ${limit}`,
    )
  }
})

test('浏览器精简说明保留批量、结果核实、结构化恢复与授权边界', () => {
  for (const variant of ['browser', 'browserBatch']) {
    const { description } = schemaSources()[variant] as { description: string }
    for (const required of [
      'run_actions',
      'verify the result',
      'structured recovery',
      'never blindly replay input',
      'untrusted',
      'only when not already authorized',
      'request_sign_in',
      'never bypass a denial or block',
    ])
      assert.ok(description.includes(required), required)
  }
})
