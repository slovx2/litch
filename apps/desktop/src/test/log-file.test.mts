// 桌面端自己的日志（src/log-file.mts）：轮转、按时长和个数清理、console 的输出也落盘
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createDesktopLog, logLimits, pruneLogs, teeConsole } from '../log-file.mjs'

const lines = (path: string) =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)

test('上限默认 10MB、5 个、7 天，三个变量可调', () => {
  assert.deepEqual(logLimits({}), {
    maxBytes: 10 * 1024 * 1024,
    keep: 5,
    maxAgeMs: 7 * 24 * 3600 * 1000,
  })
  assert.deepEqual(
    logLimits({ LITCH_LOG_MAX_BYTES: '100', LITCH_LOG_KEEP: '0', LITCH_LOG_MAX_AGE_DAYS: 'x' }),
    { maxBytes: 100, keep: 1, maxAgeMs: 7 * 24 * 3600 * 1000 },
  )
})

test('到了上限换新文件，最多留 keep 个，每行带时间、级别、来源、事件', () => {
  const directory = mkdtempSync(join(tmpdir(), 'litch-desktop-log-'))
  const path = join(directory, 'logs', 'core.jsonl')
  let clock = Date.UTC(2026, 9, 22)
  const log = createDesktopLog(path, {
    source: 'core',
    limits: { maxBytes: 250, keep: 2, maxAgeMs: 0 },
    now: () => clock,
  })
  for (let index = 0; index < 10; index += 1) {
    log.write('command', { command: 'device.reconnect', ok: true, index })
    log.flush()
    clock += 1000
  }
  assert.deepEqual(readdirSync(join(directory, 'logs')).sort(), ['core.jsonl', 'core.jsonl.1'])
  const last = lines(path).at(-1)
  assert.equal(last?.src, 'core')
  assert.equal(last?.event, 'command')
  assert.equal(last?.level, 'info')
  assert.equal(last?.index, 9)
  assert.equal(last?.ts, new Date(clock - 1000).toISOString())
})

test('太久没写的旧文件删掉，编号超出的删掉', () => {
  const directory = mkdtempSync(join(tmpdir(), 'litch-desktop-prune-'))
  const now = Date.UTC(2026, 9, 22)
  const write = (name: string, ageDays: number) => {
    writeFileSync(join(directory, name), '{}\n')
    const at = new Date(now - ageDays * 24 * 3600 * 1000)
    utimesSync(join(directory, name), at, at)
  }
  write('main.jsonl', 1)
  write('main.jsonl.1', 8)
  write('main.jsonl.2', 2)
  write('main.jsonl.6', 0)
  pruneLogs(
    join(directory, 'main.jsonl'),
    { maxBytes: 0, keep: 5, maxAgeMs: 7 * 24 * 3600 * 1000 },
    now,
  )
  assert.deepEqual(readdirSync(directory).sort(), ['main.jsonl', 'main.jsonl.2'])
})

test('console.error、console.warn 原样输出，也记一份', () => {
  const directory = mkdtempSync(join(tmpdir(), 'litch-desktop-tee-'))
  const path = join(directory, 'main.jsonl')
  const log = createDesktopLog(path, { source: 'main' })
  const original = { error: console.error, warn: console.warn }
  const printed: unknown[][] = []
  console.error = (...args: unknown[]) => printed.push(args)
  console.warn = (...args: unknown[]) => printed.push(args)
  try {
    teeConsole(log)
    console.error('[update]', '检查更新失败')
    console.warn('小心')
  } finally {
    console.error = original.error
    console.warn = original.warn
  }
  log.flush()
  assert.deepEqual(printed, [['[update]', '检查更新失败'], ['小心']])
  assert.deepEqual(
    lines(path).map(({ event, level, text }) => ({ event, level, text })),
    [
      { event: 'log', level: 'info', text: '[update] 检查更新失败' },
      { event: 'log', level: 'warn', text: '小心' },
    ],
  )
})
