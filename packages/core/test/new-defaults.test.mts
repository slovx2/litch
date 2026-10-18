// 新建页的默认（显示的就是建会话时会用的）：不带设置新建会话时对面会用的模型、强度、权限档怎么算（projectDefaults），
// 新建页上显示、建会话时发出去的是什么（newSessionSettings），以及设备那头怎么问（device.newSessionDefaults）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Config, ConfigRequirements } from '../../protocol/src/index.mjs'
import {
  type ComposeOptions,
  newSessionSettings,
  projectDefaults,
  type SessionDefaults,
} from '../src/index.mjs'
import { BUILTIN_PERMISSIONS } from '../src/projection/settings.mjs'
import { deviceWorld } from './device-world.mjs'
import { harness, model } from './fake-device.mjs'
import { RpcFailure } from './fake-server.mjs'
import { settle } from './helpers.mjs'

const config = (fields: Record<string, unknown>) =>
  ({ model: null, model_reasoning_effort: null, ...fields }) as unknown as Config
const requirements = (fields: Record<string, unknown>) => fields as unknown as ConfigRequirements

test('默认：权限档照上游的顺序取，管理方的、配置的，都没有时许用就是 :workspace', () => {
  const managed = requirements({ defaultPermissions: ':read-only' })
  const configured = config({ default_permissions: ':danger-full-access' })
  assert.equal(projectDefaults(managed, configured).permission, ':read-only')
  assert.equal(projectDefaults(null, configured).permission, ':danger-full-access')
  assert.equal(projectDefaults(null, config({})).permission, ':workspace')
  // 管理方给了许用的清单：:workspace 不在里面就不兜底
  const narrow = requirements({ allowedPermissionProfiles: { ':read-only': true } })
  assert.equal(projectDefaults(narrow, config({})).permission, null)
  const listed = requirements({ allowedPermissionProfiles: { ':workspace': true } })
  assert.equal(projectDefaults(listed, config({})).permission, ':workspace')
  // 对面不认识 config/read：什么都不知道，也不兜底
  assert.deepEqual(projectDefaults(null, null), { model: null, effort: null, permission: null })
})

test('默认：模型和强度是配置里的，管理方下发了新会话默认时以它为准', () => {
  const configured = config({ model: 'gpt-5.5', model_reasoning_effort: 'xhigh' })
  assert.deepEqual(projectDefaults(null, configured), {
    model: 'gpt-5.5',
    effort: 'xhigh',
    permission: ':workspace',
  })
  const managed = requirements({
    models: { newThread: { model: 'gpt-6', modelReasoningEffort: null, serviceTier: null } },
  })
  // 管理方只定了模型：强度还是配置里的
  assert.deepEqual(
    [projectDefaults(managed, configured).model, projectDefaults(managed, configured).effort],
    ['gpt-6', 'xhigh'],
  )
})

const option = (
  id: string,
  efforts: string[],
  defaultEffort: string | null,
  isDefault = false,
) => ({
  id,
  title: id,
  note: '',
  efforts: efforts.map((effort) => ({ id: effort, note: effort })),
  defaultEffort,
  isDefault,
  acceptsImages: true,
})

const options: ComposeOptions = {
  models: [
    option('gpt-6.1-sol', ['low', 'medium', 'high'], 'medium', true),
    option('gpt-5.5', ['low', 'medium', 'high', 'xhigh'], 'high'),
  ],
  permissions: [...BUILTIN_PERMISSIONS],
  plan: false,
}

const defaults = (fields: Partial<SessionDefaults>): SessionDefaults => ({
  model: null,
  effort: null,
  permission: null,
  ...fields,
})

test('新建页：没选的时候显示对面不带设置新建会用的，不是清单里标了默认的那个', () => {
  // 原生 codex：配置里写了 gpt-5.5，清单里标默认的是 gpt-6.1-sol。不带设置新建，codex 用的是 gpt-5.5
  const seen = newSessionSettings(
    {},
    defaults({ model: 'gpt-5.5', effort: null, permission: ':workspace' }),
    options,
  )
  // 配置没写强度：这个模型自己的默认档
  assert.deepEqual(seen, { model: 'gpt-5.5', effort: 'high', permission: ':workspace' })
  // 配置写了强度、这个模型有这一档：用它
  assert.equal(
    newSessionSettings({}, defaults({ model: 'gpt-5.5', effort: 'xhigh' }), options).effort,
    'xhigh',
  )
  // 对面的默认模型不在清单里：照样是它（会话就用它），强度照配置的
  assert.deepEqual(newSessionSettings({}, defaults({ model: 'gpt-4.1', effort: 'low' }), options), {
    model: 'gpt-4.1',
    effort: 'low',
    permission: null,
  })
  // 还没问到对面的默认：照清单里标了默认的猜
  assert.deepEqual(newSessionSettings({}, null, options), {
    model: 'gpt-6.1-sol',
    effort: 'medium',
    permission: null,
  })
})

test('新建页：选了的优先；换了模型时配置的强度这个模型没有，就用这个模型的默认档', () => {
  const configured = defaults({ model: 'gpt-5.5', effort: 'xhigh', permission: ':workspace' })
  assert.deepEqual(newSessionSettings({ model: 'gpt-6.1-sol' }, configured, options), {
    model: 'gpt-6.1-sol',
    effort: 'medium',
    permission: ':workspace',
  })
  assert.deepEqual(
    newSessionSettings({ effort: 'low', permission: ':read-only' }, configured, options),
    { model: 'gpt-5.5', effort: 'low', permission: ':read-only' },
  )
  // 对面默认的权限档这个 harness 没有：不显示哪一档
  const declared = { ...options, permissions: BUILTIN_PERMISSIONS.slice(2) }
  assert.equal(newSessionSettings({}, configured, declared).permission, null)
})

test('设备：新会话的默认问的是那个 harness，带着工作目录；对面不认识 config/read 时全是 null', async () => {
  const { core, command, sent } = deviceWorld(
    [
      harness('cc', { models: [model('claude-sonnet', { isDefault: true })] }),
      harness('old', { models: [model('m')] }),
    ],
    {
      extra: {
        'config/read': (params) => {
          const { harness: target } = params as { harness?: string }
          if (target === 'old') throw new RpcFailure(-32601, 'Method not found: config/read')
          return {
            config: config({
              model: 'claude-opus',
              model_reasoning_effort: 'high',
              default_permissions: ':read-only',
            }),
            origins: {},
            layers: null,
          }
        },
        'configRequirements/read': () => ({ requirements: null }),
      },
    },
  )
  core.start()
  await settle()
  assert.deepEqual(
    await command('device.newSessionDefaults', { harness: 'cc', cwd: '/home/dev/app' }),
    { model: 'claude-opus', effort: 'high', permission: ':read-only' },
  )
  assert.deepEqual(sent('config/read').at(-1), { harness: 'cc', cwd: '/home/dev/app' })
  assert.deepEqual(sent('configRequirements/read').at(-1), { harness: 'cc' })
  assert.deepEqual(await command('device.newSessionDefaults', { harness: 'old', cwd: null }), {
    model: null,
    effort: null,
    permission: null,
  })
})
