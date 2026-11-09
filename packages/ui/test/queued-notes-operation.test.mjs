import assert from 'node:assert/strict'
import test from 'node:test'
import { queuedNotesOperation } from '../src/tree/queued-notes-operation.ts'

function fixture() {
  const requests = []
  const channel = {
    command(name, params) {
      return new Promise((resolve, reject) => requests.push({ name, params, resolve, reject }))
    },
  }
  return { channel, requests, operation: queuedNotesOperation(channel, 'remote', 'parent') }
}

test('立即处理同步进入 busy，切页保留；重复点击共用请求，其他会话和设备互不影响', async () => {
  const { channel, requests, operation } = fixture()
  const changes = []
  const unsubscribe = operation.subscribe(() => changes.push(operation.snapshot()))
  const first = operation.start()
  assert.equal(operation.snapshot().busy, true)
  assert.equal(operation.start(), first)
  operation.dismiss()
  assert.equal(operation.snapshot().busy, true)
  unsubscribe()
  await Promise.resolve()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].name, 'session.queuedNotes.deliver')
  assert.deepEqual(requests[0].params, { deviceId: 'remote', sessionId: 'parent' })
  const reopened = queuedNotesOperation(channel, 'remote', 'parent')
  assert.equal(reopened.snapshot().busy, true)
  assert.equal(queuedNotesOperation(channel, 'local', 'parent').snapshot().busy, false)
  assert.equal(queuedNotesOperation(channel, 'remote', 'child').snapshot().busy, false)
  requests[0].resolve({ delivered: 'woken' })
  await first
  assert.deepEqual(reopened.snapshot(), { busy: false, error: null, notNow: false })
  assert.equal(changes.length, 1)
})

test('切页后的晚到失败保留并可重试；none 也提示；成功插话后清状态', async () => {
  const { channel, requests, operation } = fixture()
  const first = operation.start()
  await Promise.resolve()
  requests[0].reject(new Error('隔离设备拒绝投递'))
  await first
  const reopened = queuedNotesOperation(channel, 'remote', 'parent')
  assert.match(reopened.snapshot().error.message, /拒绝投递/)
  const second = reopened.start()
  await Promise.resolve()
  requests[1].resolve({ delivered: 'none' })
  await second
  assert.equal(reopened.snapshot().notNow, true)
  const third = reopened.start()
  await Promise.resolve()
  requests[2].resolve({ delivered: 'steered' })
  await third
  assert.deepEqual(reopened.snapshot(), { busy: false, error: null, notNow: false })
})

test('同步通道错误可恢复；队列已被其他客户端处理后可关闭残留错误', async () => {
  const operation = queuedNotesOperation(
    {
      command() {
        throw new Error('离线')
      },
    },
    'd',
    's',
  )
  await operation.start()
  assert.equal(operation.snapshot().busy, false)
  assert.equal(operation.snapshot().error.message, '离线')
  operation.dismiss()
  assert.deepEqual(operation.snapshot(), { busy: false, error: null, notNow: false })
})
