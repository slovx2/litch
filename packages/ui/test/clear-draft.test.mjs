import assert from 'node:assert/strict'
import { test } from 'node:test'
import { draftShortcut, hasDraft } from '../src/composer/clear-draft.ts'

const key = (patch = {}) => ({
  key: 'c',
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  keyCode: 67,
  ...patch,
})

test('清空只在 macOS Ctrl+C 生效，Cmd+C 和其他系统复制保持原生行为', () => {
  assert.equal(draftShortcut('mac', key()), 'clear')
  assert.equal(draftShortcut('mac', key({ ctrlKey: false, metaKey: true })), null)
  for (const platform of ['win', 'linux']) assert.equal(draftShortcut(platform, key()), null)
  assert.equal(draftShortcut('mac', key({ key: 'z', ctrlKey: false, metaKey: true })), 'undo')
})

test('组字、229 键码与其他修饰键不触发清空或撤销', () => {
  for (const patch of [
    { isComposing: true },
    { keyCode: 229 },
    { altKey: true },
    { shiftKey: true },
    { metaKey: true },
  ]) {
    assert.equal(draftShortcut('mac', key(patch)), null)
  }
  assert.equal(
    draftShortcut('mac', key({ key: 'z', ctrlKey: false, metaKey: true, isComposing: true })),
    null,
  )
})

test('草稿包括文字、图片、附带片、评论与差异批注；只有这些都为空才算空', () => {
  const empty = { text: '', images: [], extras: [], comments: [], notes: [] }
  assert.equal(hasDraft(empty), false)
  assert.equal(hasDraft({ ...empty, text: ' ' }), true)
  for (const field of ['images', 'extras', 'comments', 'notes'])
    assert.equal(hasDraft({ ...empty, [field]: [{}] }), true)
})
