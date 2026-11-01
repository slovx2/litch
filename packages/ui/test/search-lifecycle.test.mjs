import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from '../../../node_modules/esbuild/lib/main.js'

// 只替换浏览器调度与 React 生命周期；索引投影、查询、取消逻辑均运行正式实现。
const bundle = await build({
  stdin: {
    contents: `export { useSearch } from './src/transcript/search/useSearch.ts';
      export { keys, ConversationSearch } from '@litch/core';`,
    resolveDir: new URL('..', import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  define: {
    'import.meta.url': JSON.stringify(
      new URL('../src/transcript/search/useSearch.ts', import.meta.url).href,
    ),
  },
  alias: { '@litch/core': new URL('../../core/src/index.mts', import.meta.url).pathname },
  plugins: [
    {
      name: 'search-lifecycle-fixture',
      setup(api) {
        api.onResolve(
          { filter: /^(react|.*app\/(appearance\.ts|services\.tsx))$/ },
          ({ path }) => ({ path, namespace: 'fixture' }),
        )
        api.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
          contents:
            path === 'react'
              ? `export const useRef=x=>globalThis.__searchLifecycle.ref(x);
             export const useState=x=>globalThis.__searchLifecycle.state(x);
             export const useEffect=(f,d)=>globalThis.__searchLifecycle.effect(f,d);`
              : path.endsWith('appearance.ts')
                ? `export const useT=()=>globalThis.__searchLifecycle.t;`
                : `export const useServices=()=>({replica:{store:globalThis.__searchLifecycle.store}});`,
        }))
      },
    },
  ],
})
const { useSearch, keys, ConversationSearch } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
)

