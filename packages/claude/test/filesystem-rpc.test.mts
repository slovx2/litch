import assert from 'node:assert/strict'
import fs, { type FSWatcher, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FilesystemRpc } from '../../shared/src/filesystem-rpc.mjs'
import { ProtocolError } from '../src/protocol-contract.mjs'
import type { RpcPeer } from '../src/types.mjs'

test('文件参数错误不能截断文件或写入部分解码内容', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fs-rpc-'))
  const files = new FilesystemRpc()
  const peer: RpcPeer = { id: 'test', send() {}, close() {} }
  const path = join(home, 'data')
  try {
    await writeFile(path, 'KEEP')
    for (const dataBase64 of [undefined, null, 123, 'bad!', 'YWJj=']) {
      await assert.rejects(
        files.call(peer, 'fs/writeFile', { path, dataBase64 }),
        (error: unknown) => error instanceof ProtocolError && error.code === -32602,
      )
      assert.equal(await readFile(path, 'utf8'), 'KEEP')
    }
    await assert.rejects(files.call(peer, 'fs/readFile', { path: 'relative' }), ProtocolError)
    await assert.rejects(files.call(peer, 'fs/remove', { path, recursive: 'true' }), ProtocolError)
    assert.equal(await readFile(path, 'utf8'), 'KEEP')
    await files.call(peer, 'fs/writeFile', { path, dataBase64: '' })
    assert.equal((await readFile(path)).length, 0)
    await symlink(path, join(home, 'link'))
    const metadata: any = await files.call(peer, 'fs/getMetadata', { path: join(home, 'link') })
    assert.equal(metadata.isSymlink, true)
    assert.equal(metadata.isFile, true)
    assert.ok(Number.isInteger(metadata.modifiedAtMs))
  } finally {
    files.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('独立连接可使用同名 watch；重复启动和关闭不影响另一个连接', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fs-rpc-'))
  const files = new FilesystemRpc()
  const first: RpcPeer = { id: 'first', send() {}, close() {} }
  const second: RpcPeer = { id: 'second', send() {}, close() {} }
  const params = { path: home, watchId: 'shared' }
  try {
    await files.call(first, 'fs/watch', params)
    await files.call(second, 'fs/watch', params)
    await assert.rejects(files.call(first, 'fs/watch', params), ProtocolError)
    files.closePeer(first.id)
    await files.call(first, 'fs/watch', params)
    await assert.rejects(files.call(second, 'fs/watch', params), ProtocolError)
    await files.call(second, 'fs/unwatch', { watchId: 'shared' })
    await files.call(second, 'fs/watch', params)
  } finally {
    files.close()
    await rm(home, { recursive: true, force: true })
  }
})

function watchPeer(id: string, batches: string[][]): RpcPeer {
  return {
    id,
    send(message: any) {
      if (message.method === 'fs/changed') batches.push(message.params.changedPaths)
    },
    close() {},
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await pause(20)
}

// macOS 上目录监视刚建好的那一小段系统还不送事件，这段里的变更丢了（不是晚到，见 path-watch.mts）。
// 要看哪几次变更报上来的用例先确认监视已经在送事件：往目录里写探针直到收到通知，等这一批去抖完再清掉。
async function untilLive(dir: string, batches: string[][]): Promise<string> {
  const probe = join(dir, '.probe')
  for (let attempt = 0; attempt < 100 && !batches.flat().includes(probe); attempt++) {
    if (attempt % 5 === 0) await writeFile(probe, String(attempt))
    await pause(20)
  }
  assert.ok(batches.flat().includes(probe), '监视一直没有送来事件')
  await pause(400)
  batches.length = 0
  return probe
}

test('fs/watch 与 Codex 一致：只监视本层、去抖合并、原样返回路径，监视错误不成为进程异常', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-watch-'))
  const files = new FilesystemRpc()
  const batches: string[][] = []
  try {
    await mkdir(join(home, 'nested'))
    const response: any = await files.call(watchPeer('watch', batches), 'fs/watch', {
      watchId: 'w',
      path: home,
    })
    assert.equal(response.path, home)
    const probe = await untilLive(home, batches)
    await writeFile(join(home, 'b.txt'), 'b')
    await writeFile(join(home, 'a.txt'), 'a')
    await writeFile(join(home, 'nested', 'deep.txt'), 'deep')
    await waitFor(() => batches.flat().includes(join(home, 'b.txt')))
    await pause(300)
    // 探针那几次写的事件可能还有晚到的，不算在里面
    const ours = batches.filter((batch) => batch.some((path) => path !== probe))
    const changed = ours.flat()
    assert.ok(changed.includes(join(home, 'a.txt')) && changed.includes(join(home, 'b.txt')))
    assert.equal(changed.includes(join(home, 'nested', 'deep.txt')), false)
    assert.ok(ours.length <= 2, `去抖后通知批次过多：${ours.length}`)
    const watch = ((files as any).watchers.get('watch') as Map<string, any>).get('w')
    watch.watcher.emit('error', Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }))
    assert.equal(watch.watcher, null)
  } finally {
    files.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('fs/watch 目标不存在时监视最近的祖先目录，目标出现后通知目标本身', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-watch-'))
  const files = new FilesystemRpc()
  const batches: string[][] = []
  const target = join(home, 'later', 'dir', 'file.txt')
  try {
    await files.call(watchPeer('missing', batches), 'fs/watch', { watchId: 'm', path: target })
    await writeFile(join(home, 'unrelated.txt'), 'x')
    await mkdir(join(home, 'later', 'dir'), { recursive: true })
    await new Promise((resolve) => setTimeout(resolve, 300))
    await writeFile(target, 'now')
    await waitFor(() => batches.flat().includes(target))
    assert.ok(batches.flat().includes(target))
    assert.equal(batches.flat().includes(join(home, 'unrelated.txt')), false)
  } finally {
    files.close()
    await rm(home, { recursive: true, force: true })
  }
})

// 一口气建出几层目录时，监视往目标挪的当口下一层可能已经在了：那一段变化发生在新监视生效之前，
// 没有事件。这个先后只在慢机器上偶尔出现，这里把它定下来：每次要建监视的那一刻，先把再下一层放好。
test('fs/watch 挪监视的当口路径又往前长了也跟得上，目标出现照样通知', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-watch-'))
  const files = new FilesystemRpc()
  const batches: string[][] = []
  const first = join(home, 'later')
  const nearest = join(first, 'dir')
  const target = join(nearest, 'file.txt')
  const watch = fs.watch as (...args: unknown[]) => FSWatcher
  const watched: unknown[] = []
  context.mock.method(fs, 'watch', (...args: unknown[]) => {
    watched.push(args[0])
    if (args[0] === first) mkdirSync(nearest, { recursive: true })
    if (args[0] === nearest) writeFileSync(target, 'now')
    return watch(...args)
  })
  // 被测代码用的是具名导入，要同步过去才换得到
  syncBuiltinESMExports()
  try {
    await files.call(watchPeer('racing', batches), 'fs/watch', { watchId: 'r', path: target })
    await mkdir(first)
    // 起点目录的这次变更赶上监视刚建好、系统还没送事件的话，靠建好之后的再看一遍跟上（下一个用例守着）
    await waitFor(() => batches.flat().includes(target))
    // 一路跟到目标：中间两层都没有等到自己的事件
    assert.deepEqual(watched, [home, first, nearest, target])
    assert.deepEqual([...new Set(batches.flat())], [target])
  } finally {
    files.close()
    context.mock.restoreAll()
    syncBuiltinESMExports()
    await rm(home, { recursive: true, force: true })
  }
})

