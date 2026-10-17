// 建会话时带的客户端工具定义（packages/protocol/src/client-tools-specs.mts）要过原生 codex 的校验：
// 不过的话 codex 整个拒绝 thread/start，Litch 在 Codex 上一个会话都建不成（0.8.0 就这样，命名空间说明超长）。
// 规矩照上游 rust-v0.162.0-alpha.20 的 codex-rs/app-server/src/request_processors/thread_processor.rs
// 里 validate_dynamic_tools 逐条抄（从 rust-v0.150.0 起就有命名空间这一套）；参数结构的那一条
// （codex_tools::parse_tool_input_schema）只查最外层是对象，真的对着 codex 走一遍在
// scripts/check-client-tools-codex.mjs。跟进上游时对一遍这几个数。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLIENT_TOOL_NAMESPACE } from '../../protocol/src/client-tools.mjs'
import { clientToolSpecs } from '../../protocol/src/client-tools-specs.mjs'

const NAME_MAX = 128
const NAMESPACE_MAX = 64
const NAMESPACE_DESCRIPTION_MAX = 1024
const IDENTIFIER = /^[a-zA-Z0-9_-]+$/
const RESERVED = [
  'api_tool',
  'browser',
  'computer',
  'container',
  'file_search',
  'functions',
  'image_gen',
  'multi_tool_use',
  'python',
  'python_user_visible',
  'submodel_delegator',
  'terminal',
  'tool_search',
  'web',
]

/** 上游按字符（Rust 的 chars，即码点）数，不是按 UTF-16 */
const chars = (text: string) => [...text].length

const specs = clientToolSpecs(Object.values(CLIENT_TOOL_NAMESPACE))

test('每个命名空间都有定义', () => {
  assert.deepEqual(
    specs.map((spec) => spec.name),
    Object.values(CLIENT_TOOL_NAMESPACE),
  )
})

test('命名空间过得了原生 codex 的校验', () => {
  const seen = new Set<string>()
  for (const spec of specs) {
    assert.equal(spec.name, spec.name.trim())
    assert.match(spec.name, IDENTIFIER)
    assert.ok(chars(spec.name) <= NAMESPACE_MAX, `${spec.name} 太长`)
    assert.ok(
      chars(spec.description) <= NAMESPACE_DESCRIPTION_MAX,
      `${spec.name} 的说明有 ${chars(spec.description)} 个字，上限 ${NAMESPACE_DESCRIPTION_MAX}`,
    )
    assert.ok(spec.name !== 'mcp' && !spec.name.startsWith('mcp__'), `${spec.name} 是保留的`)
    assert.ok(!RESERVED.includes(spec.name), `${spec.name} 和 Responses API 的命名空间撞了`)
    assert.ok(!seen.has(spec.name), `${spec.name} 重复`)
    seen.add(spec.name)
    assert.ok(spec.tools.length > 0, `${spec.name} 一个工具都没有`)
  }
})

test('工具过得了原生 codex 的校验', () => {
  for (const spec of specs) {
    const seen = new Set<string>()
    for (const tool of spec.tools) {
      const label = `${spec.name}.${tool.name}`
      assert.equal(tool.name, tool.name.trim(), label)
      assert.match(tool.name, IDENTIFIER, label)
      assert.ok(chars(tool.name) <= NAME_MAX, `${label} 太长`)
      assert.ok(tool.name !== 'mcp' && !tool.name.startsWith('mcp__'), `${label} 是保留的`)
      assert.ok(!seen.has(tool.name), `${label} 重复`)
      seen.add(tool.name)
      assert.equal(tool.inputSchema.type, 'object', `${label} 的参数要是对象`)
    }
  }
})
