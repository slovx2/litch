// 原生 codex 的模型清单（litch/harness/models/*，设备进程替它做）和全局的上下文配置项。
// codex 自带的模型目录由假的主进程答（控制命令 codex.models）；清单文件真的写在临时目录里（codexHome 指向它）。
// 对着真的 codex（0.160.0）照 scripts/check-native-codex.mjs 的做法另跑过一遍（写清单、重启后 model/list 与线程的上下文窗口、
// 全局 model_context_window），那个检查脚本没有放进仓库。
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { codexRig } from './codex-kit.mjs'
import { FakeCodex } from './fake-codex.mjs'
import { installConfig, USER_FILE, userVersion } from './fake-codex-config.mjs'
import { failure } from './fake-control.mjs'
import { RpcFailure } from './fake-upstream.mjs'
import { assertHcError, assertHcParams, assertHcResponse, CHANGED } from './hc-kit.mjs'
import { settle, tempDir } from './helpers.mjs'

const CODEX = { harness: 'codex' }
const READ = 'litch/harness/models/read'
const WRITE = 'litch/harness/models/write'

/** 照 codex debug models --bundled 的样子造一个模型（字段挑了一部分，够看出“别的字段原样拷过去”） */
function shipped(slug: string, priority: number, visibility: string, extra: object = {}) {
  return {
    slug,
    display_name: slug.toUpperCase(),
    description: `${slug} 的说明`,
    priority,
    visibility,
    supported_in_api: true,
    shell_type: 'shell_command',
    supported_reasoning_levels: [{ effort: 'low', description: '快' }],
    base_instructions: `你是 ${slug}`,
    effective_context_window_percent: 95,
    ...extra,
  }
}

const SHIPPED = [
  shipped('gpt-b', 2, 'list', { context_window: 272000, max_context_window: 400000 }),
  shipped('gpt-a', 1, 'list', { context_window: 200000 }),
  shipped('gpt-auto', 9, 'hide', { context_window: 272000 }),
  shipped('gpt-old', 5, 'list', { context_window: 128000, auto_compact_token_limit: 100000 }),
]

async function setup(declared = ['harness', 'harnessConfig']) {
  const home = tempDir()
  const fake = new FakeCodex()
  const greet = fake.handlers.initialize as (params: any, connection: any) => any
  fake.handlers.initialize = (params, connection) => ({
    ...greet(params, connection),
    codexHome: home,
  })
  const env = codexRig({ fake })
  const state = installConfig(env.codex)
  env.control.handlers['codex.models'] = () => ({
    executable: '/fake/bin/codex',
    catalog: { models: structuredClone(SHIPPED) },
  })
  const client = env.connect()
  await client.initialize(declared)
  const litch = join(home, 'litch-models.json')
  const file = () => JSON.parse(readFileSync(litch, 'utf8')).models
  return { env, state, client, home, litch, file }
}

const entry = (
  id: string,
  base = id,
  displayName: string | null = null,
  contextWindow: number | null = null,
) => ({
  id,
  base,
  displayName,
  contextWindow,
})

test('config/read：原生 codex 报 modelCatalog；上下文一组三项，effect 是新会话，两个整数有下限', async () => {
  const { env, client } = await setup()
  try {
    const read = await client.call('litch/harness/config/read', CODEX)
    assertHcResponse('litch/harness/config/read', read)
    assert.equal(read.modelCatalog, true)
    const context = read.settings.filter((spec: any) => spec.group === 'context')
    assert.deepEqual(
      context.map((spec: any) => [spec.key, spec.type, spec.effect]),
      [
        ['model_context_window', 'integer', 'newSession'],
        ['model_auto_compact_token_limit', 'integer', 'newSession'],
        ['model_auto_compact_token_limit_scope', 'enum', 'newSession'],
      ],
    )
    assert.equal(context[0].minimum, 1000)
    assert.match(context[0].description['zh-CN'], /盖过每个模型/)
    assert.deepEqual(
      context[2].options.map((item: any) => item.value),
      ['total', 'body_after_prefix'],
    )
    assert.deepEqual(read.groups.map((group: any) => group.id).slice(0, 2), ['defaults', 'context'])
    const bad = await client.fails('litch/harness/config/write', {
      ...CODEX,
      edits: [{ key: 'model_context_window', value: 10 }],
      expectedVersion: read.version,
    })
    assert.equal(bad.data.litch, 'invalidValue')
    const written = await client.call('litch/harness/config/write', {
      ...CODEX,
      edits: [
        { key: 'model_context_window', value: 500000 },
        { key: 'model_auto_compact_token_limit_scope', value: 'body_after_prefix' },
      ],
      expectedVersion: read.version,
    })
    assert.equal(written.restartRequired, false)
  } finally {
    await env.close()
  }
})

