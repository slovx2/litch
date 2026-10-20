// 原生 codex 的 harness 详情设置：设备进程把 litch/harness/* 翻译成 codex 自己的方法。
// 对面是装了配置那几组方法的假 codex（fake-codex-config.mts，照 0.160.0 实测的样子）；
// 对着真的 codex 的检查是 scripts/check-native-codex.mjs。
import assert from 'node:assert/strict'
import test from 'node:test'
import { callbackPort } from '../src/codex-harness-config.mjs'
import { codexRig } from './codex-kit.mjs'
import {
  HOOK_KEY,
  installConfig,
  SKILL_PATH,
  USER_FILE,
  userVersion,
} from './fake-codex-config.mjs'
import { assertHcError, assertHcResponse } from './hc-kit.mjs'

const DECLARED = ['harness', 'harnessConfig']
const CODEX = { harness: 'codex' }

async function setup() {
  const env = codexRig()
  const state = installConfig(env.codex)
  const client = env.connect()
  await client.initialize(DECLARED)
  return { env, state, client }
}

test('config/read：分组、动态的模型和强度、实验特性只列 beta、技能只列用户级和自带的、hooks 两项；版本是用户层的', async () => {
  const { env, state, client } = await setup()
  try {
    state.user = {
      model: 'gpt-a',
      features: { shiny: { enabled: true } },
      hooks: { state: { [HOOK_KEY]: { trusted_hash: 'sha256:hook' } } },
    }
    const read = await client.call('litch/harness/config/read', CODEX)
    assertHcResponse('litch/harness/config/read', read)
    assert.equal(read.version, userVersion(state))
    assert.deepEqual(read.files[0], { role: 'settings', path: USER_FILE })
    const keys = read.settings.map((spec: any) => spec.key)
    const model = read.settings.find((spec: any) => spec.key === 'model')
    assert.deepEqual(
      model.options.map((item: any) => item.value),
      ['gpt-a'],
      '隐藏的模型不列',
    )
    assert.equal(model.default, 'gpt-a')
    assert.ok(model.allowCustom)
    const effort = read.settings.find((spec: any) => spec.key === 'model_reasoning_effort')
    assert.deepEqual(
      effort.options.map((item: any) => item.value),
      ['low', 'high'],
    )
    // 速度：标准要自己补一项（写 default），模型给的快速档按两种语言说；模型没有默认档时默认是标准
    const speed = read.settings.find((spec: any) => spec.key === 'service_tier')
    assert.deepEqual(
      speed.options.map((item: any) => [item.value, item.title['zh-CN']]),
      [
        ['default', '标准'],
        ['priority', '快速'],
      ],
    )
    assert.equal(speed.default, 'default')
    assert.ok(keys.includes('features.shiny'))
    assert.ok(!keys.includes('features.shell_tool'), '稳定的特性不列')
    assert.equal(read.settings.find((spec: any) => spec.key === 'features.shiny').effect, 'harness')
    assert.ok(keys.includes('features.memories'), '记忆的开关归记忆组')
    assert.equal(
      read.settings.find((spec: any) => spec.key === 'features.memories').group,
      'memory',
    )
    assert.ok(keys.includes(`skills."${SKILL_PATH}"`))
    assert.ok(
      !keys.some((key: string) => key.includes('repo-skill') || key.includes('/work/')),
      '项目里的技能不列',
    )
    assert.ok(keys.includes('plugins."docs@m".enabled'))
    assert.ok(keys.includes(`hooks.state."${HOOK_KEY}".enabled`))
    assert.ok(keys.includes(`hooks.state."${HOOK_KEY}".trusted`))
    // 写了的才有值；特性写成表的读成开关；hooks 的信任按 codex 报的
    assert.deepEqual(read.values, {
      model: 'gpt-a',
      'features.shiny': true,
      [`hooks.state."${HOOK_KEY}".trusted`]: true,
    })
    assert.deepEqual(
      read.groups.map((group: any) => group.id),
      ['defaults', 'context', 'permissions', 'behavior', 'features', 'tools', 'memory'],
    )
    assert.deepEqual(
      read.actions.map((action: any) => action.id),
      ['memory.reset'],
    )
  } finally {
    await env.close()
  }
})

test('config/read：被命令行参数盖住的给 overridden；管理员只许一种审批策略时那一项只读', async () => {
  const { env, state, client } = await setup()
  try {
    state.user = { model: 'gpt-a' }
    state.flags = { model: 'gpt-flag' }
    state.requirements = { allowedApprovalPolicies: ['never'] }
    const read = await client.call('litch/harness/config/read', CODEX)
    assertHcResponse('litch/harness/config/read', read)
    assert.equal(read.overridden.model.value, 'gpt-flag')
    assert.match(read.overridden.model.by['zh-CN'], /命令行/)
    const approval = read.settings.find((spec: any) => spec.key === 'approval_policy')
    assert.equal(approval.readOnly, true)
    assert.deepEqual(
      approval.options.map((item: any) => item.value),
      ['never'],
    )
    const refused = await client.fails('litch/harness/config/write', {
      ...CODEX,
      edits: [{ key: 'approval_policy', value: 'never' }],
      expectedVersion: read.version,
    })
    assert.equal(refused.data.litch, 'readOnly')
    assertHcError(refused.data)
    // 写进去但被盖住的键在应答里列出来
    const written = await client.call('litch/harness/config/write', {
      ...CODEX,
      edits: [{ key: 'model', value: 'gpt-b' }],
      expectedVersion: read.version,
    })
    assert.deepEqual(written.overriddenKeys, ['model'])
  } finally {
    await env.close()
  }
})

