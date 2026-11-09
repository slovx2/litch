import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('编排路径护栏：新增read只能取元数据，resume/fork必须排除历史', () => {
  for (const name of ['session-tree', 'session-start']) {
    const source = readFileSync(new URL(`../../../src/${name}.mts`, import.meta.url), 'utf8')
    // 此范围的请求统一用字面量对象；改为变量必须同步完善护栏，不能悄悄略过。
    const calls = [
      ...source.matchAll(/\.request\(\s*'(thread\/(?:read|resume|fork))'\s*,\s*([^)]*)/g),
    ]
    assert.ok(calls.length > 0)
    for (const [, method, args] of calls) {
      assert.match(args ?? '', /^\{/, `${name}: ${method}必须显式限制历史`)
      const required = method === 'thread/read' ? /includeTurns:\s*false/ : /excludeTurns:\s*true/
      assert.match((args ?? '').split('}')[0] ?? '', required, `${name}: ${method}缺少历史限制`)
    }
  }
})
