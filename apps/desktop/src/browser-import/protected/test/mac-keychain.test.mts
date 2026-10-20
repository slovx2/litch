import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readMacKeychain } from '../mac-keychain.mjs'
import { runCommand } from '../process.mjs'
import { ReadFault } from '../result.mjs'
import type { BrowserId } from '../types.mjs'

const native = join(dirname(fileURLToPath(import.meta.url)), 'fake-keychain')
const runtime = { executable: process.execPath, directory: native, run: runCommand }
const mac = { skip: process.platform !== 'darwin' }

test('原生查询替身经真实子进程返回二进制数据，正确映射系统状态', mac, async () => {
  assert.deepEqual(
    await readMacKeychain('chrome', new AbortController().signal, runtime),
    Buffer.from([32, 107, 0, 121, 10]),
  )
  for (const [browser, status] of [
    ['edge', 'denied'],
    ['brave', 'denied'],
    ['arc', 'denied'],
    ['vivaldi', 'failed'],
  ] as const) {
    await assert.rejects(
      readMacKeychain(browser, new AbortController().signal, runtime),
      (error) => error instanceof ReadFault && error.status === status,
    )
  }
  const output = await runCommand(
    process.execPath,
    [join(native, 'keychain-helper.mjs')],
    Buffer.from('unknown'),
    new AbortController().signal,
    { env: { ELECTRON_RUN_AS_NODE: '1' } },
  )
  assert.equal(output.code, 3)
  assert.equal(output.stdout.length, 0)
  assert.equal(output.stderr.length, 0)
})

test('等待原生查询期间取消可以结束承载进程', mac, async () => {
  const controller = new AbortController()
  const pending = readMacKeychain('chromium', controller.signal, runtime)
  const timer = setTimeout(() => controller.abort(), 200)
  try {
    await assert.rejects(
      pending,
      (error) => error instanceof ReadFault && error.status === 'cancelled',
    )
  } finally {
    clearTimeout(timer)
  }
})

test('取消和非法来源在启动子进程前拦截', async () => {
  const isolated = {
    ...runtime,
    run: async () => {
      throw new Error('不应启动')
    },
  }
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    readMacKeychain('chrome', controller.signal, isolated),
    (error) => error instanceof ReadFault && error.status === 'cancelled',
  )
  await assert.rejects(
    readMacKeychain('unknown' as BrowserId, new AbortController().signal, isolated),
    (error) => error instanceof ReadFault && error.status === 'unsupported',
  )
})

test('Node-API 原生入口拒绝空值、截断值和内嵌 NULL', mac, () => {
  const addon = createRequire(import.meta.url)(join(native, 'keychain.node'))
  for (const browser of [undefined, 1, '', 'chrome\0bad', 'x'.repeat(64)]) {
    assert.notEqual(addon.read(browser).status, 0)
  }
  assert.equal(typeof addon.identity().name, 'string')
})
