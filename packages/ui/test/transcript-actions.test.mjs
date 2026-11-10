import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { transform } from 'esbuild'

const compiled = await Promise.all(
  ['actions', 'TurnActions'].map(
    async (name) =>
      (
        await transform(
          readFileSync(new URL(`../src/transcript/${name}.tsx`, import.meta.url), 'utf8'),
          { loader: 'tsx', format: 'cjs', jsx: 'automatic' },
        )
      ).code,
  ),
)

// 保留正式 Provider 和编辑按钮，只把 React 调度拆成渲染、布局两阶段。
// 首次挂载的消费者必须在布局副作用前就读到当前回合状态。
function fixture() {
  const slots = new Map()
  const contexts = new Map()
  let effects = []
  let owner
  let cursor = 0
  const react = {
    createContext(initial) {
      const context = { initial }
      context.Provider = { context }
      return context
    },
    useContext: (context) => (contexts.has(context) ? contexts.get(context) : context.initial),
    useState(initial) {
      const values = slots.get(owner) ?? []
      slots.set(owner, values)
      const at = cursor++
      if (!(at in values)) values[at] = typeof initial === 'function' ? initial() : initial
      return [values[at], (value) => (values[at] = value)]
    },
    useLayoutEffect: (effect) => effects.push(effect),
    useSyncExternalStore: (_subscribe, read) => read(),
  }
  const jsx = (type, props) => ({ type, props })
  const modules = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    '@litch/core': {
      keys: { session: () => 'meta', item: () => 'item', turn: () => 'turn' },
    },
    '../app/appearance.ts': { useT: () => (key) => key },
    '../app/errors.ts': { whyNot: String },
    '../app/icons.tsx': { Fork: () => null, Pencil: () => null },
    '../app/services.tsx': {
      useKey: (key) => (key === 'meta' ? { can: { rollback: true, fork: true } } : undefined),
      useServices: () => ({ channel: {}, replica: {} }),
    },
    '../app/toasts.tsx': { showToast() {} },
    './Stamp.tsx': { Stamp: () => null },
    './turn-actions.ts': { messageActions: () => ({ rollback: true, fork: true, cut: false }) },
  }
  const load = (code) => {
    const module = { exports: {} }
    runInNewContext(code, {
      module,
      require(name) {
        assert.ok(modules[name], `未声明依赖 ${name}`)
        return modules[name]
      },
    })
    return module.exports
  }
  const actions = load(compiled[0])
  modules['./actions.tsx'] = actions
  const { TurnActions } = load(compiled[1])
  const visit = (node) => {
    if (!node || typeof node !== 'object') return []
    if (Array.isArray(node)) return node.flatMap(visit)
    if (typeof node.type === 'function') {
      owner = node.type
      cursor = 0
      return visit(node.type(node.props))
    }
    const context = node.type?.context
    if (context) {
      const before = contexts.get(context)
      const had = contexts.has(context)
      contexts.set(context, node.props.value)
      const children = visit(node.props.children)
      if (had) contexts.set(context, before)
      else contexts.delete(context)
      return children
    }
    return [node, ...visit(node.props?.children)]
  }
  return {
    renderSessions(states) {
      return visit(
        states.map((busy, index) =>
          jsx(actions.ActionsProvider, {
            value: { busy },
            children: jsx(TurnActions, {
              deviceId: 'local',
              sessionId: `session-${index}`,
              turnId: 'history',
              itemId: 'message',
              steered: false,
              onEdit() {},
            }),
          }),
        ),
      ).filter((node) => node.props?.className === 'ibtn act-edit')
    },
    render(busy, show = true, open) {
      effects = []
      return visit(
        jsx(actions.ActionsProvider, {
          value: { busy, open },
          children: show
            ? jsx(TurnActions, {
                deviceId: 'local',
                sessionId: 'session',
                turnId: 'history',
                itemId: 'message',
                steered: false,
                onEdit() {},
              })
            : null,
        }),
      ).find((node) => node.props?.className === 'ibtn act-edit')
    },
    commit() {
      for (const effect of effects) effect()
    },
  }
}

test('回合在跑时首次挂载的历史编辑按钮第一帧即禁用，不等待布局副作用', () => {
  const view = fixture()
  view.render(false, false)
  view.commit()
  const button = view.render(true)
  assert.equal(button.props['aria-disabled'], true)
  assert.equal(button.props.title, 'turn.busy')
})

test('回合停止后首次挂载即允许编辑', () => {
  const stopped = fixture()
  stopped.render(true, false)
  stopped.commit()
  assert.equal(stopped.render(false).props['aria-disabled'], false)
})

test('同一页面的不同会话分别提供忙闲状态', () => {
  const view = fixture()
  assert.deepEqual(
    view.renderSessions([true, false]).map((button) => button.props['aria-disabled']),
    [true, false],
  )
  assert.deepEqual(
    view.renderSessions([false, true]).map((button) => button.props['aria-disabled']),
    [false, true],
  )
})
