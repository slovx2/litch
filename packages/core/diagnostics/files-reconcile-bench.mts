// Node 24：node --import tsx packages/core/diagnostics/files-reconcile-bench.mts
// 真实磁盘，隔离临时目录；统计无变化时的对账成本，不连接个人设备服务。
import { lstat, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { createFileReconciler, FILE_RECONCILE_MS } from '../src/device/file-reconcile.mjs'
import type { FilesHost } from '../src/device/files.mjs'
import { ChannelError } from '../src/index.mjs'
import { projectDirectory } from '../src/projection/files.mjs'
import { fakeClock, settle } from '../test/helpers.mjs'

const root = await mkdtemp(join(tmpdir(), 'litch-files-bench-'))
try {
  const large = join(root, 'large')
  await mkdir(large)
  // 创建过程也限并发，避免压测夹具本身占满线程池。
  for (let start = 0; start < 30000; start += 64)
    await Promise.all(
      Array.from({ length: Math.min(64, 30000 - start) }, (_, i) =>
        writeFile(join(large, `file-${start + i}.txt`), 'x'),
      ),
    )
  for (let start = 0; start < 1000; start += 32)
    await Promise.all(Array.from({ length: 32 }, (_, i) => mkdir(join(root, `dir-${start + i}`))))
  const began = performance.now()
  const entries = await readdir(large, { withFileTypes: true })
  const view = projectDirectory(
    large,
    entries.map((e) => ({ fileName: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() })),
  )
  const initialListMs = performance.now() - began
  const results = []
  for (const paths of [
    [large, join(large, 'file-0.txt')],
    Array.from({ length: 1000 }, (_, i) => join(root, `dir-${i}`)),
  ]) {
    const clock = fakeClock()
    let running = 0,
      peak = 0,
      requests = 0,
      changes = 0
    const host: FilesHost = {
      clock: clock.clock,
      online: () => true,
      platform: () => 'macos',
      home: () => root,
      knownRoot: () => true,
      log() {},
      fail: (e) => new ChannelError('remote', String(e)),
      async request(method, params) {
        if (method !== 'fs/getMetadata') throw new Error(method)
        peak = Math.max(peak, ++running)
        requests++
        try {
          const path = (params as { path: string }).path
          const [m, l] = await Promise.all([stat(path), lstat(path)])
          return {
            isFile: m.isFile(),
            isDirectory: m.isDirectory(),
            isSymlink: l.isSymbolicLink(),
            createdAtMs: Math.trunc(m.birthtimeMs),
            modifiedAtMs: Math.trunc(m.mtimeMs),
          } as never
        } finally {
          running--
        }
      },
    }
    const reconcile = createFileReconciler(host)
    const stops = paths.map((path) => reconcile.open(path, () => changes++))
    const drained = async () => {
      do {
        await settle()
        if (running) await sleep(1)
      } while (running)
    }
    await drained()
    changes = 0
    requests = 0
    const delay = monitorEventLoopDelay({ resolution: 1 })
    delay.enable()
    const cpu = process.cpuUsage()
    const samples: number[] = []
    for (let round = 0; round < (paths.length === 2 ? 100 : 10); round++) {
      const at = performance.now()
      clock.advance(FILE_RECONCILE_MS)
      await drained()
      samples.push(performance.now() - at)
    }
    const usage = process.cpuUsage(cpu)
    delay.disable()
    for (const stop of stops) stop()
    samples.sort((a, b) => a - b)
    results.push({
      paths: paths.length,
      rounds: samples.length,
      requests,
      contentRefreshes: changes,
      peak,
      medianMs: samples[Math.floor(samples.length / 2)],
      p95Ms: samples[Math.floor(samples.length * 0.95)],
      cpuMs: (usage.user + usage.system) / 1000,
      eventLoopMaxMs: delay.max / 1e6,
    })
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        directoryEntries: view.total,
        initialListMs,
        results,
      },
      null,
      2,
    ),
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