// 监视刚建好、系统还没开始送事件的那一段里路径往前长了、目标出现了：建好之后过一会儿再看一遍，照样跟上。
// 这里让起点目录上的监视一个事件都收不到，把那一段拉到无穷长。
test('fs/watch 刚建好的监视收不到事件时，过一会儿再看一遍也跟得上', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-watch-'))
  const files = new FilesystemRpc()
  const batches: string[][] = []
  const target = join(home, 'later', 'dir', 'file.txt')
  const watch = fs.watch as (...args: unknown[]) => FSWatcher
  const watched: unknown[] = []
  context.mock.method(fs, 'watch', (...args: unknown[]) => {
    watched.push(args[0])
    return args[0] === home ? watch(args[0], args[1], () => {}) : watch(...args)
  })
  syncBuiltinESMExports()
  try {
    await files.call(watchPeer('blind', batches), 'fs/watch', { watchId: 'b', path: target })
    await mkdir(join(home, 'later', 'dir'), { recursive: true })
    await writeFile(target, 'now')
    await waitFor(() => batches.flat().includes(target))
    assert.deepEqual([...new Set(batches.flat())], [target])
    assert.deepEqual(watched, [home, target])
  } finally {
    files.close()
    context.mock.restoreAll()
    syncBuiltinESMExports()
    await rm(home, { recursive: true, force: true })
  }
})
