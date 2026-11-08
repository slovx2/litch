import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { DownloadItem } from 'electron'
import {
  BrowserDownloads,
  safeDownloadName,
} from '../../../../../third_party/litch-automation/packages/browser/src/browser/downloads.mjs'
import type { TabInfo } from '../model.mjs'

class Item extends EventEmitter {
  path = ''
  bytes = 0
  cancelled = false
  readonly name: string
  readonly size: number
  constructor(name = 'key.p8', size = 6) {
    super()
    this.name = name
    this.size = size
  }
  getFilename() {
    return this.name
  }
  getURL() {
    return 'https://files.example/key?secret-token=hidden'
  }
  getTotalBytes() {
    return this.size
  }
  getReceivedBytes() {
    return this.bytes
  }
  setSavePath(path: string) {
    this.path = path
  }
  cancel() {
    this.cancelled = true
  }
  complete(text = 'secret') {
    writeFileSync(this.path, text)
    this.bytes = Buffer.byteLength(text)
    this.emit('done', {}, 'completed')
  }
}
const owner = { deviceId: 'local', threadId: 'thread' }
const tab = (kind: 'user' | 'agent'): TabInfo => ({
  id: 't1',
  owner,
  kind,
  url: 'https://source.example',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  agentActive: kind === 'agent',
  keep: false,
})
function fixture(options: { maxBytes?: number; maxTotalBytes?: number; timeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'litch-download-test-'))
  const stagingRoot = join(root, 'private')
  const downloadsDirectory = join(root, 'Downloads')
  const manager = new BrowserDownloads({ stagingRoot, downloadsDirectory, ...options })
  return {
    root,
    stagingRoot,
    downloadsDirectory,
    manager,
    capture(item: Item, kind: 'user' | 'agent' = 'agent') {
      manager.capture(item as unknown as DownloadItem, tab(kind))
      const entry = manager.list().at(-1)
      assert.ok(entry)
      return entry
    },
    close() {
      manager.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}
async function until(test: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (test()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('状态未在时限内落定')
}

test('待审批文件不发布、不暴露暂存路径或完整 URL，批准后仅最终路径可见', async () => {
  const f = fixture()
  try {
    const item = new Item()
    const entry = f.capture(item)
    item.complete()
    assert.equal(existsSync(f.downloadsDirectory), false)
    assert.equal(f.manager.list()[0]?.path, undefined)
    assert.doesNotMatch(JSON.stringify(f.manager.list()), /private|secret-token|payload/)
    assert.equal(f.manager.list()[0]?.origin, 'https://files.example')
    assert.equal(f.manager.blocksPath(item.path), true)
    assert.equal(f.manager.blocksPath(realpathSync(item.path)), true)
    assert.equal(f.manager.blocksPath(join(f.root, 'elsewhere')), false)
    f.manager.answer(entry.id, true)
    await until(() => f.manager.list()[0]?.status === 'completed')
    const saved = f.manager.list()[0]?.path
    assert.ok(saved)
    assert.equal(readFileSync(saved, 'utf8'), 'secret')
    assert.deepEqual(readdirSync(f.stagingRoot), [])
  } finally {
    f.close()
  }
})

test('用户下载自动保存，已有文件和并发同名下载不覆盖', async () => {
  const f = fixture()
  try {
    mkdirSync(f.downloadsDirectory)
    writeFileSync(join(f.downloadsDirectory, 'key.p8'), 'original')
    const a = new Item()
    const b = new Item()
    f.capture(a, 'user')
    f.capture(b, 'user')
    a.complete('first')
    b.complete('second')
    await until(() => f.manager.list().every((one) => one.status === 'completed'))
    assert.equal(readFileSync(join(f.downloadsDirectory, 'key.p8'), 'utf8'), 'original')
    assert.deepEqual(readdirSync(f.downloadsDirectory).sort(), [
      'key (1).p8',
      'key (2).p8',
      'key.p8',
    ])
    assert.equal(new Set(f.manager.list().map((one) => one.path)).size, 2)
  } finally {
    f.close()
  }
})

test('拒绝、取消调用、关闭标签均删除待批准下载', async () => {
  const f = fixture()
  try {
    const a = new Item()
    const entry = f.capture(a)
    a.complete()
    assert.equal(f.manager.answer(entry.id, false), true)
    assert.equal(existsSync(a.path), false)
    assert.equal(f.manager.answer(entry.id, true), false)
    const b = new Item()
    f.capture(b)
    b.complete()
    const controller = new AbortController()
    const pending = f.manager.askPending(owner, {
      signal: controller.signal,
      ask: async () => null,
      show: () => () => {},
    })
    controller.abort()
    await pending
    assert.equal(existsSync(b.path), false)
    const c = new Item()
    f.capture(c)
    c.complete()
    f.manager.closeTab('t1')
    assert.equal(existsSync(c.path), false)
    assert.ok(f.manager.list().every((one) => one.status === 'declined'))
  } finally {
    f.close()
  }
})

test('只允许逐文件 once，审批内容含文件名、来源和未知大小', async () => {
  const f = fixture()
  try {
    const a = new Item('data.bin', 0)
    f.capture(a)
    a.complete()
    await f.manager.askPending(owner, {
      signal: new AbortController().signal,
      ask: async (ask) => {
        assert.deepEqual(ask, {
          kind: 'browserDownload',
          filename: 'data.bin',
          origin: 'https://files.example',
          totalBytes: null,
        })
        return 'always'
      },
    })
    assert.equal(f.manager.list()[0]?.status, 'declined')
  } finally {
    f.close()
  }
})

test('大小、未知大小累计接收、并发数量都有上限', () => {
  const f = fixture({ maxBytes: 10, maxTotalBytes: 12 })
  try {
    const oversized = new Item('big', 11)
    f.capture(oversized)
    assert.equal(oversized.cancelled, true)
    const a = new Item('unknown', 0)
    f.capture(a)
    a.bytes = 11
    a.emit('updated', {}, 'progressing')
    assert.equal(a.cancelled, true)
    const b = new Item('b', 0)
    f.capture(b)
    b.bytes = 7
    b.emit('updated', {}, 'progressing')
    const c = new Item('c', 0)
    f.capture(c)
    c.bytes = 7
    c.emit('updated', {}, 'progressing')
    assert.equal(c.cancelled, true)
    for (let i = 0; i < 4; i++) f.capture(new Item())
    assert.equal(f.manager.list().at(-1)?.status, 'failed')
  } finally {
    f.close()
  }
})

test('超时、退出与启动清除旧私有目录；不触碰已保存文件', async () => {
  const f = fixture({ timeoutMs: 15 })
  try {
    const a = new Item()
    f.capture(a)
    a.complete()
    await f.manager.askPending(owner, {
      signal: new AbortController().signal,
      ask: () => new Promise(() => {}),
    })
    assert.equal(f.manager.list()[0]?.status, 'failed')
    assert.equal(existsSync(a.path), false)
    const b = new Item()
    f.capture(b)
    b.complete()
    f.manager.dispose()
    assert.equal(existsSync(f.stagingRoot), false)
    mkdirSync(f.stagingRoot)
    writeFileSync(join(f.stagingRoot, 'crash-secret'), 'old')
    const next = new BrowserDownloads({
      stagingRoot: f.stagingRoot,
      downloadsDirectory: f.downloadsDirectory,
    })
    assert.deepEqual(readdirSync(f.stagingRoot), [])
    next.dispose()
  } finally {
    f.close()
  }
})

test('文件名不能穿越路径、携带控制字符或 Windows 保留名', () => {
  assert.equal(safeDownloadName('../../key.p8'), 'key.p8')
  assert.equal(safeDownloadName('C:\\secrets\\key.p8'), 'key.p8')
  assert.equal(safeDownloadName('..'), 'download')
  assert.equal(safeDownloadName('CON.txt'), '_CON.txt')
  assert.equal(safeDownloadName('a\nb.txt'), 'a_b.txt')
  assert.ok(Buffer.byteLength(safeDownloadName('密钥'.repeat(150))) <= 180)
})

test('用户下载与别的会话不暴露给 Agent，登录交接期间不发下载审批', async () => {
  const f = fixture()
  try {
    const user = new Item()
    f.capture(user, 'user')
    assert.deepEqual(f.manager.list(owner, true), [])
    const agent = new Item()
    f.capture(agent)
    assert.equal(f.manager.list(owner, true).length, 1)
    assert.deepEqual(f.manager.list({ ...owner, threadId: 'another' }, true), [])
    await f.manager.askPending(
      owner,
      {
        signal: new AbortController().signal,
        ask: async () => assert.fail('登录交接不能领取审批'),
      },
      () => false,
    )
    assert.equal(f.manager.list(owner, true)[0]?.status, 'pending')
    agent.emit('updated', {}, 'interrupted')
    assert.equal(f.manager.list(owner, true)[0]?.status, 'failed')
    assert.equal(existsSync(agent.path), false)
  } finally {
    f.close()
  }
})
