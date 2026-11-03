import assert from 'node:assert/strict'
import test from 'node:test'
import { createBreathClock } from '../src/ui/kit/breath-state.ts'

function setup(active = true) {
  const calls = { starts: 0, stops: 0, resets: 0, activeListeners: 0, reducedListeners: 0 }
  let onActive
  let onReduced
  const reads = []
  const clock = createBreathClock({
    active: () => active,
    reduced: () => new Promise((resolve, reject) => reads.push({ resolve, reject })),
    onActive: (change) => {
      calls.activeListeners++
      onActive = change
      return () => calls.activeListeners--
    },
    onReduced: (change) => {
      calls.reducedListeners++
      onReduced = change
      return () => calls.reducedListeners--
    },
    start: () => {
      calls.starts++
      return () => calls.stops++
    },
    reset: () => calls.resets++,
  })
  return {
    clock,
    calls,
    reads,
    active: (value) => onActive(value),
    reduced: (value) => onReduced(value),
    read: async (value, index = 0) => {
      reads[index].resolve(value)
      await Promise.resolve()
    },
  }
}

test('没有运行记号不动；运行时启动；结束释放后立即停并恢复完整不透明度', async () => {
  const f = setup()
  assert.equal(f.calls.starts, 0)
  const end = f.clock.retain()
  assert.equal(f.calls.starts, 0, '读取系统设置前保持静态')
  await f.read(false)
  assert.equal(f.calls.starts, 1)
  end()
  assert.equal(f.calls.stops, 1)
  assert.equal(f.calls.resets, 1)
  assert.equal(f.calls.activeListeners, 0)
  assert.equal(f.calls.reducedListeners, 0)
  end()
  assert.equal(f.calls.stops, 1, '重复清理不破坏引用计数')
})

test('500 个运行记号共用一份动画和系统订阅，最后一条结束才停', async () => {
  const f = setup()
  const ends = Array.from({ length: 500 }, () => f.clock.retain())
  await f.read(false)
  assert.equal(f.calls.starts, 1)
  assert.equal(f.calls.activeListeners, 1)
  assert.equal(f.calls.reducedListeners, 1)
  for (const end of ends.slice(0, -1)) end()
  assert.equal(f.calls.stops, 0)
  ends.at(-1)()
  assert.equal(f.calls.stops, 1)
})

test('开启减弱动态时始终静态，设置即时切换会停止或恢复', async () => {
  const f = setup()
  const end = f.clock.retain()
  await f.read(true)
  assert.equal(f.calls.starts, 0)
  assert.equal(f.calls.resets, 1)
  f.reduced(false)
  assert.equal(f.calls.starts, 1)
  f.reduced(true)
  assert.equal(f.calls.stops, 1)
  assert.equal(f.calls.resets, 2)
  end()
})

test('退到后台立即停，回前台恢复；重复前台事件不重启', async () => {
  const f = setup()
  const end = f.clock.retain()
  await f.read(false)
  f.active(false)
  assert.equal(f.calls.stops, 1)
  assert.equal(f.calls.resets, 1)
  f.active(true)
  f.active(true)
  assert.equal(f.calls.starts, 2)
  f.reduced(true)
  f.active(false)
  f.active(true)
  assert.equal(f.calls.starts, 2, '减弱动态优先于前台状态')
  end()
})

test('后台挂载不会启动，回前台才开始', async () => {
  const f = setup(false)
  const end = f.clock.retain()
  await f.read(false)
  assert.equal(f.calls.starts, 0)
  f.active(true)
  assert.equal(f.calls.starts, 1)
  end()
})

test('初始查询迟到不能覆盖新设置，也不能复活已结束的动画', async () => {
  const f = setup()
  const end = f.clock.retain()
  f.reduced(true)
  await f.read(false)
  assert.equal(f.calls.starts, 0)
  end()
  const endAgain = f.clock.retain()
  endAgain()
  const endNew = f.clock.retain()
  await f.read(false, 1)
  assert.equal(f.calls.starts, 0, '上一轮卸载后到达的查询应丢弃')
  await f.read(false, 2)
  assert.equal(f.calls.starts, 1)
  endNew()
})

test('系统设置读取失败时保守保持静态，后续事件仍可恢复', async () => {
  const f = setup()
  const end = f.clock.retain()
  f.reads[0].reject(new Error('不可读'))
  await Promise.resolve()
  assert.equal(f.calls.starts, 0)
  f.reduced(false)
  assert.equal(f.calls.starts, 1)
  end()
})