function fixture() {
  const original = { window: globalThis.window, Worker: globalThis.Worker }
  const slots = [],
    effects = [],
    timers = new Map(),
    values = new Map(),
    subscriptions = new Map()
  const workers = []
  let cursor = 0,
    timerId = 0,
    query = ''
  const t = Object.assign((x) => x, { text: (x) => x })
  const store = {
    get: (key) => values.get(key),
    subscribe(key, fn) {
      const listeners = subscriptions.get(key) ?? new Set()
      subscriptions.set(key, listeners)
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
  const put = (key, value) => {
    values.set(key, value)
    for (const fn of subscriptions.get(key) ?? []) fn()
  }
  const state = {
    t,
    store,
    ref(value) {
      return (slots[cursor++] ??= { current: value })
    },
    state(value) {
      const slot = (slots[cursor++] ??= { value })
      return [
        slot.value,
        (next) => {
          slot.value = typeof next === 'function' ? next(slot.value) : next
        },
      ]
    },
    effect(fn, deps) {
      const slot = (slots[cursor++] ??= {})
      if (slot.deps && deps.every((d, i) => Object.is(d, slot.deps[i]))) return
      slot.deps = deps
      effects.push(() => {
        slot.cleanup?.()
        slot.cleanup = fn()
      })
    },
  }
  globalThis.__searchLifecycle = state
  globalThis.window = {
    setTimeout(fn, ms) {
      const id = ++timerId
      timers.set(id, { fn, ms })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
  }
  globalThis.Worker = class {
    index = new ConversationSearch((parts) => parts.map((p) => p.text).join('\n'))
    messages = []
    results = []
    terminated = false
    constructor() {
      workers.push(this)
    }
    postMessage(message) {
      if (this.failure) throw this.failure
      this.messages.push(message)
      if (message.type === 'update') this.index.update(message.sources, message.removed)
      else
        this.results.push(
          this.index.query(message.query, message.revision, message.order, message.anchor),
        )
    }
    deliver(result = this.results.shift()) {
      assert.ok(result)
      this.onmessage({ data: result })
    }
    terminate() {
      this.terminated = true
    }
  }
  const render = (next = query) => {
    query = next
    cursor = 0
    // 按固定顺序重放正式钩子的渲染与效果。
    const result = useSearch('d', 's', query)
    for (const effect of effects.splice(0)) effect()
    return result
  }
  put(keys.turnIds('d', 's'), ['t'])
  const items = Array.from({ length: 300 }, (_, i) => ({
    id: `u${i}`,
    kind: 'userMessage',
    text: '用户消息',
    attachments: [],
  }))
  put(keys.turn('d', 's', 't'), { id: 't', status: 'completed', itemIds: items.map((x) => x.id) })
  for (const item of items) put(keys.item('d', 's', item.id), item)
  const tick = async (ms) => {
    const entry = [...timers].find(([, timer]) => timer.ms === ms)
    assert.ok(entry, `应有 ${ms}ms 任务`)
    timers.delete(entry[0])
    entry[1].fn()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }
  const drain = async () => {
    for (let i = 0; timers.size && i < 30; i++) await tick(timers.values().next().value.ms)
    assert.equal(timers.size, 0, '任务必须收敛')
  }
  return {
    render,
    tick,
    drain,
    workers,
    put,
    timers,
    close() {
      for (const slot of slots) {
        slot.cleanup?.()
        slot.cleanup = undefined
      }
      globalThis.window = original.window
      globalThis.Worker = original.Worker
      delete globalThis.__searchLifecycle
    },
  }
}

test('建索引让出主线程时连续改词，取消旧批次后最终查询仍发送并清除忙状态', async () => {
  const f = fixture()
  try {
    f.render('旧查询')
    await f.tick(180)
    assert.equal(f.workers[0].messages.at(-1).sources.length, 128)
    f.render('过渡查询')
    f.render('用户消息')
    await f.drain()
    const worker = f.workers[0]
    assert.deepEqual(
      worker.results.map((r) => r.query),
      ['用户消息'],
    )
    assert.equal(f.render().busy, true)
    worker.deliver()
    assert.equal(f.render().busy, false)
    assert.equal(f.render().result.count, 300, '取消前后已传和未传的条目均不可遗漏')
  } finally {
    f.close()
  }
})

test('旧查询回包不能结束新查询；新回包到达后结束，追加数据仍可重新查询', async () => {
  const f = fixture()
  try {
    f.render('旧查询')
    await f.drain()
    f.render('用户消息')
    const worker = f.workers[0]
    worker.deliver()
    assert.equal(f.render().busy, true)
    await f.drain()
    worker.deliver()
    assert.equal(f.render().busy, false)
    assert.equal(f.render().result.count, 300)
    f.put(keys.item('d', 's', 'u0'), {
      id: 'u0',
      kind: 'userMessage',
      text: '已变更',
      attachments: [],
    })
    await f.drain()
    worker.deliver()
    assert.equal(f.render().result.count, 299)
  } finally {
    f.close()
  }
})

test('清空查询也结束忙状态；关闭时取消待发请求并忽略已在途的回包', async () => {
  const f = fixture()
  try {
    f.render('用户消息')
    await f.tick(180)
    f.render('')
    await f.drain()
    const worker = f.workers[0]
    assert.equal(worker.results.at(-1).query, '')
    worker.deliver()
    assert.equal(f.render().busy, false)
    assert.equal(f.render().result.count, 0)
    f.render('用户消息')
    await f.drain()
    f.render('尚未发送')
    f.close()
    assert.equal(f.timers.size, 0)
    assert.equal(worker.terminated, true)
    worker.deliver()
  } finally {
    f.close()
  }
})

test('索引投递失败必须结束忙状态并显示失败，不能永远停在正在搜索', async (t) => {
  const errors = []
  t.mock.method(console, 'error', (...args) => errors.push(args))
  const f = fixture()
  try {
    f.render('用户消息')
    f.workers[0].failure = new Error('隔离夹具：索引投递失败')
    await f.tick(180)
    assert.equal(f.render().busy, false)
    assert.equal(f.render().failed, true)
    assert.equal(errors.length, 1)
    assert.equal(errors[0][1], f.workers[0].failure)
  } finally {
    f.close()
  }
})

test('旧批次拒绝前已有新查询，旧错误不能覆盖新查询的结果与状态', async () => {
  const f = fixture()
  try {
    f.render('旧查询')
    const worker = f.workers[0]
    const post = worker.postMessage.bind(worker)
    worker.postMessage = () => {
      worker.postMessage = post
      queueMicrotask(() => f.render('用户消息'))
      throw new Error('隔离夹具：过期批次失败')
    }
    await f.tick(180)
    await f.drain()
    worker.deliver()
    assert.equal(f.render().failed, false)
    assert.equal(f.render().busy, false)
    assert.equal(f.render().result.count, 300)
  } finally {
    f.close()
  }
})
