import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// config/read 报的默认（模型、强度、权限档 default_permissions）就是不带这几项新建会话时真的会用的。
// 客户端的新建页照它显示，显示的就是会用的：权限档照上游的顺序取，configRequirements/read 的 defaultPermissions、
// 然后是这里的 default_permissions。默认档跟着配置里的 sandbox_mode、approval_policy 走（桌面端写的就是这两项），
// 两项凑不成一个预设时报 null，建出来的会话也报不出现用的权限档。
test('CONFIG-DEFAULT-001：config/read 的默认模型、强度、权限档和不带设置新建的会话一致', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-default-perm-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start(), true)
  try {
    const edit = (keyPath: string, value: unknown) => ({ keyPath, value, mergeStrategy: 'replace' })
    const check = async (expected: string | null) => {
      const { config } = await client.request('config/read', { cwd: home })
      assert.equal(config.default_permissions, expected)
      const started = await client.request('thread/start', { cwd: home })
      assert.equal(started.activePermissionProfile?.id ?? null, expected)
      assert.equal(started.model, config.model)
      assert.equal(started.reasoningEffort, config.model_reasoning_effort)
    }
    await check(':workspace')
    await client.request('config/batchWrite', { edits: [edit('sandbox_mode', 'read-only')] })
    await check(':read-only')
    await client.request('config/batchWrite', {
      edits: [edit('sandbox_mode', 'danger-full-access'), edit('approval_policy', 'never')],
    })
    await check(':danger-full-access')
    // 完全放开却还要问：不是哪一个预设
    await client.request('config/batchWrite', { edits: [edit('approval_policy', 'on-request')] })
    await check(null)
    // 模型和强度改了，新会话跟着
    const other = (await client.request('model/list')).data.find(
      (entry: any) => !entry.isDefault,
    ).id
    await client.request('config/batchWrite', {
      edits: [
        edit('model', other),
        edit('model_reasoning_effort', 'low'),
        edit('sandbox_mode', null),
      ],
    })
    await check(':workspace')
    assert.equal((await client.request('config/read')).config.model, other)
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})
