import assert from 'node:assert/strict'
import test from 'node:test'
import { mcpToolRef } from '../src/mcp-tool-name.mjs'

// 名字都是 Claude Code 2.1.282 实际起出来的样子（native-mcp-tool-item.test.mts 对着真的 CLI 断言过）。

test('MCP 工具名拆成服务名和工具名；Claude Code 自带的工具不是 MCP 工具', () => {
  assert.deepEqual(mcpToolRef('mcp__forms__ask_form', []), { server: 'forms', tool: 'ask_form' })
  for (const name of ['Read', 'Bash', 'WebFetch', 'mcp', 'mcp__', 'mcp__forms', 'mcp__forms__'])
    assert.equal(mcpToolRef(name, ['forms']), null, name)
  // 服务名是空的拆不出来
  assert.equal(mcpToolRef('mcp____tool', []), null)
})

test('工具名里的双下划线归工具名：没有服务清单时照 Claude Code 自己的拆法', () => {
  assert.deepEqual(mcpToolRef('mcp__forms__ask__twice', []), {
    server: 'forms',
    tool: 'ask__twice',
  })
  assert.deepEqual(mcpToolRef('mcp__forms__ask__twice', ['forms']), {
    server: 'forms',
    tool: 'ask__twice',
  })
})

test('服务名自己带双下划线或以下划线结尾：对着服务清单才拆得对', () => {
  // 服务 a__b 的工具 c__d
  assert.deepEqual(mcpToolRef('mcp__a__b__c__d', ['a__b']), { server: 'a__b', tool: 'c__d' })
  // 不知道有这个服务时只能按第一个双下划线拆
  assert.deepEqual(mcpToolRef('mcp__a__b__c__d', []), { server: 'a', tool: 'b__c__d' })
  // 服务 x_ 的工具 e
  assert.deepEqual(mcpToolRef('mcp__x___e', ['x_']), { server: 'x_', tool: 'e' })
  assert.deepEqual(mcpToolRef('mcp__x___e', []), { server: 'x', tool: '_e' })
  // 服务 _lead_ 的工具 _t_
  assert.deepEqual(mcpToolRef('mcp___lead____t_', ['other', '_lead_']), {
    server: '_lead_',
    tool: '_t_',
  })
})

test('几个服务都对得上时取名字最长的', () => {
  for (const servers of [
    ['a', 'a__b'],
    ['a__b', 'a'],
  ])
    assert.deepEqual(mcpToolRef('mcp__a__b__c', servers), { server: 'a__b', tool: 'c' })
  // 只有 a 的工具才归 a
  assert.deepEqual(mcpToolRef('mcp__a__c', ['a', 'a__b']), { server: 'a', tool: 'c' })
})

test('名字里被换成下划线的字符：服务名还原成配置里的原名，工具名是换过之后的样子', () => {
  assert.deepEqual(mcpToolRef('mcp__my_srv_x__do_it_now', ['my.srv x']), {
    server: 'my.srv x',
    tool: 'do_it_now',
  })
  // 不知道原名时只有换过的样子
  assert.deepEqual(mcpToolRef('mcp__my_srv_x__do_it_now', []), {
    server: 'my_srv_x',
    tool: 'do_it_now',
  })
})

test('适配器自己的工具服务不算 MCP 工具', () => {
  for (const name of [
    'mcp__codex_harness_adapter__lookup',
    'mcp__codex_harness_adapter_goal__create_goal',
    'mcp__codex_harness_adapter_permissions__request_permissions',
  ]) {
    assert.equal(mcpToolRef(name, []), null, name)
    assert.equal(
      mcpToolRef(name, [
        'codex_harness_adapter',
        'codex_harness_adapter_goal',
        'codex_harness_adapter_permissions',
      ]),
      null,
      name,
    )
  }
})
