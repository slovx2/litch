// 从真实 Toasts 组件取出行组件，控制 React 的状态/效果和时间，不等待墙钟。
// 对应 probe-session 的悬停七秒、离开后自动消失；窗口仍验归档、撤销与焦点。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from '../../../node_modules/esbuild/lib/main.js'

test('提示悬停或含焦点时不消失；离开后重新计满寿命，更新内容也重新计时', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const previous = globalThis.window
  globalThis.window = { setTimeout, clearTimeout }
  const state = []
  let cursor = 0
  let effects = []
  let cleanups = []
  let dependencies = []
  globalThis.__toastLifetime = {
    useState(initial) {
      const index = cursor++
      state[index] ??= initial
      return [state[index], (value) => (state[index] = value)]
    },
    useEffect(effect, deps) {
      effects.push({ effect, deps })
    },
  }
  const result = await build({
    stdin: {
      contents: `export { showToast, dismissToast, Toasts } from './src/app/toasts.tsx';
        export { offerUndo } from './src/sidebar/archive-undo.ts';`,
      resolveDir: new URL('..', import.meta.url).pathname,
    },
    bundle: true,
    write: false,
    format: 'esm',
    jsx: 'automatic',
    plugins: [
      {
        name: 'toast-fixture',
        setup(api) {
          const sources = {
            react: `export const useState=(x)=>globalThis.__toastLifetime.useState(x);
            export const useEffect=(f,deps)=>globalThis.__toastLifetime.useEffect(f,deps);
            export const useSyncExternalStore=(_,read)=>read();`,
            'react/jsx-runtime': 'export const jsx=(type,props)=>({type,props}),jsxs=jsx;',
            './appearance.ts': 'export const useT=()=>Object.assign(key=>key,{text:x=>x});',
            './icons.tsx': 'export const Close=()=>null;',
            '@litch/core': `export const keys={summary:(d,s)=>'summary:'+d+':'+s,archived:d=>'archived:'+d};`,
            '../app/errors.ts': 'export const reasonOf=()=>"测试错误";',
          }
          api.onResolve({ filter: /.*/ }, ({ path }) =>
            path in sources ? { path, namespace: 'toast-fixture' } : undefined,
          )
          api.onLoad({ filter: /.*/, namespace: 'toast-fixture' }, ({ path }) => ({
            contents: sources[path],
          }))
        },
      },
    ],
  })
  try {
    const { showToast, Toasts, dismissToast, offerUndo } = await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
    )
    let expired = 0
    offerUndo(
      { deviceId: 'local', sessionId: 'a', title: '已归档', reselect: false },
      {
        channel: { command: async () => {} },
        store: { get: () => undefined, subscribe: () => () => {} },
        select() {},
      },
    )
    const archived = Toasts().props.children[0].props.toast
    assert.equal(archived.lifeMs, 6000, '归档提示使用真实生产寿命')
    const toast = {
      ...archived,
      onGone() {
        archived.onGone()
        expired++
      },
    }
    // 按真实依赖变化提交效果，直接调用行上的事件处理器；依赖不变不能重计时。
    const render = () => {
      effects = []
      cursor = 0
      const entry = Toasts()?.props.children[0]
      if (!entry) {
        for (const cleanup of cleanups) cleanup?.()
        cleanups = []
        dependencies = []
        return null
      }
      const row = entry.type(entry.props)
      effects.forEach(({ effect, deps }, index) => {
        if (dependencies[index]?.every((value, at) => Object.is(value, deps[at]))) return
        cleanups[index]?.()
        dependencies[index] = deps
        cleanups[index] = effect()
      })
      return row.props
    }
    showToast(toast)
    let row = render()
    t.mock.timers.tick(5000)
    assert.ok(Toasts())
    row.onPointerEnter()
    row = render()
    t.mock.timers.tick(7000)
    assert.ok(Toasts(), '原探针的七秒悬停不能触发消失')
    assert.equal(expired, 0)
    row.onPointerLeave()
    render()
    t.mock.timers.tick(5999)
    assert.ok(Toasts(), '移开后计满一整个寿命，而非接着先前的五秒')
    t.mock.timers.tick(1)
    assert.equal(Toasts(), null)
    assert.equal(expired, 1)
    render()

    showToast(toast)
    row = render()
    row.onFocus()
    row = render()
    t.mock.timers.tick(7000)
    assert.ok(Toasts())
    row.onBlur({ currentTarget: { contains: () => true }, relatedTarget: {} })
    row = render()
    t.mock.timers.tick(7000)
    assert.ok(Toasts(), '焦点在提示内部移动不解除保持')
    row.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null })
    render()
    t.mock.timers.tick(5000)
    showToast({ ...toast, text: () => '两个已归档' })
    render()
    assert.equal(Toasts().props.children.length, 1, '同标识更新不叠加')
    t.mock.timers.tick(5999)
    assert.ok(Toasts())
    t.mock.timers.tick(1)
    assert.equal(Toasts(), null)
    assert.equal(expired, 2)
    render()

    showToast({ ...toast, lifeMs: 0 })
    row = render()
    t.mock.timers.tick(60_000)
    assert.ok(Toasts())
    dismissToast('archived')
    assert.equal(expired, 2, '动作主动收起不算过期')
    showToast(toast)
    row = render()
    let stopped = false
    row.onKeyDown({ key: 'Escape', stopPropagation: () => (stopped = true) })
    assert.equal(stopped, true)
    assert.equal(Toasts(), null)
    assert.equal(expired, 3)
  } finally {
    for (const cleanup of cleanups) cleanup?.()
    globalThis.window = previous
    delete globalThis.__toastLifetime
  }
})
