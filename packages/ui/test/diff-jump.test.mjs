import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { transform } from 'esbuild'

// 执行实际组件；只替换通道、绘制和 React 调度，手动推进刷新回包与中间渲染，不靠计时。
const { code } = await transform(
  `${readFileSync(new URL('../src/diff/DiffTab.tsx', import.meta.url), 'utf8')}\nexport { Diffs }`,
  { loader: 'tsx', format: 'cjs', jsx: 'automatic' },
)

function fixture(source = 'git') {
  const slots = []
  let cursor = 0
  let effects = []
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const memo = (make, deps) => {
    const index = cursor++
    if (!slots[index] || !same(slots[index].deps, deps)) {
      slots[index] = { value: make(), deps }
    }
    return slots[index].value
  }
  const effect = (run, deps) => {
    const index = cursor++
    if (!slots[index] || !same(slots[index].deps, deps)) effects.push(run)
    slots[index] = { deps }
  }
  const react = {
    useRef: (value) => memo(() => ({ current: value }), []),
    useMemo: memo,
    useCallback: (value, deps) => memo(() => value, deps),
    useEffect: effect,
    useLayoutEffect: effect,
    useState: (initial) => {
      const index = cursor++
      slots[index] ??= { value: initial }
      return [
        slots[index].value,
        (next) => {
          slots[index].value = typeof next === 'function' ? next(slots[index].value) : next
        },
      ]
    },
  }
  let wanted = null
  let view = { phase: 'ready', source, entries: [], version: 1, refreshing: false }
  const place = { scope: 'all', picked: null, query: '', closed: new Set() }
  const toasts = []
  const pending = []
  const channel = {
    command: (name) => {
      assert.equal(name, 'diff.refresh')
      return new Promise((resolve, reject) => pending.push({ resolve, reject }))
    },
  }
  const services = { channel, replica: { openDiff: () => () => {} } }
  const modules = {
    react,
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null },
    '@litch/core': {
      keys: { device: () => 'device', diff: () => 'diff', diffError: () => 'error' },
      normalizePath: (path) => path,
      isAbsolutePath: (path) => path.startsWith('/'),
    },
    '../app/services.tsx': {
      useServices: () => services,
      useKey: (key) => (key === 'diff' ? view : null),
    },
    '../app/appearance.ts': { useT: () => (key) => key },
    '../app/toasts.tsx': { showToast: (toast) => toasts.push(toast.id) },
    './annotations.ts': { useNotes: () => [] },
    './data.ts': { useDiffFiles: () => ({ files: [], state: 'ready' }) },
    './model.ts': { totalsOf: () => ({}), planOf: () => 'together', tooBig: () => false },
    './state.ts': {
      placeKey: () => 'place',
      usePlaceState: () => place,
      useDiffPrefs: () => ({ layout: 'unified' }),
      useWanted: () => wanted,
      setPlaceState: (_key, patch) => Object.assign(place, patch),
    },
  }
  const output = { exports: {} }
  runInNewContext(code, { module: output, require: (name) => modules[name] ?? {} })
  function render() {
    cursor = 0
    effects = []
    output.exports.Diffs({ deviceId: 'local', root: '/repo', sessionId: null, shown: true })
    for (const run of effects) run()
  }
  return {
    place,
    toasts,
    pending,
    jump(nonce, path) {
      wanted = { nonce, path }
      render()
    },
    publish(paths) {
      view = { ...view, entries: paths.map((path) => ({ path })), version: view.version + 1 }
      render()
    },
    async finish(index) {
      pending[index].resolve({})
      // command().catch().finally() 的微任务完成后再渲染。
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      render()
    },
  }
}

test('连续跳转第二个新文件：刷新未回包时不借上次完成状态报不存在', async () => {
  const f = fixture()
  f.jump(1, 'a.txt')
  f.publish(['a.txt'])
  await f.finish(0)
  assert.equal(f.place.picked, 'a.txt')

  f.jump(2, 'b.txt')
  assert.equal(f.pending.length, 2)
  // 核心的另一份旧概况先触发渲染，本次刷新还没回包、refreshing 也尚未投递。
  f.publish(['a.txt'])
  assert.deepEqual(f.toasts, [])
  f.publish(['a.txt', 'b.txt'])
  await f.finish(1)
  assert.equal(f.place.picked, 'b.txt')
  assert.deepEqual(f.toasts, [])
})

test('先前刷新迟到：只有当前跳转的刷新完成才能报文件不存在', async () => {
  const f = fixture()
  f.jump(1, 'a.txt')
  f.jump(2, 'missing.txt')
  await f.finish(0)
  assert.deepEqual(f.toasts, [])
  await f.finish(1)
  f.publish([])
  assert.deepEqual(f.toasts, ['diff-wanted'])
})

test('刷新回包早于订阅增量：旧概况不能把刚写出的文件判为不存在', async () => {
  const f = fixture()
  f.jump(1, 'new.txt')
  await f.finish(0)
  assert.deepEqual(f.toasts, [])
  f.publish(['new.txt'])
  assert.equal(f.place.picked, 'new.txt')
  assert.deepEqual(f.toasts, [])
})

test('回合差异不随 git 刷新增加版本，缺失文件仍能正常提示', async () => {
  const f = fixture('turn')
  f.jump(1, 'missing.txt')
  await f.finish(0)
  assert.deepEqual(f.toasts, ['diff-wanted'])
})
