import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ForegroundWatch,
  INPUT_ACTIVATION_MS,
  type LeasedTab,
  OPENED_FOCUS_MS,
} from '../src/foreground.mjs'

const leased: LeasedTab[] = [{ tabId: 7, leaseId: 'lease-7', windowId: 1 }]
const setup = () => {
  let now = 1_000
  const watch = new ForegroundWatch(() => now)
  watch.focused = false
  return { watch, advance: (ms: number) => (now += ms) }
}

test('受控标签代理输入后打开的新页面激活 Chrome 时报告一次', () => {
  const { watch, advance } = setup()
  watch.input(7)
  advance(50)
  watch.tabCreated({ id: 8, openerTabId: 7, windowId: 1 })
  advance(20)
  assert.equal(watch.focus(1), true)
  assert.deepEqual(watch.stolen({ id: 8 }, leased), { tabId: 7, leaseId: 'lease-7' })
  // 同一次打开只报一次；Chrome 已在前台时再获得焦点不算抢。
  assert.equal(watch.stolen({ id: 8 }, leased), null)
  assert.equal(watch.focus(1), false)
  assert.equal(watch.focus(-1), false)
  assert.equal(watch.focus(1), true)
})

test('受控标签是后台标签时 opener 记成活动标签，按所在窗口认出来源', () => {
  const { watch } = setup()
  watch.input(7)
  // 同窗口新标签：opener 是窗口里的活动标签 3。
  watch.tabCreated({ id: 8, openerTabId: 3, windowId: 1 })
  assert.deepEqual(watch.stolen({ id: 8 }, leased), { tabId: 7, leaseId: 'lease-7' })
  // 新窗口弹窗：新标签不在受控窗口，按 opener 所在窗口找。
  watch.tabCreated({ id: 9, openerTabId: 3, windowId: 2 })
  assert.equal(watch.stolen({ id: 9 }, leased), null)
  watch.tabCreated({ id: 10, openerTabId: 3, windowId: 2 })
  assert.deepEqual(watch.stolen({ id: 10 }, leased, 1), { tabId: 7, leaseId: 'lease-7' })
})

test('Chrome 本来就在前台或焦点未知时不算抢', () => {
  for (const focused of [true, null]) {
    const { watch } = setup()
    watch.focused = focused
    assert.equal(watch.focus(1), false)
  }
})

test('外部打开、过期输入、迟到的焦点或与受控标签无关的页面都不报告', () => {
  {
    // 别的应用让 Chrome 打开链接：新标签没有 opener。
    const { watch } = setup()
    watch.input(7)
    watch.tabCreated({ id: 8, windowId: 1 })
    assert.equal(watch.stolen({ id: 8 }, leased), null)
  }
  {
    // 没有代理输入：用户自己在受控标签里点开的新页面。
    const { watch } = setup()
    watch.tabCreated({ id: 8, openerTabId: 7, windowId: 1 })
    assert.equal(watch.stolen({ id: 8 }, leased), null)
  }
  {
    const { watch, advance } = setup()
    watch.input(7)
    advance(INPUT_ACTIVATION_MS + 1)
    watch.tabCreated({ id: 8, openerTabId: 7, windowId: 1 })
    assert.equal(watch.stolen({ id: 8 }, leased), null)
  }
  {
    // 新页面打开很久以后用户自己切到 Chrome。
    const { watch, advance } = setup()
    watch.input(7)
    watch.tabCreated({ id: 8, openerTabId: 7, windowId: 1 })
    advance(OPENED_FOCUS_MS + 1)
    assert.equal(watch.stolen({ id: 8 }, leased), null)
  }
  {
    // 别的窗口里的页面，且与受控窗口无关；或获得焦点的是受控标签自己（show）。
    const { watch } = setup()
    watch.input(7)
    watch.tabCreated({ id: 8, openerTabId: 4, windowId: 5 })
    assert.equal(watch.stolen({ id: 8 }, leased, 5), null)
    assert.equal(watch.stolen({ id: 7 }, leased), null)
  }
})

test('标签关闭后忘掉记录', () => {
  const { watch } = setup()
  watch.input(7)
  watch.tabCreated({ id: 8, openerTabId: 7, windowId: 1 })
  assert.equal(watch.openerOf(8), 7)
  watch.forget(8)
  assert.equal(watch.openerOf(8), undefined)
  assert.equal(watch.stolen({ id: 8 }, leased), null)
})
