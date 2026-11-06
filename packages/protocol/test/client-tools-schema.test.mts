// 工具表的跨 harness 约束；根 check 执行全部协议单测，设备测试入口也加载本文件。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CLIENT_TOOL_NAMESPACE,
  type ClientToolFunctionSpec,
  declaredBrowserActions,
} from '../src/client-tools.mjs'
import { browserToolsSpec } from '../src/client-tools-browser.mjs'
import { clientToolSpecs } from '../src/client-tools-specs.mjs'

test('所有客户端工具的顶层都是普通对象，不含 Claude 拒绝的组合关键字', () => {
  const namespaces = Object.values(CLIENT_TOOL_NAMESPACE)
  for (const desktopPlatform of ['darwin', 'win32', 'linux']) {
    const specs = clientToolSpecs(namespaces, {
      machine: null,
      desktopPlatform,
      computerActions: true,
      browserActions: true,
    })
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

test('浏览器批量声明与定义：逐动作要求现有标签，旧执行端不获得能力', () => {
  assert.equal(
    browserToolsSpec().tools.some((tool) => tool.name === 'run_actions'),
    false,
  )
  const batch = browserToolsSpec(true).tools.find((tool) => tool.name === 'run_actions')
  assert.ok(batch)
  const actions = (batch.inputSchema.properties as any).actions
  assert.equal(actions.minItems, 1)
  assert.equal(actions.maxItems, 12)
  for (const entry of actions.items.oneOf)
    assert.ok(entry.properties.arguments.required.includes('tabId'))
  const capabilities = { litchClientTools: { namespaces: ['litch_browser'], browserActions: true } }
  assert.equal(declaredBrowserActions(capabilities, true), true)
  assert.equal(declaredBrowserActions(capabilities, false), false)
  assert.equal(
    declaredBrowserActions({ litchClientTools: { namespaces: ['litch_browser'] } }, true),
    false,
  )
})
