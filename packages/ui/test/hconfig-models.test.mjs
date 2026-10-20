// 模型清单这一块不靠浏览器就能测的：上下文窗口写短和读回来、原样用还是以谁为底稿、开始自定义导入整份目录、
// 上下移动、表单校验（模型名必填且唯一、上下文是正整数）、按名字筛底稿。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const {
  shortWindow,
  parseWindow,
  asIs,
  resolved,
  importAll,
  moved,
  sameEntries,
  formOfEntry,
  entryOfForm,
  filterBases,
} = await import('../src/devices/hconfig/models.ts')

const bases = [
  { id: 'gpt-5.5', displayName: 'GPT-5.5', contextWindow: 400_000, description: null },
  { id: 'gpt-5.5-mini', displayName: 'GPT-5.5 mini', contextWindow: null, description: null },
  { id: 'o5-pro', displayName: 'o5 pro', contextWindow: 200_000, description: 'deep' },
]

test('上下文窗口写短', () => {
  assert.equal(shortWindow(200_000), '200K')
  assert.equal(shortWindow(1_000_000), '1M')
  assert.equal(shortWindow(1_047_576), '1.05M')
  assert.equal(shortWindow(272_000), '272K')
  assert.equal(shortWindow(128_500), '128.5K')
  assert.equal(shortWindow(512), '512')
})

test('上下文窗口读回来：整数、分组符、K 和 M；空的照底稿；别的不认', () => {
  assert.deepEqual(parseWindow(''), { ok: true, value: null })
  assert.deepEqual(parseWindow(' 200000 '), { ok: true, value: 200_000 })
  assert.deepEqual(parseWindow('1,000,000'), { ok: true, value: 1_000_000 })
  assert.deepEqual(parseWindow('200k'), { ok: true, value: 200_000 })
  assert.deepEqual(parseWindow('1.5M'), { ok: true, value: 1_500_000 })
  for (const bad of ['0', '-1', '1.5', 'abc', '1e6', '12KB']) {
    assert.equal(parseWindow(bad).ok, false, bad)
  }
})

test('原样用还是以谁为底稿；显示名和上下文照底稿补上', () => {
  const same = { id: 'gpt-5.5', displayName: null, contextWindow: null, base: 'gpt-5.5' }
  const custom = { id: 'team/x', displayName: null, contextWindow: 1_000_000, base: 'gpt-5.5' }
  assert.equal(asIs(same), true)
  assert.equal(asIs(custom), false)
  assert.equal(asIs({ ...same, contextWindow: 1 }), false, '同名但改了上下文也算自定义')
  assert.deepEqual(resolved(custom, bases).name, 'GPT-5.5')
  assert.equal(resolved(custom, bases).window, 1_000_000)
  assert.equal(resolved({ ...same, base: 'gone', id: 'gone' }, bases).base, null)
})

test('开始自定义：整份导成原样用的项；挪动；比较', () => {
  const all = importAll(bases)
  assert.deepEqual(
    all.map((one) => [one.id, one.base, asIs(one)]),
    [
      ['gpt-5.5', 'gpt-5.5', true],
      ['gpt-5.5-mini', 'gpt-5.5-mini', true],
      ['o5-pro', 'o5-pro', true],
    ],
  )
  assert.deepEqual(
    moved(all, 2, -1).map((one) => one.id),
    ['gpt-5.5', 'o5-pro', 'gpt-5.5-mini'],
  )
  assert.deepEqual(
    moved(all, 0, -1).map((one) => one.id),
    all.map((one) => one.id),
  )
  assert.equal(sameEntries(all, importAll(bases)), true)
  assert.equal(sameEntries(all, moved(all, 0, 1)), false)
})

test('表单：原样用不能和清单里重复；自定义要模型名、唯一、上下文合规矩', () => {
  const taken = new Set(['gpt-5.5'])
  // 新增时默认挑头一个还不在清单里的；都在了就改成以头一个为底稿自定义
  assert.equal(formOfEntry(null, bases, taken).base, 'gpt-5.5-mini')
  assert.deepEqual(formOfEntry(null, bases, new Set(bases.map((one) => one.id))), {
    base: 'gpt-5.5',
    mode: 'custom',
    id: 'gpt-5.5',
    displayName: '',
    contextWindow: '',
  })
  const blank = formOfEntry(null, bases)
  assert.equal(blank.base, 'gpt-5.5')
  assert.deepEqual(entryOfForm(blank, bases, taken), {
    ok: false,
    problem: 'hc.models.bad.taken',
    field: 'base',
  })
  assert.deepEqual(entryOfForm({ ...blank, base: 'o5-pro' }, bases, taken), {
    ok: true,
    entry: { id: 'o5-pro', displayName: null, contextWindow: null, base: 'o5-pro' },
  })
  const custom = { ...blank, mode: 'custom' }
  assert.equal(entryOfForm({ ...custom, id: '  ' }, bases, taken).problem, 'hc.models.bad.id')
  assert.equal(
    entryOfForm({ ...custom, id: 'gpt-5.5' }, bases, taken).problem,
    'hc.models.bad.taken',
  )
  assert.equal(
    entryOfForm({ ...custom, id: 'x', contextWindow: '1.5' }, bases, taken).problem,
    'hc.models.bad.window',
  )
  assert.deepEqual(
    entryOfForm(
      { ...custom, id: ' team/long ', displayName: ' 长 ', contextWindow: '1M' },
      bases,
      taken,
    ),
    {
      ok: true,
      entry: { id: 'team/long', displayName: '长', contextWindow: 1_000_000, base: 'gpt-5.5' },
    },
  )
  assert.equal(entryOfForm({ ...blank, base: 'nope' }, bases, taken).problem, 'hc.models.bad.base')
  // 改一项时表单从那一项来
  const back = formOfEntry(
    { id: 'team/long', displayName: null, contextWindow: 1_000_000, base: 'gpt-5.5' },
    bases,
  )
  assert.deepEqual(back, {
    base: 'gpt-5.5',
    mode: 'custom',
    id: 'team/long',
    displayName: '',
    contextWindow: '1000000',
  })
})

test('按名字筛底稿：模型名和显示名都算，几个词都要对上', () => {
  assert.deepEqual(
    filterBases(bases, 'gpt mini').map((one) => one.id),
    ['gpt-5.5-mini'],
  )
  assert.deepEqual(
    filterBases(bases, 'PRO').map((one) => one.id),
    ['o5-pro'],
  )
  assert.equal(filterBases(bases, '  ').length, 3)
})
