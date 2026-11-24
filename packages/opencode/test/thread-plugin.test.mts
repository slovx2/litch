import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { threadPluginConfig } from '../src/runtime.mjs'

test('serve 的 OPENCODE_CONFIG_CONTENT 挂上会话号插件，保留用户给的这一层', () => {
  const plugin = 'file:///p/thread-plugin.mjs'
  assert.deepEqual(JSON.parse(threadPluginConfig(undefined, plugin)), { plugin: [plugin] })
  assert.deepEqual(JSON.parse(threadPluginConfig('{"model":"a/b","plugin":["x"]}', plugin)), {
    model: 'a/b',
    plugin: ['x', plugin],
  })
  // 不是 JSON 对象：原样留着，不挂
  assert.equal(threadPluginConfig('{ model: 1 }', plugin), '{ model: 1 }')
  assert.equal(threadPluginConfig('[]', plugin), '[]')
  // 默认指向编好的插件文件
  const target = JSON.parse(threadPluginConfig(undefined)).plugin[0] as string
  assert.ok(existsSync(fileURLToPath(target)), target)
})
