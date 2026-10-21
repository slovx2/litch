// 新建对话页默认建在哪：哪台设备、哪个工作区，以及“上次用的是哪里”怎么记。
// 不起浏览器：new-place.ts 只有判断；remembered.ts 只用到一个存不存得进去都行的本地存储，这里给它一个假的。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

/** 假的本地存储：只有读和写 */
const stored = new Map()
globalThis.localStorage = {
  getItem: (key) => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, String(value)),
}

const { defaultDevice, defaultHarness, defaultWorkspace, fitPicks, resolvePlace } = await import(
  '../src/composer/new-place.ts'
)
const { recallDevice, recallWorkspace, rememberHarness, rememberPlace } = await import(
  '../src/composer/remembered.ts'
)

const device = (id, kind, connection) => ({ id, kind, connection })
const LOCAL = device('local', 'local', 'online')
const BUILD = device('build', 'ssh', 'online')
const GPU = device('gpu', 'ssh', 'offline')

/** 拼一份“定默认去处要看的东西”。没给的都是没记过、没有 */
const facts = (devices, extra = {}) => ({
  devices,
  workspaces: (deviceId) => extra.workspaces?.[deviceId],
  lastDevice: extra.lastDevice,
  lastWorkspace: (deviceId) => extra.lastWorkspace?.[deviceId],
})

test('默认的设备：上次用的那台，没有就是本机，再没有是第一台连着的', () => {
  // 上次用的那台还在：就是它，哪怕它现在没连上（那一页会说为什么用不了），也不管本机在不在
  assert.equal(defaultDevice(facts([LOCAL, BUILD, GPU], { lastDevice: 'gpu' })), 'gpu')
  // 上次用的那台已经被移除了：当作没记过
  assert.equal(defaultDevice(facts([LOCAL, BUILD], { lastDevice: 'gone' })), 'local')
  // 没记过：本机那台，它排在后面、没连上也一样
  assert.equal(defaultDevice(facts([BUILD, device('local', 'local', 'error')])), 'local')
  // 没有本机：第一台连着的
  assert.equal(defaultDevice(facts([GPU, BUILD])), 'build')
  // 一台连着的都没有：排最前面的那台
  assert.equal(defaultDevice(facts([GPU, device('nas', 'ssh', 'connecting')])), 'gpu')
  // 一台设备都没有
  assert.equal(defaultDevice(facts([])), null)
})

test('默认的工作区：这台设备上次用的那个，没有就是不属于任何工作区', () => {
  const known = { workspaces: { local: [{ id: 'litch' }, { id: 'docs' }] } }
  assert.equal(defaultWorkspace('local', facts([LOCAL], known)), null)
  assert.equal(
    defaultWorkspace('local', facts([LOCAL], { ...known, lastWorkspace: { local: 'docs' } })),
    'docs',
  )
  // 上次明确选的是“不属于任何工作区”
  assert.equal(
    defaultWorkspace('local', facts([LOCAL], { ...known, lastWorkspace: { local: null } })),
    null,
  )
  // 上次用的那个已经不在了，或者这台设备的工作区还没到：不属于任何工作区
  assert.equal(
    defaultWorkspace('local', facts([LOCAL], { ...known, lastWorkspace: { local: 'gone' } })),
    null,
  )
  assert.equal(
    defaultWorkspace('local', facts([LOCAL], { lastWorkspace: { local: 'docs' } })),
    null,
  )
  // 各台设备各记各的
  assert.equal(
    defaultWorkspace(
      'build',
      facts([LOCAL, BUILD], { ...known, lastWorkspace: { local: 'docs' } }),
    ),
    null,
  )
})

test('现在指着哪：明说了的照它来，没说的按默认的来', () => {
  const known = {
    workspaces: { local: [{ id: 'litch' }], build: [{ id: 'infra' }] },
    lastDevice: 'build',
    lastWorkspace: { build: 'infra', local: 'litch' },
  }
  const all = [LOCAL, BUILD, GPU]
  // 什么都没说：上次用的设备和它上面上次用的工作区
  assert.deepEqual(resolvePlace(null, facts(all, known)), {
    deviceId: 'build',
    workspaceId: 'infra',
  })
  // 只说了设备（在页上换了一台）：工作区按那台设备的默认来
  assert.deepEqual(resolvePlace({ deviceId: 'local' }, facts(all, known)), {
    deviceId: 'local',
    workspaceId: 'litch',
  })
  assert.deepEqual(resolvePlace({ deviceId: 'gpu' }, facts(all, known)), {
    deviceId: 'gpu',
    workspaceId: null,
  })
  // 设备和工作区都说了（工作区行上的加号、在页上换了工作区）：照它来
  assert.deepEqual(resolvePlace({ deviceId: 'local', workspaceId: null }, facts(all, known)), {
    deviceId: 'local',
    workspaceId: null,
  })
  // 明说的工作区不在表里：不换成别的，由那一页去说它不在了
  assert.deepEqual(resolvePlace({ deviceId: 'local', workspaceId: 'gone' }, facts(all, known)), {
    deviceId: 'local',
    workspaceId: 'gone',
  })
  // 明说的那台设备被移除了：整个按默认的来
  assert.deepEqual(resolvePlace({ deviceId: 'gone', workspaceId: 'x' }, facts(all, known)), {
    deviceId: 'build',
    workspaceId: 'infra',
  })
  // 一台设备都没有
  assert.equal(resolvePlace({ deviceId: 'local' }, facts([])), null)
})

