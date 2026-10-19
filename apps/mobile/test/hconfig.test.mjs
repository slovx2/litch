// harness 详情设置里手机自己的那几样（src/screens/devices/hconfig/logic.ts）：provider 怎么分上下两段和筛选、
// 要回调转发的登录在手机上能不能走完、一个值写成一小段字、配置项分组、页面处在哪一种状态；以及文案键。
// 草稿解析、MCP 表单这些和桌面共用的，单测在 packages/ui/test/hconfig.test.mjs。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { translate } from '../../../packages/ui/src/i18n/index.ts'
import { zhCN as desktop } from '../../../packages/ui/src/i18n/zh-CN.ts'
import {
  callbackOf,
  groupsOf,
  isLive,
  OTHERS_INLINE,
  pageState,
  splitProviders,
  valueText,
} from '../src/screens/devices/hconfig/logic.ts'
import * as messages from '../src/ui/messages/hconfig.ts'

function tr(lang) {
  const mobile = lang === 'en' ? messages.en : messages.zhCN
  const t = (key, args = {}) => {
    const entry = mobile[key]
    if (entry === undefined) return translate(lang, key, args)
    if (typeof entry === 'function') return entry(args)
    return entry.replace(/\{(\w+)\}/g, (whole, name) => String(args[name] ?? whole))
  }
  t.said = (value) => (typeof value === 'string' ? value : value[lang])
  t.lang = lang
  return t
}
const zh = tr('zh-CN')

const text = (s) => ({ 'zh-CN': s, en: s })
const provider = (id, extra = {}) => ({
  id,
  title: text(id.toUpperCase()),
  kind: 'builtin',
  auth: { signedIn: false, kind: 'none', label: null, detail: null },
  methods: [],
  active: false,
  definition: null,
  templateId: null,
  canLogout: false,
  ...extra,
})
const attempt = (step, extra = {}) => ({
  attemptId: 'a1',
  providerId: 'p',
  mcpServer: null,
  step,
  forward: null,
  busy: false,
  ...extra,
})

test('中英文的键一样多；没有和桌面界面撞名的键（撞了会遮住那边的句子）', () => {
  assert.deepEqual(Object.keys(messages.en).sort(), Object.keys(messages.zhCN).sort())
  assert.deepEqual(
    Object.keys(messages.zhCN).filter((key) => key in desktop),
    [],
  )
})

test('provider：在用的、登录了的、自定义的、正在登录的在上面，其余多了才收起，能按名字或标识筛', () => {
  const list = [
    provider('active', { active: true }),
    provider('signed', { auth: { signedIn: true, kind: 'apiKey', label: null, detail: null } }),
    provider('mine', { kind: 'custom' }),
    provider('logging'),
    ...Array.from({ length: OTHERS_INLINE }, (_, i) => provider(`other${i}`)),
  ]
  const attempts = [
    attempt({ kind: 'prompt', fields: [], message: null }, { providerId: 'logging' }),
  ]
  const few = splitProviders(list, attempts, '', (one) => one.title.en)
  assert.deepEqual(
    few.primary.map((one) => one.id),
    ['active', 'signed', 'mine', 'logging'],
  )
  assert.equal(few.others.length, OTHERS_INLINE)
  assert.equal(few.folded, false)
  const more = splitProviders([...list, provider('deepseek')], attempts, '', (one) => one.title.en)
  assert.equal(more.folded, true)
  // 筛选按显示名或标识，不分大小写
  const found = splitProviders(
    [...list, provider('deepseek')],
    attempts,
    ' DEEP ',
    (one) => one.title.en,
  )
  assert.deepEqual(
    found.shown.map((one) => one.id),
    ['deepseek'],
  )
  assert.deepEqual(splitProviders(list, attempts, 'zzz', (one) => one.title.en).shown, [])
})

test('回调转发：本机设备（核心没给转发状态）照常走；远程又不能粘贴的只能去桌面端；能粘贴的照样走', () => {
  const open = (prompt) => ({
    kind: 'openUrl',
    url: 'https://x',
    callbackPort: 1455,
    message: null,
    prompt,
  })
  const forward = { port: 1455, state: 'unavailable', message: null }
  assert.equal(callbackOf(attempt(open([]))), null)
  assert.deepEqual(callbackOf(attempt(open([]), { forward })), { port: 1455, paste: false })
  const field = {
    id: 'code',
    title: text('code'),
    secret: false,
    optional: false,
    placeholder: null,
    options: [],
  }
  assert.deepEqual(callbackOf(attempt(open([field]), { forward })), { port: 1455, paste: true })
  // 不用回调的打开授权页、设备码都不算
  assert.equal(callbackOf(attempt({ ...open([]), callbackPort: null }, { forward: null })), null)
  assert.equal(
    callbackOf(attempt({ kind: 'deviceCode', url: 'https://x', userCode: 'AB-CD', message: null })),
    null,
  )
  assert.equal(isLive(attempt(open([]))), true)
  assert.equal(isLive(attempt({ kind: 'failed', message: text('no') })), false)
})

test('值写成一小段字：没有、开关、选项的名字、列表、密钥、长 JSON 截断', () => {
  const spec = (type, options = []) => ({ type, options })
  assert.equal(valueText(spec('string'), null, zh), zh('hc.value.unset'))
  assert.equal(valueText(spec('boolean'), true, zh), zh('manage.value.on'))
  assert.equal(
    valueText(spec('enum', [{ value: 'hi', title: text('高'), description: null }]), 'hi', zh),
    '高',
  )
  assert.equal(valueText(spec('stringList'), ['a', 'b'], zh), 'a, b')
  assert.equal(valueText(spec('stringList'), [], zh), zh('hc.value.none'))
  assert.equal(valueText(spec('secret'), { set: true }, zh), zh('manage.secret.set'))
  const long = valueText(spec('json'), { text: 'x'.repeat(200) }, zh)
  assert.equal(long.length, 78)
  assert.ok(long.endsWith('…'))
})

test('分组：照声明的顺序，没声明分组的项和动作归进最后的“其他”，空组不出', () => {
  const data = {
    groups: [
      { id: 'defaults', title: text('默认'), description: null },
      { id: 'empty', title: text('空的'), description: null },
    ],
    settings: [
      { key: 'model', group: 'defaults' },
      { key: 'odd', group: 'nowhere' },
    ],
    actions: [{ id: 'reset', group: 'lost' }],
  }
  const groups = groupsOf(data, '其他')
  assert.deepEqual(
    groups.map(({ group, specs, actions }) => [
      group.id,
      specs.map((one) => one.key),
      actions.map((one) => one.id),
    ]),
    [
      ['defaults', ['model'], []],
      ['', ['odd'], ['reset']],
    ],
  )
})

test('页面状态：还在订、订不上或没连上、不支持、能用', () => {
  assert.equal(pageState(undefined), 'loading')
  assert.equal(pageState('error'), 'offline')
  assert.equal(pageState({ supported: null }), 'offline')
  assert.equal(pageState({ supported: false }), 'unsupported')
  assert.equal(pageState({ supported: true }), 'ready')
})
