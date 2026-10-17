// 建会话时带的客户端工具定义（packages/protocol/src/client-tools-specs.mts）要过原生 codex 的校验：
// 不过的话 codex 整个拒绝 thread/start，Litch 在 Codex 上一个会话都建不成（0.8.0 就这样，命名空间说明超长）。
// 规矩只有一份，照上游逐条抄在 packages/shared/test/codex-params.mts（validate_dynamic_tools 连同参数结构的整理与反序列化）；
// 核心真的发出去的整份参数（连同工具定义）在 codex-params.test.mts 里核对，真的对着 codex 走一遍在
// scripts/check-client-tools-codex.mjs 和 apps/desktop/scripts/check-first-turn.mjs。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLIENT_TOOL_NAMESPACE } from '../../protocol/src/client-tools.mjs'
import { clientToolSpecs } from '../../protocol/src/client-tools-specs.mjs'
import { dynamicToolProblems } from '../../shared/test/codex-params.mjs'

const specs = clientToolSpecs(Object.values(CLIENT_TOOL_NAMESPACE))

test('每个命名空间都有定义', () => {
  assert.deepEqual(
    specs.map((spec) => spec.name),
    Object.values(CLIENT_TOOL_NAMESPACE),
  )
})

test('过得了原生 codex 的校验', () => {
  assert.deepEqual(dynamicToolProblems(specs), [])
})

test('每个工具的参数最外层是对象', () => {
  // 守的是模型接口（OpenAI、Anthropic 的函数调用都要求参数是对象）的要求，不是 codex 的：codex 的整理
  // 对最外层不是对象的结构不报错（没有类型提示的会被清空），过得了上面那一条也照样会让模型那一头出错
  for (const spec of specs)
    for (const tool of spec.tools)
      assert.equal(tool.inputSchema.type, 'object', `${spec.name}.${tool.name} 的参数要是对象`)
})

test('codex 交给模型时丢掉的键只有范围（minimum、maximum），别的写了就到得了模型', () => {
  const dropped = new Set<string>()
  dynamicToolProblems(specs, dropped)
  // codex 的参数结构（codex-rs/tools/src/json_schema/types.rs 的 JsonSchema）不认范围：模型看不到上下限，
  // 写在说明里的才看得到。新用到别的会被丢掉的键时这里会知道
  assert.deepEqual([...dropped].sort(), ['maximum', 'minimum'])
})
