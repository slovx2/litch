import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('CONFIG-006：嵌套键、删除和显式热重载不改会话模型与计划模式', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-config-reload-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const created = await client.request('thread/start', {
      cwd: home,
      permissions: ':danger-full-access',
    })
    await client.request('thread/settings/update', {
      threadId: created.thread.id,
      collaborationMode: {
        mode: 'plan',
        settings: {
          model: created.model,
          reasoning_effort: created.reasoningEffort,
          developer_instructions: null,
        },
      },
    })
    const oldModel = created.model
    const oldEffort = created.reasoningEffort
    const alternate = (await client.request('model/list')).data.find(
      (value: any) => value.id !== oldModel,
    ).id
    const edit = (keyPath: string, value: unknown) => ({ keyPath, value, mergeStrategy: 'replace' })
    await client.request('config/batchWrite', {
      reloadUserConfig: true,
      edits: [edit('model', alternate), edit('model_reasoning_effort', 'low')],
    })
    const staticSettings = await client.request('thread/resume', { threadId: created.thread.id })
    assert.equal(staticSettings.model, oldModel)
    assert.equal(staticSettings.reasoningEffort, oldEffort)
    assert.equal(
      staticSettings.sandbox.type,
      'dangerFullAccess',
      '只更新模型不能重置会话的显式授权',
    )
    await client.request('config/batchWrite', {
      reloadUserConfig: true,
      edits: [
        edit('sandbox_mode', 'read-only'),
        edit('approval_policy', 'never'),
        edit('sandbox_workspace_write.network_access', false),
        edit('sandbox_workspace_write.writable_roots', [home]),
      ],
    })
    const resumed = await client.request('thread/resume', { threadId: created.thread.id })
    assert.equal(resumed.sandbox.type, 'readOnly')
    assert.equal(resumed.approvalPolicy, 'never')
    assert.equal(
      client.trace.filter((value) => value.method === 'thread/settings/updated').at(-1).params
        .threadSettings.collaborationMode.mode,
      'plan',
    )
    assert.ok(
      client.trace.some(
        (value) =>
          value.method === 'thread/settings/updated' &&
          value.params.threadSettings.sandboxPolicy.type === 'readOnly',
      ),
    )
    const next = await client.request('thread/start', { cwd: home })
    assert.equal(next.model, alternate)
    await client.request('config/value/write', edit('sandbox_workspace_write.network_access', null))
    const configuration = await client.request('config/read', { includeLayers: true })
    assert.deepEqual(configuration.config.sandbox_workspace_write, { writable_roots: [home] })
    assert.equal((await client.request('config/read')).layers, null)
    for (const params of [
      { keyPath: 'approval_policy', value: 'never' },
      { ...edit('approval_policy', 'never'), mergeStrategy: ['replace'] },
      edit('sandbox_workspace_write.network_access', 'yes'),
      edit('sandbox_workspace_write.writable_roots', ['relative']),
      edit('sandbox_mode', ['read-only']),
      edit('model', 'gpt-5.6'),
    ])
      await client.raw('config/value/write', params, -32602)
    assert.equal(
      (await client.request('config/read', { includeLayers: true })).layers[0].version,
      configuration.layers[0].version,
    )
    for (const params of [{ sandbox: ['read-only'] }, { permissions: [':read-only'] }])
      await client.raw('thread/start', { cwd: home, ...params }, -32602)
    assert.equal(model.requests.length, 0)
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('CONFIG-004：配置版本、嵌套合并、原子失败与真实来源一致', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-config-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const first = await client.request('config/read', { includeLayers: true })
    const layer = first.layers.find((value: any) => value.name.type === 'user')
    assert.ok(layer, '必须返回真实用户配置层')
    assert.equal(layer.name.file, join(home, 'adapter', 'config.json'))
    const write = await client.request('config/batchWrite', {
      expectedVersion: layer.version,
      edits: [
        { keyPath: 'approval_policy', value: 'on-request', mergeStrategy: 'replace' },
        { keyPath: 'sandbox_mode', value: 'read-only', mergeStrategy: 'replace' },
        {
          keyPath: 'sandbox_workspace_write',
          value: { network_access: false },
          mergeStrategy: 'replace',
        },
        {
          keyPath: 'sandbox_workspace_write',
          value: { exclude_slash_tmp: true },
          mergeStrategy: 'upsert',
        },
      ],
    })
    assert.notEqual(write.version, layer.version)
    assert.equal(write.filePath, layer.name.file)
    assert.equal((await stat(write.filePath)).mode & 0o777, 0o600)
    const current = await client.request('config/read', { includeLayers: true })
    assert.deepEqual(current.config.sandbox_workspace_write, {
      network_access: false,
      exclude_slash_tmp: true,
    })
    assert.equal(current.origins.sandbox_mode.version, write.version)
    const valueWrite = await client.request('config/value/write', {
      keyPath: 'sandbox_workspace_write.exclude_tmpdir_env_var',
      value: true,
      mergeStrategy: 'replace',
      expectedVersion: write.version,
    })
    assert.notEqual(valueWrite.version, write.version)
    assert.equal(valueWrite.filePath, write.filePath)
    const persisted = JSON.parse(await readFile(valueWrite.filePath, 'utf8'))
    assert.equal(persisted.overrides.sandbox_workspace_write.exclude_tmpdir_env_var, true)
    const updated = await client.request('config/read', { includeLayers: true })
    assert.equal(updated.config.sandbox_workspace_write.exclude_tmpdir_env_var, true)
    assert.equal(updated.origins.sandbox_workspace_write.version, valueWrite.version)
    await client.raw(
      'config/value/write',
      {
        keyPath: 'sandbox_mode',
        value: 'danger-full-access',
        mergeStrategy: 'replace',
        expectedVersion: layer.version,
      },
      -32009,
    )
    await client.raw(
      'config/value/write',
      { keyPath: 'sandbox_mode', value: 'anything', mergeStrategy: 'replace' },
      -32602,
    )
    await client.raw(
      'config/value/write',
      { keyPath: '__proto__.polluted', value: true, mergeStrategy: 'replace' },
      -32602,
    )
    await client.raw(
      'config/value/write',
      {
        keyPath: 'sandbox_mode',
        value: 'danger-full-access',
        mergeStrategy: 'replace',
        filePath: join(home, 'codex', 'config.toml'),
      },
      -32602,
    )
    await client.raw(
      'config/batchWrite',
      {
        edits: [
          { keyPath: 'sandbox_mode', value: 'danger-full-access', mergeStrategy: 'replace' },
          { keyPath: 'approval_policy', value: 'allow-everything', mergeStrategy: 'replace' },
        ],
      },
      -32602,
    )
    assert.equal((await client.request('config/read')).config.sandbox_mode, 'read-only')
    const before = await readFile(write.filePath, 'utf8')
    // 制造实际文件系统写入失败，不能吞错并修改内存配置。
    await rename(write.filePath, write.filePath + '.saved')
    await mkdir(write.filePath)
    const failed = await client.raw('config/value/write', {
      keyPath: 'sandbox_mode',
      value: 'danger-full-access',
      mergeStrategy: 'replace',
    })
    assert.ok(failed.error, '持久化失败必须返回错误')
    assert.equal('result' in failed, false)
    await rm(write.filePath, { recursive: true })
    await rename(write.filePath + '.saved', write.filePath)
    assert.equal(await readFile(write.filePath, 'utf8'), before)
    assert.equal((await client.request('config/read')).config.sandbox_mode, 'read-only')
    assert.equal(model.requests.length, 0)
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('CONFIG-005：持久化只读和完全访问控制真实 CLI 写文件，新默认不覆盖旧会话', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-config-permissions-'))
  const model = new MockLLM()
  const endpoint = await model.start()
  let client = await ProtocolClient.start(home, endpoint)
  try {
    const ids: string[] = []
    for (const sandbox of ['read-only', 'danger-full-access']) {
      await client.request('config/batchWrite', {
        edits: [
          { keyPath: 'approval_policy', value: 'never', mergeStrategy: 'replace' },
          { keyPath: 'sandbox_mode', value: sandbox, mergeStrategy: 'replace' },
          {
            keyPath: 'developer_instructions',
            value: 'CONFIG_INSTRUCTIONS_MARKER',
            mergeStrategy: 'replace',
          },
        ],
      })
      await client.close()
      client = await ProtocolClient.start(home, endpoint)
      const persisted = await client.request('config/read', { includeLayers: true })
      assert.equal(persisted.config.sandbox_mode, sandbox)
      assert.equal(persisted.config.approval_policy, 'never')
      assert.equal(persisted.config.developer_instructions, 'CONFIG_INSTRUCTIONS_MARKER')
      const created = await client.request('thread/start', { cwd: home })
      assert.equal(created.approvalPolicy, 'never')
      assert.equal(created.sandbox.type, sandbox === 'read-only' ? 'readOnly' : 'dangerFullAccess')
      ids.push(created.thread.id)
      const target = join(home, sandbox + '.txt')
      model.enqueue((request) => {
        assert.match(JSON.stringify(request), /CONFIG_INSTRUCTIONS_MARKER/)
        return [
          {
            type: 'tool_use',
            id: 'toolu_config_write',
            name: 'Write',
            input: { file_path: target, content: 'CONFIG_PERMISSION_CHECKED' },
          },
        ]
      })
      model.enqueue((request) => {
        const result = request.messages
          .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
          .find((block: any) => block.tool_use_id === 'toolu_config_write')
        assert.ok(result)
        assert.equal(result.is_error === true, sandbox === 'read-only')
        return [{ type: 'text', text: '配置权限验证完成' }]
      })
      const { turn } = await client.request('turn/start', {
        threadId: created.thread.id,
        input: [{ type: 'text', text: '写入配置验证文件' }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
      if (sandbox === 'read-only') await assert.rejects(access(target))
      else assert.equal(await readFile(target, 'utf8'), 'CONFIG_PERMISSION_CHECKED')
      assert.equal(
        client.trace.filter((entry) => entry.id && entry.method?.endsWith('/requestApproval'))
          .length,
        0,
      )
    }
    assert.equal(
      (await client.request('thread/resume', { threadId: ids[0] })).sandbox.type,
      'readOnly',
    )
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
