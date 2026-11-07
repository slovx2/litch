// 手工诊断：node --cpu-prof --import tsx scripts/bench-replica-command.mts。
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from '../node_modules/esbuild/lib/main.js'
import {
  type CoreChannel,
  createReplica as currentReplica,
  keys,
} from '../packages/core/src/index.mjs'
import { longCommandView } from '../packages/core/test/long-command-fixture.mjs'

// 基线只替换这一个源码模块，不切分支、不覆盖工作树里的文件。
let createReplica = currentReplica
if (process.argv.includes('--baseline')) {
  const path = resolve('packages/core/src/replica/replica.mts')
  const original = execFileSync('git', ['show', '2dc1ce21:packages/core/src/replica/replica.mts'], {
    encoding: 'utf8',
  })
  const output = resolve('.artifacts/long-command/baseline-replica.mjs')
  await build({
    entryPoints: [path],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    plugins: [
      {
        name: 'baseline-replica',
        setup(api) {
          api.onLoad({ filter: /replica\.mts$/ }, (args) =>
            args.path === path
              ? {
                  contents: original,
                  loader: 'ts',
                  resolveDir: resolve('packages/core/src/replica'),
                }
              : undefined,
          )
        },
      },
    ],
  })
  createReplica = (await import(pathToFileURL(output).href)).createReplica
}
let sink: any
const channel = {
  command: async () => ({}),
  subscribe: (_topic: any, receiver: any) => {
    sink = receiver
    return () => {}
  },
  close() {},
} as CoreChannel
const replica = createReplica(channel)
replica.openSession('local', 'long-latency')
const { view, counts, projectionMs } = longCommandView()
let start = performance.now()
sink.snapshot(view)
const snapshotMs = performance.now() - start
let reads = 0
const get = replica.store.get.bind(replica.store)
replica.store.get = (key) => {
  reads++
  return get(key)
}
start = performance.now()
sink.delta(view.turns.slice(20).map((turn) => ({ op: 'turn.remove', turnId: turn.id })))
const report = {
  counts,
  projectionMs,
  snapshotMs,
  deleteMs: performance.now() - start,
  storeReads: reads,
  left: replica.store.get(keys.turnIds('local', 'long-latency')),
}
mkdirSync('.artifacts/long-command', { recursive: true })
writeFileSync(
  `.artifacts/long-command/replica-${process.argv.includes('--baseline') ? 'baseline' : 'fixed'}.json`,
  JSON.stringify(report, null, 2),
)
console.log(JSON.stringify(report))
