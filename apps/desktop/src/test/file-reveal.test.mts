import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { FileSaveSource } from '@litch/core'
import { installFileReveal } from '../file-reveal-main.mjs'
import { handlers, opened, shellCalls } from './file-save-electron.mjs'

test('IPC 核验调用框架、可信设备身份、真实路径范围与删除状态', async () => {
  const work = await realpath(await mkdtemp(join(tmpdir(), 'litch-reveal-')))
  const root = join(work, 'root')
  await mkdir(root)
  await writeFile(join(root, 'a.txt'), 'fixture')
  await writeFile(join(work, 'outside.txt'), 'outside')
  await symlink(join(work, 'outside.txt'), join(root, 'escape.txt'))
  await symlink(join(root, 'a.txt'), join(root, 'inside.txt'))
  const messages: unknown[] = []
  const host = installFileReveal({
    isUiUrl: (url) => url === 'app://litch',
    send(raw) {
      const message = raw as { id: number; source: FileSaveSource }
      messages.push(message)
      queueMicrotask(() =>
        host.receive({
          type: 'file-reveal',
          id: message.id,
          source: message.source.deviceId === 'local' ? message.source : null,
        }),
      )
      return true
    },
  })
  const frame = { url: 'app://litch' }
  const owner = { mainFrame: frame, isDestroyed: () => false }
  const event = { senderFrame: frame, sender: owner }
  const invoke = (path: string, deviceId = 'local', caller = event) =>
    handlers.get('litch:file-reveal')?.(caller, { deviceId, root, path })
  try {
    const before = opened.length
    assert.equal(await invoke(join(root, 'a.txt')), 'opened')
    assert.equal(opened.at(-1), join(root, 'a.txt'))
    assert.equal(await invoke(root), 'opened')
    assert.equal(opened.at(-1), root)
    assert.deepEqual(shellCalls.slice(-2), [
      { method: 'showItemInFolder', path: join(root, 'a.txt') },
      { method: 'openPath', path: root },
    ])
    assert.equal(await invoke(join(root, 'inside.txt')), 'opened')
    assert.equal(opened.at(-1), join(root, 'a.txt'))
    for (const path of [
      join(work, 'outside.txt'),
      join(root, 'escape.txt'),
      join(root, '../outside.txt'),
      'https://example.org',
      'relative',
      '//server/share',
      `${root}/bad\0path`,
    ])
      assert.equal(await invoke(path), 'denied', path)
    assert.equal(await invoke(join(root, 'missing.txt')), 'missing')
    assert.equal(await invoke(join(root, 'a.txt'), 'ssh'), 'remote')
    const seen = messages.length
    assert.equal(
      await invoke(join(root, 'a.txt'), 'local', { ...event, senderFrame: { url: 'app://litch' } }),
      'denied',
    )
    assert.equal(messages.length, seen, '子框架不得向核心申请打开路径')
    assert.equal(opened.length, before + 3, '拒绝和远程请求不得打开系统窗口')
    await rm(join(root, 'a.txt'))
    assert.equal(await invoke(join(root, 'a.txt')), 'missing', '点击时重新检查已删除文件')
  } finally {
    host.disconnected()
    await rm(work, { recursive: true, force: true })
  }
})

test('核心不可用或失联时不打开路径', async () => {
  const frame = { url: 'app://litch' }
  const event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false } }
  const source = { deviceId: 'local', root: tmpdir(), path: join(tmpdir(), 'file') }
  installFileReveal({ isUiUrl: () => true, send: () => false })
  assert.equal(await handlers.get('litch:file-reveal')?.(event, source), 'failed')
  const host = installFileReveal({ isUiUrl: () => true, send: () => true })
  const pending = handlers.get('litch:file-reveal')?.(event, source)
  host.disconnected()
  assert.equal(await pending, 'failed')
})
