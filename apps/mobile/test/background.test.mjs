import assert from 'node:assert/strict'
import { test } from 'node:test'
import { natives } from 'expo-modules-core'
import {
  backgroundMinutes,
  batteryState,
  openBatterySettings,
  setBackgroundMinutes,
  watchConnections,
} from '../src/platform/background.ts'

test('后台设置：默认、合法选项和从不', () => {
  for (const value of [undefined, '10', -1, 0, 11, NaN]) assert.equal(backgroundMinutes(value), 10)
  for (const value of [1, 5, 10, 30, 60, null]) assert.equal(backgroundMinutes(value), value)
  let configured
  natives.LitchSsh = {
    setBackgroundTimeout: (value) => {
      configured = value
    },
  }
  setBackgroundMinutes(null)
  assert.equal(configured, 0)
  setBackgroundMinutes(10)
  assert.equal(configured, 10)
})

test('生命周期：延迟送达的后台事件按原生最新状态处理，不补断前台连接', () => {
  let state = { revision: 0, background: false, suspended: false }
  let listener
  let removed = false
  natives.LitchSsh = {
    connectionPolicyState: () => JSON.stringify(state),
    addListener: (_, fn) => {
      listener = fn
      return {
        remove: () => {
          removed = true
        },
      }
    },
  }
  const pauses = []
  const unwatch = watchConnections((value) => pauses.push(value))
  state = { revision: 2, background: true, suspended: true }
  listener({ state: JSON.stringify(state) })
  state = { revision: 3, background: false, suspended: false }
  listener({ state: JSON.stringify({ revision: 2, suspended: true }) })
  listener({ state: JSON.stringify({ revision: 2, suspended: true }) })
  assert.deepEqual(pauses, [false, true, false])
  unwatch()
  assert.equal(removed, true)
})

test('系统电池设置：读取或跳转失败可显示人工指引，不假报成功', () => {
  natives.LitchSsh = {
    batteryOptimization: () => {
      throw new Error('unavailable')
    },
    openBackgroundSettings: () => {
      throw new Error('permission')
    },
  }
  assert.equal(batteryState(), 'unknown')
  assert.equal(openBatterySettings(), false)
  natives.LitchSsh = { batteryOptimization: () => 'exempt', openBackgroundSettings: () => true }
  assert.equal(batteryState(), 'exempt')
  assert.equal(openBatterySettings(), true)
})
