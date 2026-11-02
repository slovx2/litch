import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSubmittedHistory } from '../src/composer/submitted-history.ts'

test('发送即记原文：停止、排队和消息回显不会改掉输入历史', () => {
  let raw = null
  const storage = {
    read: () => raw,
    write: (value) => {
      raw = value
    },
  }
  const history = createSubmittedHistory(storage)
  history.add('device:session', '第一条')
  history.add('device:session', '插话 @[同事]')
  history.add('device:session', '排队')
  assert.deepEqual(history.read('device:session'), ['第一条', '插话 @[同事]', '排队'])
  assert.deepEqual(
    createSubmittedHistory(storage).read('device:session'),
    history.read('device:session'),
  )
  assert.deepEqual(history.read('other:session'), [])
})

test('只接收提交原文，后台通知、技能展开、评论和会话注入不从对话反推', () => {
  const history = createSubmittedHistory({ read: () => null, write() {} })
  history.add('s', '请用 /skill 看 @[同事]')
  history.add('s', '  **保留空白**\n第二行')
  // 对话可以任意刷新甚至为空；历史的输入只来自提交动作。
  assert.deepEqual(history.read('s'), ['请用 /skill 看 @[同事]', '  **保留空白**\n第二行'])
  history.add('s', '请用 /skill 看 @[同事]')
  history.add('s', '')
  assert.deepEqual(history.read('s'), ['  **保留空白**\n第二行', '请用 /skill 看 @[同事]'])
})

test('存储不可写时仍保留本次输入，读出的数组不能修改历史', () => {
  const history = createSubmittedHistory({
    read: () => {
      throw Error()
    },
    write: () => {
      throw Error()
    },
  })
  history.add('s', '不能丢')
  history.read('s').pop()
  assert.deepEqual(history.read('s'), ['不能丢'])
})

test('每会话保留最近一百条、最多二百个会话，重复原文移到最新位置', () => {
  const history = createSubmittedHistory({ read: () => null, write() {} })
  for (let i = 0; i < 101; i++) history.add('s', `第${i}条`)
  assert.equal(history.read('s').length, 100)
  assert.equal(history.read('s')[0], '第1条')
  history.add('s', '第1条')
  assert.equal(history.read('s').at(-1), '第1条')
  assert.equal(history.read('s').length, 100)
  for (let i = 0; i < 200; i++) history.add(`other${i}`, '另一会话')
  assert.deepEqual(history.read('s'), [])
  assert.deepEqual(history.read('other199'), ['另一会话'])
})
