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
  STANDARD_SPEED,
  shownSpeed,
} from '../src/index.mjs'
import {
  BUILTIN_PERMISSIONS,
  projectSettings,
  settingsDiff,
  turnOverrides,
} from '../src/projection/settings.mjs'
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
  assert.deepEqual(projectDefaults(null, null), {
    model: null,
    effort: null,
    speed: null,
    permission: null,
  })
})

test('默认：模型和强度是配置里的，管理方下发了新会话默认时以它为准', () => {
  const configured = config({ model: 'gpt-5.5', model_reasoning_effort: 'xhigh' })
  assert.deepEqual(projectDefaults(null, configured), {
    model: 'gpt-5.5',
    effort: 'xhigh',
    speed: null,
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

test('默认：速度是配置里的 service_tier（老写法 fast 就是 priority），管理方下发了以它为准', () => {
  assert.equal(projectDefaults(null, config({ service_tier: 'default' })).speed, 'default')
  assert.equal(projectDefaults(null, config({ service_tier: 'fast' })).speed, 'priority')
  const managed = requirements({
    models: { newThread: { model: null, modelReasoningEffort: null, serviceTier: 'priority' } },
  })
  assert.equal(projectDefaults(managed, config({ service_tier: 'default' })).speed, 'priority')
})

const option = (
  id: string,
  efforts: string[],
  defaultEffort: string | null,
  isDefault = false,
  defaultSpeed: string | null = null,
) => ({
  id,
  title: id,
  efforts: efforts.map((effort) => ({ id: effort, note: effort })),
  defaultEffort,
  speeds: [{ id: 'priority', title: 'Fast', note: '' }],
  defaultSpeed,
  isDefault,
  acceptsImages: true,
})

const options: ComposeOptions = {
  models: [
    option('gpt-6.1-sol', ['low', 'medium', 'high'], 'medium', true),
    option('gpt-5.5', ['low', 'medium', 'high', 'xhigh'], 'high', false, 'priority'),
    { ...option('gpt-mini', ['low'], 'low'), speeds: [] },
  ],
  permissions: [...BUILTIN_PERMISSIONS],
  plan: false,
}

const defaults = (fields: Partial<SessionDefaults>): SessionDefaults => ({
  model: null,
  effort: null,
  speed: null,
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
  assert.deepEqual(seen, {
    model: 'gpt-5.5',
    effort: 'high',
    speed: null,
    permission: ':workspace',
  })
  // 配置写了强度、这个模型有这一档：用它
  assert.equal(
    newSessionSettings({}, defaults({ model: 'gpt-5.5', effort: 'xhigh' }), options).effort,
    'xhigh',
  )
  // 对面的默认模型不在清单里：照样是它（会话就用它），强度照配置的
  assert.deepEqual(newSessionSettings({}, defaults({ model: 'gpt-4.1', effort: 'low' }), options), {
    model: 'gpt-4.1',
    effort: 'low',
    speed: null,
    permission: null,
  })
  // 还没问到对面的默认：照清单里标了默认的猜
  assert.deepEqual(newSessionSettings({}, null, options), {
    model: 'gpt-6.1-sol',
    effort: 'medium',
    speed: null,
    permission: null,
  })
})

test('新建页：选了的优先；换了模型时配置的强度这个模型没有，就用这个模型的默认档', () => {
  const configured = defaults({ model: 'gpt-5.5', effort: 'xhigh', permission: ':workspace' })
  assert.deepEqual(newSessionSettings({ model: 'gpt-6.1-sol' }, configured, options), {
    model: 'gpt-6.1-sol',
    effort: 'medium',
    speed: null,
    permission: ':workspace',
  })
  assert.deepEqual(
    newSessionSettings({ effort: 'low', permission: ':read-only' }, configured, options),
    { model: 'gpt-5.5', effort: 'low', speed: null, permission: ':read-only' },
  )
  // 对面默认的权限档这个 harness 没有：不显示哪一档
  const declared = { ...options, permissions: BUILTIN_PERMISSIONS.slice(2) }
  assert.equal(newSessionSettings({}, configured, declared).permission, null)
})

test('新建页：一档强度也没得选的模型不发强度，它报的默认档、配置里的、选过的都不发', () => {
  // DSH 没配推理档的模型：model/list 报默认档 off、可选的一档没有，发了 off 整个选择被拒
  const plain = { ...options, models: [...options.models, option('plain/flat', [], 'off')] }
  assert.equal(newSessionSettings({ model: 'plain/flat' }, null, plain).effort, null)
  const configured = defaults({ model: 'plain/flat', effort: 'high' })
  assert.equal(newSessionSettings({}, configured, plain).effort, null)
  assert.equal(newSessionSettings({ effort: 'low' }, configured, plain).effort, null)
})

test('新建页的速度：选了的、配置的得是标准或这个模型有的那一档，不然不发；显示时没选的是模型自己的默认档', () => {
  // 选了标准：发 default（不发的话 gpt-5.5 用的是它默认的快速）
  assert.equal(newSessionSettings({ speed: STANDARD_SPEED }, null, options).speed, 'default')
  assert.equal(
    newSessionSettings({ model: 'gpt-5.5', speed: 'priority' }, null, options).speed,
    'priority',
  )
  // 配置里写了速度：没选的时候用它
  assert.equal(newSessionSettings({}, defaults({ speed: 'priority' }), options).speed, 'priority')
  // 这个模型没有速度可选、或者没有这一档：不发
  assert.equal(
    newSessionSettings({ model: 'gpt-mini', speed: 'priority' }, null, options).speed,
    null,
  )
  assert.equal(newSessionSettings({ speed: 'flex' }, null, options).speed, null)
  // 显示：报了就是它，没报是模型的默认档，模型也没有默认档是标准
  const [sol, five] = options.models
  assert.equal(shownSpeed(null, five), 'priority')
  assert.equal(shownSpeed(null, sol), STANDARD_SPEED)
  assert.equal(shownSpeed(STANDARD_SPEED, five), STANDARD_SPEED)
})

test('速度：选了的写成 turn/start 的 serviceTier，标准也要明着发；对面报的速度读回来', () => {
  assert.deepEqual(turnOverrides({ speed: STANDARD_SPEED }), { serviceTier: 'default' })
  assert.deepEqual(turnOverrides({ speed: 'priority' }), { serviceTier: 'priority' })
  assert.deepEqual(turnOverrides({}), {})
  assert.equal(projectSettings({ serviceTier: 'priority' }).speed, 'priority')
  assert.equal(projectSettings({ serviceTier: null }).speed, null)
  const actual = { ...projectSettings({ serviceTier: 'default' }) }
  assert.deepEqual(settingsDiff({ speed: 'priority' }, actual), { speed: 'priority' })
  assert.deepEqual(settingsDiff({ speed: 'default' }, actual), {})
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
    { model: 'claude-opus', effort: 'high', speed: null, permission: ':read-only' },
  )
  assert.deepEqual(sent('config/read').at(-1), { harness: 'cc', cwd: '/home/dev/app' })
  assert.deepEqual(sent('configRequirements/read').at(-1), { harness: 'cc' })
  assert.deepEqual(await command('device.newSessionDefaults', { harness: 'old', cwd: null }), {
    model: null,
    effort: null,
    speed: null,
    permission: null,
  })
})
