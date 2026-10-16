import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { DshServer } from '../src/server.mjs'
import { client, isolate } from './client.mjs'

// config/read 报的默认（模型、强度、权限档 default_permissions）就是不带这几项新建会话时真的会用的。
// 客户端的新建页照它显示（决 149）。dsh 给新会话的权限预设是它自己的默认预设（permissionPresets/catalog
// 的 defaultPreset），模型和强度照 thread/start 的取法（DshServer.selection）。对着 dsh 0.2.0-rc.2。

test('CONFIG-DEFAULT-001：config/read 的默认和不带设置新建的会话一致，改了默认模型、强度后也一致', {
  timeout: 180000,
}, async () => {
  const env = await isolate((body) => [
    { type: 'text', chunks: [body.tools?.length ? '好的。' : 'mock 标题'] },
  ])
  const server = new DshServer(join(env.root, 'home'))
  try {
    const desktop = client(server)
    await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const check = async () => {
      const { config } = await desktop.call('config/read', { cwd: env.cwd })
      const started = await desktop.call('thread/start', { cwd: env.cwd })
      assert.equal(config.default_permissions, started.activePermissionProfile.id)
      assert.equal(started.model, config.model)
      assert.equal(started.reasoningEffort, config.model_reasoning_effort)
      return config
    }
    const first = await check()
    // dsh 不另配时新会话是 workspace-write
    assert.equal(first.default_permissions, ':workspace')

    const edit = (keyPath: string, value: unknown) => ({ keyPath, value, mergeStrategy: 'replace' })
    // 只存了默认强度：模型还是 dsh 的默认
    const effort = first.model_reasoning_effort === 'low' ? 'high' : 'low'
    await desktop.call('config/batchWrite', { edits: [edit('model_reasoning_effort', effort)] })
    const tuned = await check()
    assert.deepEqual([tuned.model, tuned.model_reasoning_effort], [first.model, effort])
    // 存了默认模型、没存强度：强度是那个模型自己的默认。放在最后：dsh 在会话里选了模型之后，给新会话的默认
    // 也跟着变成那一个，而且存这个默认不等（session/selectModel 先答了，过一会儿才存好），排在前面的话
    // 后面的步骤会碰上新旧默认交替的那一下
    const catalog = (await desktop.call('model/list', {})).data
    const other = catalog.find((model: any) => model.id !== first.model)
    assert.ok(other, '前提：dsh 的模型目录里有别的模型')
    await desktop.call('config/batchWrite', {
      edits: [edit('model', other.id), edit('model_reasoning_effort', null)],
    })
    const chosen = await check()
    assert.deepEqual(
      [chosen.model, chosen.model_reasoning_effort],
      [other.id, other.defaultReasoningEffort],
    )
  } finally {
    await server.close()
    await env.restore()
  }
})