test('models/read：没配清单时 custom 为 false；底稿按 codex 的顺序，只列选单里看得到的', async () => {
  const { env, client, litch } = await setup()
  try {
    const read = await client.call(READ, CODEX)
    assertHcResponse(READ, read)
    assert.equal(read.custom, false)
    assert.deepEqual(read.entries, [])
    assert.equal(read.path, litch)
    assert.equal(read.effect, 'harness')
    assert.equal(read.note, null)
    assert.equal(read.readOnlyReason, null)
    assert.deepEqual(read.bases[0], {
      id: 'gpt-a',
      displayName: 'GPT-A',
      contextWindow: 200000,
      description: 'gpt-a 的说明',
    })
    assert.deepEqual(
      read.bases.map((base: any) => base.id),
      ['gpt-a', 'gpt-b', 'gpt-old'],
    )
    assert.deepEqual(env.control.sent('codex.models'), [{}])
  } finally {
    await env.close()
  }
})

test('models/write：生成完整的 ModelInfo、改指向、发通知；读回来的和写的一样；再写不用再改指向；null 回到自带目录', async () => {
  const { env, state, client, litch, file } = await setup()
  const plain = env.connect()
  await plain.initialize(['harness'])
  try {
    const read = await client.call(READ, CODEX)
    const entries = [
      entry('gpt-a'),
      entry('my-b', 'gpt-b', 'My B', 1000000),
      entry('old-small', 'gpt-old', null, 64000),
    ]
    const before = userVersion(state)
    const params = { ...CODEX, entries, expectedVersion: read.version }
    assertHcParams(WRITE, params)
    const written = await client.call(WRITE, params)
    assertHcResponse(WRITE, written)
    assert.equal(written.restartRequired, true)
    assert.equal(state.user.model_catalog_json, litch)
    assert.equal(state.writes.length, 1)
    assert.equal(state.writes[0].filePath, USER_FILE)
    assert.equal(state.writes[0].expectedVersion, before)
    const [a, b, old] = file()
    // 原样的那一项和自带的一样，只是排在清单的位置、在选单里
    assert.deepEqual(a, { ...SHIPPED[1], priority: 0, visibility: 'list' })
    assert.equal(b.slug, 'my-b')
    assert.equal(b.display_name, 'My B')
    assert.equal(b.context_window, 1000000)
    assert.equal(b.max_context_window, 1000000, '上限比新窗口小时抬上去')
    assert.equal(b.litch_base, 'gpt-b')
    assert.equal(b.base_instructions, '你是 gpt-b', '别的字段照底稿')
    assert.equal(b.priority, 1)
    assert.equal(old.display_name, 'GPT-OLD')
    assert.equal(old.context_window, 64000)
    assert.equal(old.auto_compact_token_limit, undefined, '改了窗口就去掉旧的压缩门槛')
    assert.equal(old.max_context_window, undefined)
    assert.ok(!('litch_base' in a))
    const frame = await client.waitFor((item) => item.method === CHANGED)
    assert.deepEqual(frame.params, { harness: 'codex', part: 'models' })
    await settle(50)
    assert.ok(!plain.raw.some((text) => text.includes(CHANGED)), '没声明的连接收不到')

    const back = await client.call(READ, CODEX)
    assertHcResponse(READ, back)
    assert.equal(back.custom, true)
    assert.equal(back.path, litch)
    assert.equal(back.version, written.version)
    assert.deepEqual(back.entries, entries)
    assert.equal(back.note, null)

    // 指向已经是 Litch 的文件：只换文件，不再写 config.toml
    const again = await client.call(WRITE, {
      ...CODEX,
      entries: [entry('gpt-old')],
      expectedVersion: back.version,
    })
    assert.equal(state.writes.length, 1)
    assert.notEqual(again.version, back.version)
    assert.deepEqual(
      file().map((model: any) => model.slug),
      ['gpt-old'],
    )
    assert.equal(file()[0].auto_compact_token_limit, 100000, '原样用的不动压缩门槛')
    const stale = await client.fails(WRITE, {
      ...CODEX,
      entries: [entry('gpt-a')],
      expectedVersion: back.version,
    })
    assert.equal(stale.data.litch, 'versionConflict')
    assertHcError(stale.data)

    // 回到 codex 自带的目录：删掉指向，文件留着
    const reset = await client.call(WRITE, {
      ...CODEX,
      entries: null,
      expectedVersion: again.version,
    })
    assert.equal(reset.restartRequired, true)
    assert.equal(state.user.model_catalog_json, undefined)
    assert.ok(existsSync(litch))
    const off = await client.call(READ, CODEX)
    assert.equal(off.custom, false)
    assert.equal(off.version, reset.version)
    const noop = await client.call(WRITE, { ...CODEX, entries: null, expectedVersion: off.version })
    assert.equal(noop.restartRequired, false)
  } finally {
    await env.close()
  }
})

