import assert from 'node:assert/strict'
import test from 'node:test'
import { jsonSchemaValidator } from '../src/json-schema.mjs'

test('按 $schema 草案编译客户端 schema：2020-12、2019-09 与默认 draft-07', () => {
  for (const draft of [
    'https://json-schema.org/draft/2020-12/schema',
    'https://json-schema.org/draft/2019-09/schema',
    'http://json-schema.org/draft-07/schema#',
    undefined,
  ]) {
    const schema = {
      ...(draft ? { $schema: draft } : {}),
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    }
    const validate = jsonSchemaValidator(schema).compile(schema)
    assert.equal(validate({ path: 'a' }), true, String(draft))
    assert.equal(validate({}), false, String(draft))
    assert.equal(validate({ path: 'a', extra: 1 }), false, String(draft))
  }
})

test('2020-12 专属关键字按对应草案生效', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'array',
    prefixItems: [{ type: 'string' }],
    items: false,
  }
  const validate = jsonSchemaValidator(schema).compile(schema)
  assert.equal(validate(['a']), true)
  assert.equal(validate(['a', 'b']), false)
  assert.equal(validate([1]), false)
})
