// 真实设备套接字 → 真核心 → 本机分块落盘；没有 harness 或模型进程。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { createCore, type FileSaveProgress } from '@litch/core'
import { DeviceServer } from '../../../../packages/device/src/device.mjs'
import { listenUnix } from '../../../../packages/device/src/sockets.mjs'
import { saveFileLocally } from '../file-save-core.mjs'
import { unixSocketOpener } from '../transport-unix.mjs'

test('设备套接字分块另存：目标位于客户端目录，源文件不变', { timeout: 15000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'lfs-'))
  const remote = join(home, 'remote'),
    local = join(home, 'client')
  await mkdir(remote)
  await mkdir(local)
  const source = join(remote, 'report.bin'),
    destination = join(local, 'download.bin')
  const data = Buffer.alloc(4 * 1024 * 1024 + 19, 117)
  await writeFile(source, data)
  const server = new DeviceServer({ stateDir: join(home, 'state'), upstreams: [] })
  const socket = join(home, 'device.sock')
  const listener = await listenUnix(socket, (wire) => server.attach(wire))
  const core = createCore({
    clock: {
      now: Date.now,
      setTimer(fn, ms) {
        const timer = setTimeout(fn, ms)
        return () => clearTimeout(timer)
      },
    },
    version: 'test',
    devices: [
      {
        id: 'remote',
        kind: 'ssh',
        host: 'fixture',
        name: '隔离设备',
        target: null,
        wire: 'green',
        open: unixSocketOpener(socket),
      },
    ],
  })
  t.after(async () => {
    core.stop()
    await listener.close()
    await server.close()
    await rm(home, { recursive: true, force: true })
  })
  core.start()
  const abort = new AbortController()
  let ready = false
  for (let n = 0; n < 100; n++) {
    try {
      await core.command(
        'files.readChunk',
        { deviceId: 'remote', root: remote, path: source, offset: 0 },
        abort.signal,
      )
      ready = true
      break
    } catch {
      await sleep(20)
    }
  }
  assert.ok(ready, '设备握手应声明分块读取能力')
  const progress: FileSaveProgress[] = []
  await saveFileLocally(
    core,
    { id: 'transfer', source: { deviceId: 'remote', root: remote, path: source }, destination },
    abort.signal,
    (value) => progress.push(value),
  )
  assert.equal(progress.at(-1)?.state, 'saved', progress.at(-1)?.error)
  assert.deepEqual(await readFile(destination), data)
  assert.deepEqual(await readFile(source), data)
  assert.equal(progress.at(-1)?.bytes, data.length)
})
