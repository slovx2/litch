import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readBaseline, schemaHashes } from './schema-baseline.mjs'

test('独立合同的工具定义、说明和指令符合已审查的哈希基线', () => {
  assert.deepEqual(schemaHashes(), readBaseline().sha256)
})
