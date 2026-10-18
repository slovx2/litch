// Windows 上动作参数的换算（win-params.mts）：编号换 ref、坐标带截图号、元素换中心坐标、键名拆开。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AXLine } from '../ax-text.mjs'
import { parseKey, parseModifiers, type WinParamState, winActionParams } from '../win-params.mjs'
import { HelperError } from '../wire.mjs'

const lines = new Map<number, AXLine>([
  [
    3,
    {
      index: 3,
      depth: 1,
      content: 'Document "Text editor"',
      ref: '42.7',
      frame: { x: 10, y: 20, width: 100, height: 40 },
    },
  ],
  [4, { index: 4, depth: 1, content: 'Button "Save"', ref: '42.8' }],
])
const state: WinParamState = { lines, shot: { id: 'shot-9', width: 800, height: 600 } }
const noShot: WinParamState = { lines, shot: null }

function invalid(run: () => unknown, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof HelperError)
    assert.equal(error.kind, 'invalid')
    assert.match(error.message, pattern)
    return true
  })
}

test('click：编号换成 ref；坐标带上截图号并查边界；修饰键拆成数组', () => {
  assert.deepEqual(winActionParams('click', { element: 3 }, state), {
    method: 'click',
    params: { ref: '42.7', button: 'left', count: 1 },
    summary: 'Clicked [3] Document "Text editor" (left, 1x).',
  })
  const atPoint = winActionParams(
    'click',
    { x: 12.5, y: 30, button: 'right', count: 2, modifiers: 'Ctrl + shift' },
    state,
  )
  assert.deepEqual(atPoint.params, {
    screenshotId: 'shot-9',
    x: 12.5,
    y: 30,
    button: 'right',
    count: 2,
    modifiers: ['ctrl', 'shift'],
  })
  invalid(() => winActionParams('click', { x: 800, y: 1 }, state), /outside the screenshot/)
  invalid(() => winActionParams('click', { x: 1, y: 1 }, noShot), /get_app_state first/)
  invalid(() => winActionParams('click', { element: 9 }, state), /not in the latest state/)
  invalid(() => winActionParams('click', {}, state), /element or both x and y/)
  invalid(() => winActionParams('click', { element: 3, modifiers: 'win' }, state), /Windows key/)
  invalid(() => winActionParams('click', { element: 3, count: 4 }, state), /count/)
})

test('drag：元素换成中心的截图坐标，和坐标混用；没有截图不行', () => {
  const drag = winActionParams('drag', { from_element: 3, to_x: 400, to_y: 300 }, state)
  assert.deepEqual(drag.params, {
    screenshotId: 'shot-9',
    from: { x: 60, y: 40 },
    to: { x: 400, y: 300 },
  })
  invalid(
    () => winActionParams('drag', { from_element: 4, to_x: 1, to_y: 1 }, state),
    /no position/,
  )
  invalid(() => winActionParams('drag', { from_x: 1, from_y: 1 }, state), /to_element/)
  invalid(
    () => winActionParams('drag', { from_element: 3, to_element: 3 }, noShot),
    /get_app_state/,
  )
})

test('press_key：拆成键和修饰键；cmd 原样交给助手；Windows 键先拒', () => {
  assert.deepEqual(parseKey('ctrl+shift+t'), { key: 't', modifiers: ['ctrl', 'shift'] })
  assert.deepEqual(parseKey('Return'), { key: 'Return', modifiers: [] })
  assert.deepEqual(parseKey('ctrl++'), { key: '+', modifiers: ['ctrl'] })
  assert.deepEqual(parseKey('cmd+s'), { key: 's', modifiers: ['cmd'] })
  invalid(() => parseKey('win+r'), /Windows key/)
  invalid(() => parseKey('Win'), /Windows key/)
  invalid(() => parseKey('ctrl+'), /no key/)
  assert.deepEqual(parseModifiers(undefined), [])
  const press = winActionParams('press_key', { key: 'alt+F4', repeat: 2 }, state)
  assert.deepEqual(press, {
    method: 'pressKey',
    params: { key: 'F4', modifiers: ['alt'], repeat: 2 },
    summary: 'Pressed alt+F4 2 times.',
  })
})

test('type_text、scroll、set_value、select_text', () => {
  assert.deepEqual(winActionParams('type_text', { text: '你好\n', element: 3 }, state), {
    method: 'typeText',
    params: { text: '你好\n', ref: '42.7' },
    summary: 'Typed 3 characters.',
  })
  assert.deepEqual(winActionParams('scroll', { direction: 'down' }, noShot).params, {
    direction: 'down',
    amount: 5,
  })
  assert.deepEqual(winActionParams('scroll', { direction: 'up', x: 5, y: 6 }, state).params, {
    direction: 'up',
    amount: 5,
    screenshotId: 'shot-9',
    x: 5,
    y: 6,
  })
  invalid(() => winActionParams('scroll', { direction: 'sideways' }, state), /direction/)
  assert.deepEqual(winActionParams('set_value', { element: 3, value: 'x' }, state).params, {
    ref: '42.7',
    value: 'x',
  })
  invalid(() => winActionParams('set_value', { value: 'x' }, state), /element must be/)
  assert.deepEqual(winActionParams('select_text', { element: 3, text: 'abc' }, state), {
    method: 'selectText',
    params: { ref: '42.7', text: 'abc' },
    summary: 'Selected 3 characters in [3].',
  })
  assert.deepEqual(
    winActionParams('select_text', { element: 3, start: 2, length: 4 }, state).params,
    { ref: '42.7', start: 2, length: 4 },
  )
  invalid(() => winActionParams('select_text', { element: 3, start: 2 }, state), /start and length/)
})
