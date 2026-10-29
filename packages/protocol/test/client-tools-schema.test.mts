// 工具表的跨 harness 约束；设备测试入口也加载本文件，保证常规测试覆盖协议防线。
import assert from 'node:assert/strict'
import test from 'node:test'
import { CLIENT_TOOL_NAMESPACE, type ClientToolFunctionSpec } from '../src/client-tools.mjs'
import { clientToolSpecs } from '../src/client-tools-specs.mjs'

test('所有客户端工具的顶层都是普通对象，不含 Claude 拒绝的组合关键字', () => {
  const namespaces = Object.values(CLIENT_TOOL_NAMESPACE)
  for (const desktopPlatform of ['darwin', 'win32', 'linux']) {
    const specs = clientToolSpecs(namespaces, { machine: null, desktopPlatform })
    assert.deepEqual(
      specs.map((spec) => spec.name),
      namespaces,
    )
    for (const spec of specs) {
      assert.ok(spec.tools.length > 0, spec.name)
      for (const tool of spec.tools) {
        const label = `${spec.name}.${tool.name} (${desktopPlatform})`
        assert.equal(tool.inputSchema.type, 'object', label)
        for (const keyword of ['oneOf', 'anyOf', 'allOf', 'not', 'if'])
          assert.equal(Object.hasOwn(tool.inputSchema, keyword), false, `${label}: ${keyword}`)
      }
    }
  }
})

test('定时任务的 schedule 组合只在属性内部，不属于顶层禁用范围', () => {
  const [tasks] = clientToolSpecs([CLIENT_TOOL_NAMESPACE.tasks])
  assert.ok(tasks)
  for (const name of ['create', 'update']) {
    const tool: ClientToolFunctionSpec | undefined = tasks.tools.find(
      (candidate) => candidate.name === name,
    )
    assert.ok(tool)
    const properties = tool.inputSchema.properties as Record<string, Record<string, unknown>>
    assert.ok(Array.isArray(properties.schedule?.oneOf))
    assert.equal(Object.hasOwn(tool.inputSchema, 'oneOf'), false)
  }
})
