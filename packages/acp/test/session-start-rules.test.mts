// 核对统一定义经过本引擎展开后，授权范围与额度仍完整交给模型。
import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionTools } from '../../protocol/src/client-tools-sessions.mjs'
import { dynamicToolSpecs, toolInstructions } from '../src/client-tools.mjs'

test('已授权子会话的授权规则和独立额度进入 acp 工具说明及 instructions', () => {
  for (const cards of [true, false]) {
    const namespace = sessionTools(true, cards)
    const start = dynamicToolSpecs([namespace]).find(
      (tool) => tool.namespace === 'litch_sessions' && tool.tool === 'start',
    )
    assert.ok(start)
    assert.match(start.description, /any turn/)
    assert.match(start.description, /16 direct starts/)
    assert.match(start.description, /8 direct children/)
    assert.match(start.description, /24 running or starting sessions/)
    assert.doesNotMatch(start.description, /[\u4e00-\u9fff]/)
    const rules = toolInstructions([namespace]) ?? ''
    assert.match(rules, /including wake, reminder and scheduled turns/)
    assert.match(rules, cards ? /if unsure, use initiation/ : /if unsure, ask the user/)
    assert.match(rules, /Wider sandbox access still requires confirmation/)
  }
})
