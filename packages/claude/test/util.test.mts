import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { debugLog as sharedDebugLog } from '../../shared/src/util.mjs'
import { debugLog, flushDebugLog, resolveCodexBinary } from '../src/util.mjs'
import { isolatedEnv } from './fixtures/isolated-env.mjs'

/** 调试日志是攒到这一轮事件循环末尾才写的：等它写完 */
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))
const logLines = async (path: string) =>
  (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))

test('未运行 adapter main 的 Claude 入口仍记录共享模块日志', async () => {
  const previous = process.env.CHA_CLAUDE_DEBUG_LOG
  const directory = await mkdtemp(join(tmpdir(), 'claude-shared-log-'))
  const path = join(directory, 'debug.jsonl')
  process.env.CHA_CLAUDE_DEBUG_LOG = path
  try {
    sharedDebugLog('fs.review.test', { count: 1 })
    await nextTurn()
    assert.equal(JSON.parse(await readFile(path, 'utf8')).event, 'fs.review.test')
  } finally {
    if (previous === undefined) delete process.env.CHA_CLAUDE_DEBUG_LOG
    else process.env.CHA_CLAUDE_DEBUG_LOG = previous
    await rm(directory, { recursive: true, force: true })
  }
})

test('resolveCodexBinary prefers CODEX_REAL over PATH and homedir fallbacks', async () => {
  const previous = process.env.CODEX_REAL
  const directory = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-util-'))
  const binary = join(directory, 'codex.real')
  await writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  process.env.CODEX_REAL = binary
  try {
    assert.equal(resolveCodexBinary(), binary)
  } finally {
    if (previous == null) delete process.env.CODEX_REAL
    else process.env.CODEX_REAL = previous
    await rm(directory, { recursive: true, force: true })
  }
})

// 调试日志以前每记一行都同步地建目录、看大小、打开文件写一行，流式输出时一条增量一行，
// 占了入口处理一条增量的一半开销。现在一轮事件循环里记的行攒在一起写一次。
// 不看钟，数写了几次文件（把 node:fs 的 appendFileSync 换成数数的，再同步给 ESM 的导出）。
test('调试日志：一轮事件循环里记的行一起写一次，先后不变；换了文件先写完原来那个', async () => {
  const previous = process.env.CHA_CLAUDE_DEBUG_LOG
  const directory = await mkdtemp(join(tmpdir(), 'claude-batched-log-'))
  const [first, second] = [join(directory, 'first.jsonl'), join(directory, 'second.jsonl')]
  const append = fs.appendFileSync
  let writes = 0
  fs.appendFileSync = ((...args: Parameters<typeof append>) => {
    writes++
    return append(...args)
  }) as typeof append
  syncBuiltinESMExports()
  try {
    process.env.CHA_CLAUDE_DEBUG_LOG = first
    for (let index = 0; index < 200; index++) debugLog('batch.test', { index })
    assert.equal(writes, 0, '记的时候不写文件')
    await nextTurn()
    assert.equal(writes, 1, '两百行写一次')
    assert.deepEqual(
      (await logLines(first)).map((entry) => entry.index),
      Array.from({ length: 200 }, (_, index) => index),
    )
    // 同一轮里换了文件：原来那个先写完，之后的进新的
    debugLog('batch.test', { index: 200 })
    process.env.CHA_CLAUDE_DEBUG_LOG = second
    debugLog('batch.test', { index: 201 })
    assert.equal(writes, 2)
    await nextTurn()
    assert.equal((await logLines(first)).at(-1).index, 200)
    assert.deepEqual(
      (await logLines(second)).map((entry) => entry.index),
      [201],
    )
  } finally {
    fs.appendFileSync = append
    syncBuiltinESMExports()
    if (previous === undefined) delete process.env.CHA_CLAUDE_DEBUG_LOG
    else process.env.CHA_CLAUDE_DEBUG_LOG = previous
    await rm(directory, { recursive: true, force: true })
  }
})

test('调试日志：一起写的行越过上限时照旧轮换，换的位置和一行一行写时一样', async () => {
  const saved = ['CHA_CLAUDE_DEBUG_LOG', 'LITCH_LOG_MAX_BYTES', 'LITCH_LOG_KEEP']
  const previous = saved.map((name) => process.env[name])
  const directory = await mkdtemp(join(tmpdir(), 'claude-rotated-log-'))
  const path = join(directory, 'debug.jsonl')
  Object.assign(process.env, {
    CHA_CLAUDE_DEBUG_LOG: path,
    LITCH_LOG_MAX_BYTES: '400',
    LITCH_LOG_KEEP: '20',
  })
  try {
    for (let index = 0; index < 20; index++)
      debugLog('rotate.test', { index, payload: 'x'.repeat(100) })
    flushDebugLog()
    // 从最老的一份读到正在写的那一份，正好是记的先后；换下来的每一份都不小于上限，
    // 而且少了它的最后一行就小于上限（写那一行之前还没到上限，不该换）
    const files = (await readdir(directory))
      .map((name) => ({ name, slot: name === 'debug.jsonl' ? 0 : Number(name.split('.').pop()) }))
      .sort((a, b) => b.slot - a.slot)
    assert.ok(files.length > 3)
    const read: number[] = []
    for (const { name, slot } of files) {
      const text = await readFile(join(directory, name), 'utf8')
      const lines = text.trim().split('\n')
      read.push(...lines.map((line) => JSON.parse(line).index))
      if (slot === 0) continue
      const last = (lines.at(-1)?.length ?? 0) + 1
      assert.ok(Buffer.byteLength(text) >= 400 && Buffer.byteLength(text) - last < 400, name)
    }
    assert.deepEqual(
      read,
      Array.from({ length: 20 }, (_, index) => index),
    )
  } finally {
    saved.forEach((name, index) => {
      const value = previous[index]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    })
    await rm(directory, { recursive: true, force: true })
  }
})

test('调试日志：同一轮里记完就退出（process.exit），记的行都在、先后不变', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-exit-log-'))
  const path = join(directory, 'debug.jsonl')
  const util = new URL('../src/util.mjs', import.meta.url).href
  const script = `const { debugLog } = await import(${JSON.stringify(util)})
for (let index = 0; index < 50; index++) debugLog('exit.test', { index })
process.exit(3)`
  try {
    const run = promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...isolatedEnv, CHA_CLAUDE_DEBUG_LOG: path },
    })
    await assert.rejects(run, (error: { code?: number }) => error.code === 3)
    assert.deepEqual(
      (await logLines(path)).map((entry) => entry.index),
      Array.from({ length: 50 }, (_, index) => index),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
