// 执行真实菜单组件，只替换 RN 绘制和 React hooks，保留实际评论中枢与草稿行为。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { transformSync } from '../../../node_modules/esbuild/lib/main.js'
import { CommentsHub, notePressed, pressedItem } from '../src/detail/comments/hub.ts'

function menu(hub) {
  const source = transformSync(
    readFileSync(new URL('../src/detail/turn-menu.tsx', import.meta.url), 'utf8'),
    { loader: 'tsx', format: 'cjs', jsx: 'automatic' },
  ).code
  const element = (type, props) => ({ type, props })
  const module = { exports: {} }
  const modules = {
    react: { useState: () => [null, () => {}], useSyncExternalStore: (_, snapshot) => snapshot() },
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': { StyleSheet: { create: (styles) => styles } },
    '../ui/i18n': { useT: () => (key) => key },
    '../ui/kit/overlays': { Sheet: 'sheet' },
    '../shell/services': { useChannel: () => ({}) },
    './comments/context': { useComments: () => hub },
    './comments/hub': { pressedItem },
    './turn-target': { turnTarget: () => null },
  }
  runInNewContext(source, { module, require: (name) => modules[name] ?? {} })
  const store = {
    deviceId: 'nebula',
    sessionId: 'selection',
    getMeta: () => null,
    kindOf: () => 'agentMessage',
  }
  notePressed('turn', 'answer')
  const tree = module.exports.TurnMenu({
    store,
    turnId: 'turn',
    onClose() {},
    onForked() {},
    say() {},
  })
  return tree.props.children.find((node) => node.type === 'sheet').props.actions
}

test('选择文字原地启用选字，不打开评论编辑器；回复后仍能写评论', () => {
  const hub = new CommentsHub(/** @type {any} */ ({}), 'selection-nebula')
  const action = menu(hub).find((entry) => entry.testID === 'menu:select')
  assert.equal(action.afterDismiss, true, 'iOS 等原菜单关闭后再启用原消息的选字')
  action.onPress()
  assert.equal(hub.selecting, 'answer')
  assert.equal(hub.replying, null)
  assert.equal(hub.reply('answer', '选中的星云文本'), true)
  assert.equal(hub.selecting, null)
  assert.deepEqual(hub.replying, { itemId: 'answer', quote: '选中的星云文本' })
  hub.replied(null)
  assert.equal(hub.replying, null)
})

test('评论这条消息保持直接打开评论框，不进入选字', () => {
  const hub = new CommentsHub(
    /** @type {any} */ ({ itemText: () => '星云回答全文' }),
    'comment-nebula',
  )
  const action = menu(hub).find((entry) => entry.testID === 'menu:comment')
  assert.equal(action.afterDismiss, true)
  action.onPress()
  assert.equal(hub.selecting, null)
  assert.deepEqual(hub.replying, { itemId: 'answer', quote: '星云回答全文' })
})