test('models/write：值不对回 invalidValue，key 指明哪一项，什么都不写', async () => {
  const { env, state, client, litch } = await setup()
  try {
    const read = await client.call(READ, CODEX)
    const cases: [unknown, string][] = [
      [[], 'entries'],
      [[entry('gpt-a'), entry('gpt-a', 'gpt-b')], 'entries[1].id'],
      [[entry('')], 'entries[0].id'],
      [[entry(' x ', 'gpt-a')], 'entries[0].id'],
      [[entry('x', 'gpt-auto')], 'entries[0].base'],
      [[entry('x', 'nope')], 'entries[0].base'],
      [[entry('x', 'gpt-a', null, 0)], 'entries[0].contextWindow'],
      [[entry('x', 'gpt-a', null, 1.5)], 'entries[0].contextWindow'],
      [[entry('x', 'gpt-a', '')], 'entries[0].displayName'],
    ]
    for (const [entries, key] of cases) {
      const refused = await client.fails(WRITE, {
        ...CODEX,
        entries,
        expectedVersion: read.version,
      })
      assert.equal(refused.data.litch, 'invalidValue', key)
      assert.equal(refused.data.key, key)
      assertHcError(refused.data)
    }
    assert.deepEqual(state.writes, [])
    assert.ok(!existsSync(litch))
  } finally {
    await env.close()
  }
})

test('models/write：config.toml 没写成时清单文件放回原样', async () => {
  const { env, state, client, litch } = await setup()
  try {
    const read = await client.call(READ, CODEX)
    env.codex.handlers['config/batchWrite'] = () => {
      throw new RpcFailure(-32600, 'nope', { config_write_error_code: 'configValidationError' })
    }
    const refused = await client.fails(WRITE, {
      ...CODEX,
      entries: [entry('gpt-a')],
      expectedVersion: read.version,
    })
    assert.equal(refused.data.litch, 'invalidValue')
    assert.ok(!existsSync(litch), '原来没有的删掉')
    writeFileSync(litch, 'old content')
    const reread = await client.call(READ, CODEX)
    await client.fails(WRITE, {
      ...CODEX,
      entries: [entry('gpt-a')],
      expectedVersion: reread.version,
    })
    assert.equal(readFileSync(litch, 'utf8'), 'old content', '原来有的放回去')
    assert.equal(state.user.model_catalog_json, undefined)
  } finally {
    await env.close()
  }
})

