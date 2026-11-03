import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installFileSave } from '../file-save-main.mjs'
import { choose, events, handlers, opened, shown } from './file-save-electron.mjs'

const frame = { url: 'app://litch' }
const sent: unknown[] = [],
  updates: unknown[] = []
const owner = {
  mainFrame: frame,
  isDestroyed: () => false,
  send: (_name: string, value: unknown) => updates.push(value),
  once() {},
}
const event = { senderFrame: frame, sender: owner }
const host = installFileSave({
  isUiUrl: (url) => url === 'app://litch',
  send: (message) => {
    sent.push(message)
    return true
  },
})
const invoke = (name: string, ...args: unknown[]) => {
  const handler = handlers.get(name)
  assert.ok(handler)
  return Promise.resolve(handler(...args))
}
test('系统对话框默认原名，目标来自本机选择；打开操作按窗口隔离', async () => {
  choose('/local/result.txt')
  await invoke('litch:file-save', event, {
    id: 'one',
    deviceId: 'remote',
    root: '/server',
    path: '/server/report.txt',
  })
  assert.deepEqual(shown.at(-1), {
    defaultPath: 'report.txt',
    properties: ['showOverwriteConfirmation', 'createDirectory'],
  })
  assert.deepEqual(sent.at(-1), {
    type: 'file-save',
    op: 'start',
    id: 'one',
    source: { deviceId: 'remote', root: '/server', path: '/server/report.txt' },
    destination: '/local/result.txt',
  })
  host.receive({
    type: 'file-save',
    progress: { id: 'one', state: 'saved', bytes: 123, total: 123, destination: '/untrusted' },
  })
  await invoke('litch:file-save:action', event, 'one', 'open')
  await invoke('litch:file-save:action', event, 'one', 'reveal')
  assert.deepEqual(opened, ['/local/result.txt', '/local/result.txt'])
  await invoke('litch:file-save:action', { ...event, sender: { ...owner } }, 'one', 'open')
  assert.equal(opened.length, 2)
  await assert.rejects(
    invoke(
      'litch:file-save',
      { ...event, senderFrame: { url: 'https://untrusted' } },
      { id: 'bad', deviceId: 'd', root: '/r', path: '/r/a' },
    ),
    /Invalid caller/,
  )
})
test('取消对话框不启动传输；任务取消和核心断线', async () => {
  choose('')
  const before = sent.length
  await invoke('litch:file-save', event, {
    id: 'cancelled',
    deviceId: 'd',
    root: '/r',
    path: '/r/a',
  })
  assert.equal(sent.length, before)
  assert.equal((updates.at(-1) as { state: string }).state, 'cancelled')
  choose('/local/file')
  await invoke('litch:file-save', event, { id: 'running', deviceId: 'd', root: '/r', path: '/r/a' })
  await invoke('litch:file-save:action', event, 'running', 'cancel')
  assert.deepEqual(sent.at(-1), { type: 'file-save', op: 'cancel', id: 'running' })
  host.disconnected()
  assert.equal((updates.at(-1) as { state: string }).state, 'failed')
})
test('只转发 UI 子框架的右键位置', () => {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const contents = {
    ...owner,
    on: (name: string, fn: (...args: unknown[]) => void) => listeners.set(name, fn),
  }
  events.get('web-contents-created')?.({}, contents)
  listeners.get('context-menu')?.({}, { frame: { url: 'about:srcdoc' }, x: 10, y: 20 })
  assert.deepEqual(updates.at(-1), { x: 10, y: 20 })
  const before = updates.length
  listeners.get('context-menu')?.({}, { frame, x: 1, y: 2 })
  assert.equal(updates.length, before)
})
