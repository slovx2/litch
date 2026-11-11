import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBrowserExecutor } from '../src/browser/executor.mjs'
import { interceptFileChooser } from '../src/browser/file-chooser.mjs'
import type { FileChooserInfo } from '../src/browser/model.mjs'
import { createSiteBook } from '../src/browser/sites.mjs'
import { validateFiles } from '../src/browser/upload-target.mjs'
import { fakeHost } from './fake-cdp.mjs'

test('先订阅再开启拦截，保留同步选择器事件；清理关闭拦截并撤订阅', async () => {
  let listener: ((info: FileChooserInfo) => void) | undefined
  const commands: boolean[] = []
  const watch = await interceptFileChooser(
    async (enabled) => {
      commands.push(enabled)
      if (enabled) listener?.({ backendNodeId: 42, mode: 'selectSingle' })
    },
    (next) => {
      listener = next
      return () => {
        listener = undefined
      }
    },
    new AbortController().signal,
  )
  assert.deepEqual(await watch.wait(10), { backendNodeId: 42, mode: 'selectSingle' })
  await watch.dispose()
  assert.equal(listener, undefined)
  assert.deepEqual(commands, [true, false])
})

test('超时返回空，取消及时结束等待；两种出口都能关闭拦截', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController()
    const commands: boolean[] = []
    let removed = false
    const watch = await interceptFileChooser(
      async (enabled) => {
        commands.push(enabled)
      },
      () => () => {
        removed = true
      },
      controller.signal,
    )
    const waiting = watch.wait(cancel ? 10_000 : 1)
    if (cancel) {
      controller.abort()
      await assert.rejects(waiting, /abort/i)
    } else assert.equal(await waiting, null)
    await watch.dispose()
    assert.equal(removed, true)
    assert.deepEqual(commands, [true, false])
  }
})

test('开启拦截失败也撤销订阅，不点击、不遗留拦截', async () => {
  let removed = false
  const commands: boolean[] = []
  await assert.rejects(
    interceptFileChooser(
      async (enabled) => {
        commands.push(enabled)
        if (enabled) throw Error('unsupported')
      },
      () => () => {
        removed = true
      },
      new AbortController().signal,
    ),
    /unsupported/,
  )
  assert.equal(removed, true)
  assert.deepEqual(commands, [true, false])
})

test('文件数、禁用、目录和 accept 必须符合页面文件框规则', () => {
  assert.throws(() => validateFiles(new Map(), ['/a.txt', '/b.txt']), /only one/)
  assert.throws(() => validateFiles(new Map([['disabled', '']]), ['/a.txt']), /disabled/)
  assert.throws(() => validateFiles(new Map([['webkitdirectory', '']]), ['/a.txt']), /directory/)
  assert.throws(() => validateFiles(new Map([['accept', '.zip']]), ['/a.txt']), /accept=/)
  assert.throws(() => validateFiles(new Map([['accept', 'image/*']]), ['/a.txt']), /accept=/)
  validateFiles(
    new Map([
      ['accept', '.TXT,application/zip'],
      ['multiple', ''],
    ]),
    ['/a.txt', '/b.zip'],
  )
  validateFiles(new Map([['accept', 'image/*']]), ['/a.png'])
  validateFiles(new Map([['accept', '*/*']]), ['/a.bin'])
})

test('远程会话的同名路径绝不能读取桌面本地文件', async () => {
  const executor = createBrowserExecutor({
    host: fakeHost(),
    sites: createSiteBook(null),
    statFile: () => {
      throw Error('不得读取控制端文件')
    },
  })
  const result = await executor.call(
    {
      namespace: 'litch_browser',
      tool: 'upload',
      arguments: { ref: 'e1g1', paths: ['/fixture/same-name.txt'] },
      id: 'remote-upload',
      callId: 'remote-upload',
      threadId: 'remote',
      turnId: 'turn',
      device: { id: 'remote', name: 'remote', kind: 'ssh', target: 'example.test' },
      harness: null,
      cwd: null,
    },
    { signal: new AbortController().signal, ask: async () => 'once' },
  )
  assert.equal(result.success, false)
  assert.match(JSON.stringify(result), /host cannot read upload files/)
  assert.doesNotMatch(JSON.stringify(result), /不得读取控制端文件/)
})