test('记住上次建在哪：设备只记最近的一台，工作区每台设备各记各的', () => {
  assert.equal(recallDevice(), undefined)
  assert.equal(recallWorkspace('local'), undefined)
  rememberPlace('local', 'litch')
  rememberPlace('build', null)
  assert.equal(recallDevice(), 'build')
  assert.equal(recallWorkspace('local'), 'litch')
  // “不属于任何工作区”也是记下来的一种选择，和没记过不一样
  assert.equal(recallWorkspace('build'), null)
  assert.equal(recallWorkspace('gpu'), undefined)
  rememberPlace('local', 'docs')
  assert.equal(recallDevice(), 'local')
  assert.equal(recallWorkspace('local'), 'docs')
  assert.equal(recallWorkspace('build'), null)
})

test('记下来的东西读不出来、被改坏了：当没记过', () => {
  stored.set('litch.lastDevice', '{"id":42}')
  stored.set('litch.lastWorkspace', '{"local":{"oops":true}}')
  assert.equal(recallDevice(), undefined)
  assert.equal(recallWorkspace('local'), undefined)
  stored.set('litch.lastDevice', '不是 JSON')
  stored.set('litch.lastWorkspace', 'null')
  assert.equal(recallDevice(), undefined)
  assert.equal(recallWorkspace('local'), undefined)
})

test('默认的 harness：这次点选的、这个工作区上次用的、这台设备最近用的，头一个现在可用的算数', () => {
  const ready = [{ id: 'claude-code' }, { id: 'pi' }, { id: 'dsh' }]
  assert.equal(defaultHarness(ready, [undefined, undefined, undefined])?.id, 'claude-code')
  assert.equal(defaultHarness(ready, ['dsh', 'pi', 'claude-code'])?.id, 'dsh')
  assert.equal(defaultHarness(ready, [undefined, 'pi', 'dsh'])?.id, 'pi')
  // 这个工作区还没用过：拿这台设备上最近用的
  assert.equal(defaultHarness(ready, [undefined, undefined, 'dsh'])?.id, 'dsh')
  // 记着的那个现在不可用（停用了、没装了）：往后看
  assert.equal(defaultHarness(ready, ['codex', 'gone', 'pi'])?.id, 'pi')
  assert.equal(defaultHarness(ready, ['codex', 'gone', 'also-gone'])?.id, 'claude-code')
  assert.equal(defaultHarness([], ['pi']), undefined)
})

test('建成之后 harness 按工作区记，同时记成这台设备最近用的；不属于工作区的那些自己一格', () => {
  stored.clear()
  rememberHarness('build', 'infra', 'pi')
  rememberHarness('build', null, 'dsh')
  rememberHarness('local', 'litch', 'claude-code')
  assert.deepEqual(JSON.parse(stored.get('litch.lastHarness')), {
    'build/infra': 'pi',
    'build/': 'dsh',
    build: 'dsh',
    'local/litch': 'claude-code',
    local: 'claude-code',
  })
})

/** 拼一份 harness 能选的清单：模型各有几档强度，权限只有给的那几档 */
const menu = (plan, permissions = [':read-only', ':workspace']) => ({
  models: [
    { id: 'opus', efforts: [{ id: 'low' }, { id: 'high' }] },
    { id: 'haiku', efforts: [{ id: 'low' }] },
  ],
  permissions: permissions.map((id) => ({ id })),
  plan,
})

test('页上选过的设置换了设备、项目还算数，那边的清单上不成立的那几项才不算', () => {
  const picks = {
    model: 'opus',
    effort: 'high',
    speed: 'fast',
    permission: ':workspace',
    mode: 'plan',
  }
  // 那边的清单一样：全都带过去
  assert.deepEqual(fitPicks(picks, menu(true)), picks)
  // 那边没有这个模型：模型不算；没选模型时强度留给 newSessionSettings 按对面的默认模型去对
  assert.deepEqual(fitPicks({ ...picks, model: 'gone' }, menu(true)), {
    effort: 'high',
    speed: 'fast',
    permission: ':workspace',
    mode: 'plan',
  })
  // 选的模型在那边没有这一档强度：强度不算，模型还在
  assert.deepEqual(fitPicks({ model: 'haiku', effort: 'high' }, menu(true)), { model: 'haiku' })
  // 那边没有这一档权限、不会计划模式：这两项不算
  assert.deepEqual(fitPicks(picks, menu(false, [':read-only'])), {
    model: 'opus',
    effort: 'high',
    speed: 'fast',
  })
  assert.deepEqual(fitPicks({}, menu(true)), {})
})