test('用户自己的清单文件：照样列出、补进底稿、提醒默认模型不在里面；写到 Litch 的文件并改指向，原文件不动', async () => {
  const { env, state, client, litch, file } = await setup()
  try {
    const own = join(tempDir(), 'mine.json')
    const original = `${JSON.stringify({
      models: [
        shipped('custom-x', 3, 'list', {
          display_name: 'X',
          context_window: 64000,
          base_instructions: '自己的',
        }),
        { ...shipped('gpt-a', 4, 'list'), display_name: '我的 A' },
      ],
    })}\n`
    writeFileSync(own, original)
    state.user = { model_catalog_json: own, model: 'gpt-b' }
    const read = await client.call(READ, CODEX)
    assertHcResponse(READ, read)
    assert.equal(read.custom, true)
    assert.equal(read.path, own)
    assert.deepEqual(read.entries, [entry('custom-x'), entry('gpt-a')])
    assert.deepEqual(
      read.bases.map((base: any) => [base.id, base.displayName]),
      [
        ['gpt-a', '我的 A'],
        ['gpt-b', 'GPT-B'],
        ['gpt-old', 'GPT-OLD'],
        ['custom-x', 'X'],
      ],
    )
    assert.match(read.note['zh-CN'], /gpt-b 不在清单里/)
    const written = await client.call(WRITE, {
      ...CODEX,
      entries: [entry('custom-x', 'custom-x', null, 128000), entry('gpt-a')],
      expectedVersion: read.version,
    })
    assert.equal(written.restartRequired, true)
    assert.equal(state.user.model_catalog_json, litch)
    assert.equal(readFileSync(own, 'utf8'), original)
    const [x, a] = file()
    assert.equal(x.base_instructions, '自己的')
    assert.equal(x.context_window, 128000)
    assert.equal(a.display_name, '我的 A', '用户文件里的就是它自己的底稿')
  } finally {
    await env.close()
  }
})

test('清单读不出来、问不到自带目录：照样能读，note 里说；管理员定了清单时只读', async () => {
  const { env, state, client } = await setup()
  try {
    const broken = join(tempDir(), 'broken.json')
    writeFileSync(broken, '{"models": ')
    state.user = { model_catalog_json: broken }
    env.control.handlers['codex.models'] = () => {
      throw failure({ reason: 'failed', text: { 'zh-CN': '没有这个命令', en: 'no such command' } })
    }
    const read = await client.call(READ, CODEX)
    assertHcResponse(READ, read)
    assert.equal(read.custom, true)
    assert.deepEqual(read.entries, [])
    assert.deepEqual(read.bases, [])
    assert.match(read.note['zh-CN'], /没有这个命令/)
    assert.match(read.note['zh-CN'], /读不出来/)

    state.requirements = { modelCatalogJson: 'file:///etc/codex/models.json' }
    const locked = await client.call(READ, CODEX)
    assert.equal(locked.path, '/etc/codex/models.json')
    assert.notEqual(locked.readOnlyReason, null)
    const refused = await client.fails(WRITE, {
      ...CODEX,
      entries: null,
      expectedVersion: locked.version,
    })
    assert.equal(refused.data.litch, 'readOnly')
    assertHcError(refused.data)
  } finally {
    await env.close()
  }
})

test('别的 harness 没有模型清单：引擎回的“不认识”统一成 unavailable；实现了的原样转', async () => {
  const { env, client } = await setup()
  try {
    const missing = await client.fails(READ, { harness: 'pi' })
    assert.equal(missing.code, -32000)
    assert.equal(missing.data.litch, 'unavailable')
    assert.equal(missing.data.harness, 'pi')
    assertHcError(missing.data)
    env.pi.handlers[WRITE] = () => {
      throw new RpcFailure(-32000, '不认识', { litch: 'notFound', harness: 'pi' })
    }
    const notFound = await client.fails(WRITE, {
      harness: 'pi',
      entries: null,
      expectedVersion: '',
    })
    assert.equal(notFound.data.litch, 'unavailable')
    env.pi.handlers[READ] = () => {
      throw new RpcFailure(-32000, '版本不对', { litch: 'versionConflict', harness: 'pi' })
    }
    const other = await client.fails(READ, { harness: 'pi' })
    assert.equal(other.data.litch, 'versionConflict', '别的错误原样带回')
  } finally {
    await env.close()
  }
})