test('config/write：一次 batchWrite 带 filePath 和 expectedVersion；技能走 skills/config/write；hooks 的信任写 trusted_hash', async () => {
  const { env, state, client } = await setup()
  try {
    const read = await client.call('litch/harness/config/read', CODEX)
    const result = await client.call('litch/harness/config/write', {
      ...CODEX,
      edits: [
        { key: 'model_reasoning_effort', value: 'high' },
        { key: 'sandbox_workspace_write.network_access', value: true },
        { key: 'features.shiny', value: true },
        { key: `skills."${SKILL_PATH}"`, value: false },
        { key: `hooks.state."${HOOK_KEY}".trusted`, value: true },
        { key: `hooks.state."${HOOK_KEY}".enabled`, value: false },
      ],
      expectedVersion: read.version,
    })
    assertHcResponse('litch/harness/config/write', result)
    assert.equal(result.restartRequired, true, '改了实验特性要重启')
    assert.equal(result.version, userVersion(state))
    assert.equal(state.writes.length, 1)
    assert.equal(state.writes[0].filePath, USER_FILE)
    assert.equal(state.writes[0].expectedVersion, read.version)
    assert.deepEqual(state.skillWrites, [{ path: SKILL_PATH, enabled: false }])
    assert.equal(state.user.model_reasoning_effort, 'high')
    assert.equal(state.user.sandbox_workspace_write.network_access, true)
    assert.equal(state.user.features.shiny, true)
    assert.deepEqual(state.user.hooks.state[HOOK_KEY], {
      trusted_hash: 'sha256:hook',
      enabled: false,
    })
    // 清掉：null 是删键
    const again = await client.call('litch/harness/config/write', {
      ...CODEX,
      edits: [
        { key: 'model_reasoning_effort', value: null },
        { key: `hooks.state."${HOOK_KEY}".trusted`, value: false },
      ],
      expectedVersion: result.version,
    })
    assert.equal(again.restartRequired, false)
    assert.equal(state.user.model_reasoning_effort, undefined)
    assert.equal(state.user.hooks.state[HOOK_KEY].trusted_hash, undefined)
  } finally {
    await env.close()
  }
})

test('config/write：版本对不上、键不认识、值不对都整批不写；动作 memory.reset', async () => {
  const { env, state, client } = await setup()
  try {
    const read = await client.call('litch/harness/config/read', CODEX)
    const conflict = await client.fails('litch/harness/config/write', {
      ...CODEX,
      edits: [{ key: 'model', value: 'gpt-a' }],
      expectedVersion: 'sha256:old',
    })
    assert.equal(conflict.data.litch, 'versionConflict')
    const unknown = await client.fails('litch/harness/config/write', {
      ...CODEX,
      edits: [
        { key: 'model', value: 'gpt-a' },
        { key: 'profiles.work.model', value: 'x' },
      ],
      expectedVersion: read.version,
    })
    assert.equal(unknown.data.litch, 'notFound')
    assert.equal(unknown.data.key, 'profiles.work.model')
    const bad = await client.fails('litch/harness/config/write', {
      ...CODEX,
      edits: [
        { key: 'model', value: 'gpt-a' },
        { key: 'sandbox_mode', value: 'everything' },
      ],
      expectedVersion: read.version,
    })
    assert.equal(bad.data.litch, 'invalidValue')
    assert.equal(bad.data.key, 'sandbox_mode')
    for (const error of [conflict, unknown, bad]) assertHcError(error.data)
    assert.deepEqual(state.writes, [], '一项不对整批都不写')
    // 有人在命令行里改了：codex 那头的版本核对也拦得住
    state.user = { model: 'gpt-x' }
    const raced = await client.fails('litch/harness/config/write', {
      ...CODEX,
      edits: [{ key: 'model', value: 'gpt-a' }],
      expectedVersion: read.version,
    })
    assert.equal(raced.data.litch, 'versionConflict')
    assert.deepEqual(
      await client.call('litch/harness/config/action', { ...CODEX, actionId: 'memory.reset' }),
      {},
    )
    assert.equal(state.memoryResets, 1)
    const missing = await client.fails('litch/harness/config/action', {
      ...CODEX,
      actionId: 'nope',
    })
    assert.equal(missing.data.litch, 'notFound')
  } finally {
    await env.close()
  }
})

test('callbackPort：回环上的回调给端口，别的给 null', () => {
  assert.equal(
    callbackPort(
      'https://a/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback',
    ),
    1455,
  )
  assert.equal(callbackPort('https://a/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A9%2Fcb'), 9)
  assert.equal(
    callbackPort('https://a/authorize?redirect_uri=https%3A%2F%2Fexample.com%2Fcb'),
    null,
  )
  assert.equal(callbackPort('https://a/authorize'), null)
  assert.equal(callbackPort('不是网址'), null)
})
