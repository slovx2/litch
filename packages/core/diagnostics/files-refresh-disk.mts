// 真实磁盘 + 现有 PathWatch，验证原子替换后仍能持续收到同一路径的新内容。
// 手动诊断：npm run client:diagnose:files-refresh；可丢弃全部事件单独验证对账。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { PathWatch } from '../../shared/src/path-watch.mjs'
import { RpcError } from '../src/connection/rpc.mjs'
import { ChannelError, createFiles, type DirectoryView, type FileContent } from '../src/index.mjs'

test('真实磁盘：新建、修改、原子替换、重命名、删除与重建', { timeout: 120000 }, async (t) => {
  const silent = process.env.LITCH_DIAG_DROP_FILE_EVENTS === '1'
  const timings: number[] = []
  let events = 0
  let stats = 0
  const root = await mkdtemp(join(tmpdir(), 'litch-files-refresh-'))
  const watchers = new Map<string, PathWatch>()
  t.after(async () => {
    for (const watcher of watchers.values()) watcher.close()
    await rm(root, { recursive: true, force: true })
  })
  const path = join(root, 'note.txt')
  await writeFile(path, 'first')
  const files = createFiles({
    clock: {
      now: Date.now,
      setTimer(fn, ms) {
        const timer = setTimeout(fn, ms)
        return () => clearTimeout(timer)
      },
    },
    online: () => true,
    platform: () => (process.platform === 'darwin' ? 'macos' : 'linux'),
    home: () => root,
    knownRoot: () => true,
    log: () => {},
    fail: (error) => new ChannelError('remote', String(error)),
    async request(method, params) {
      const p = params as { path: string; watchId: string }
      let result: unknown
      try {
        if (method === 'fs/watch') {
          watchers.set(
            p.watchId,
            new PathWatch(p.path, (changedPaths) => {
              events++
              if (!silent) files.notification('fs/changed', { watchId: p.watchId, changedPaths })
            }),
          )
          result = { path: p.path }
        } else if (method === 'fs/unwatch') {
          watchers.get(p.watchId)?.close()
          watchers.delete(p.watchId)
          result = {}
        } else if (method === 'fs/getMetadata') {
          stats++
          const meta = await stat(p.path)
          result = {
            isFile: meta.isFile(),
            isDirectory: meta.isDirectory(),
            isSymlink: false,
            createdAtMs: Math.trunc(meta.birthtimeMs),
            modifiedAtMs: Math.trunc(meta.mtimeMs),
          }
        } else if (method === 'fs/readFile')
          result = { dataBase64: (await readFile(p.path)).toString('base64') }
        else if (method === 'fs/readDirectory')
          result = {
            entries: (await readdir(p.path, { withFileTypes: true })).map((e) => ({
              fileName: e.name,
              isDirectory: e.isDirectory(),
              isFile: e.isFile(),
            })),
          }
        else throw new Error(method)
      } catch (error) {
        throw new RpcError(-32603, String(error))
      }
      return result as never
    },
  })
  let content: FileContent | undefined
  let listing: DirectoryView | undefined
  const stopFile = files.watch(root, path, false, {
    snapshot: () => {
      void files.read(root, path).then((value) => {
        content = value
      })
    },
    delta() {},
    error() {},
  })
  t.after(stopFile)
  const stopDir = files.watch(root, root, true, {
    snapshot: () => {
      void files.list(root, root, true).then((value) => {
        listing = value
      })
    },
    delta() {},
    error() {},
  })
  t.after(stopDir)
  const until = async (condition: () => boolean) => {
    const start = Date.now()
    // 包含 5 秒低频对账及后台进程调度时间；操作本身不重试。
    while (!condition() && Date.now() - start < 20000) await sleep(25)
    timings.push(Date.now() - start)
    assert.ok(
      condition(),
      `等待文件变化刷新超时：${JSON.stringify({ silent, events, stats, timings, content, listing })}`,
    )
  }
  const text = () => (content?.kind === 'text' ? content.text : content?.kind)
  const names = () => listing?.entries.map((entry) => entry.name) ?? []
  await until(() => text() === 'first')
  // 等待底层首次监视完成后的主动核对。
  await sleep(350)
  await writeFile(path, 'second')
  await until(() => text() === 'second')
  await writeFile(join(root, 'replacement'), 'atomic')
  await rename(join(root, 'replacement'), path)
  await until(() => text() === 'atomic')
  await writeFile(path, 'after-atomic')
  await until(() => text() === 'after-atomic')
  await mkdir(join(root, 'new-dir'))
  await until(() => names().includes('new-dir'))
  await rename(join(root, 'new-dir'), join(root, 'renamed-dir'))
  await until(() => names().includes('renamed-dir') && !names().includes('new-dir'))
  await rename(path, join(root, 'renamed.txt'))
  await until(() => text() === 'missing' && names().includes('renamed.txt'))
  await writeFile(path, 'recreated')
  await until(() => text() === 'recreated')
  await rm(join(root, 'renamed-dir'), { recursive: true })
  await rm(path)
  await until(() => text() === 'missing' && !names().includes('renamed-dir'))
  stopFile()
  stopDir()
  assert.equal(watchers.size, 0)
  t.diagnostic(
    JSON.stringify({ silent, events, stats, refreshMs: timings, requests: files.requests() }),
  )
})
