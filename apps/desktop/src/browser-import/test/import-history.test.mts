// 读浏览记录：90 天、子框架不算、时间换算；拷到私有临时目录只读打开、用完删；WAL 里还没落盘的也读得到；不跟符号链接。
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { readHistory } from '../history.mjs'
import { writeChromiumHistory, writeFirefoxPlaces } from './sample.mjs'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 20, 12)

/** 临时目录换成测试自己的，结束时看里面是不是空的（拷贝都删了） */
const scratch = (t: { after(fn: () => void): void }) => {
  const dir = mkdtempSync(join(tmpdir(), 'litch-import-history-'))
  const temp = join(dir, 'tmp')
  const saved = process.env.TMPDIR
  process.env.TMPDIR = temp
  mkdirSync(temp)
  t.after(() => {
    if (saved === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = saved
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, leftovers: () => readdirSync(temp) }
}

test('Chromium 的 History：90 天以内、子框架不算，时间换成 Unix 毫秒', async (t) => {
  const { dir, leftovers } = scratch(t)
  const profile = join(dir, 'Default')
  writeChromiumHistory(join(profile, 'History'), [
    { url: 'https://a.example/', title: 'A', at: NOW - DAY },
    { url: 'https://a.example/', title: 'A', at: NOW - 2 * DAY },
    { url: 'https://frame.example/', title: '', at: NOW - DAY, type: 3 },
    { url: 'https://frame2.example/', title: '', at: NOW - DAY, type: 0x30000004 },
    { url: 'chrome://settings/', title: 'Settings', at: NOW - DAY },
    { url: 'https://old.example/', title: 'Old', at: NOW - 91 * DAY },
  ])
  const before = readFileSync(join(profile, 'History'))
  const result = await readHistory('chromium', profile, {
    now: NOW,
    signal: new AbortController().signal,
  })
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.visits, [
    { url: 'https://a.example/', title: 'A', visitedAt: NOW - 2 * DAY },
    { url: 'https://a.example/', title: 'A', visitedAt: NOW - DAY },
    { url: 'chrome://settings/', title: 'Settings', visitedAt: NOW - DAY },
  ])
  // 来源没被动过，拷贝删干净了
  assert.deepEqual(readFileSync(join(profile, 'History')), before)
  assert.deepEqual(leftovers(), [])
})

test('Firefox 的 places.sqlite：浏览器开着、改动还在 WAL 里也读得到', async (t) => {
  const { dir, leftovers } = scratch(t)
  const profile = join(dir, 'p')
  const file = join(profile, 'places.sqlite')
  writeFirefoxPlaces(file, [{ url: 'https://one.example/', title: 'One', at: NOW - DAY }])
  // 假装 Firefox 开着：WAL 模式、连接不关，新写的只在 -wal 里
  const live = new DatabaseSync(file)
  t.after(() => live.close())
  live.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;')
  live
    .prepare('INSERT INTO moz_places(id, url, title) VALUES (?, ?, ?)')
    .run(50, 'https://two.example/', 'Two')
  live
    .prepare('INSERT INTO moz_historyvisits(place_id, visit_date, visit_type) VALUES (?, ?, ?)')
    .run(50, (NOW - 3 * DAY) * 1000, 2)
  live
    .prepare('INSERT INTO moz_historyvisits(place_id, visit_date, visit_type) VALUES (?, ?, ?)')
    .run(50, (NOW - 3 * DAY) * 1000, 8)
  assert.ok(statSync(`${file}-wal`).size > 0)
  const result = await readHistory('firefox', profile, {
    now: NOW,
    signal: new AbortController().signal,
  })
  assert.equal(result.status, 'ok')
  assert.deepEqual(
    result.visits.map((visit) => [visit.url, visit.visitedAt]),
    [
      ['https://two.example/', NOW - 3 * DAY],
      ['https://one.example/', NOW - DAY],
    ],
  )
  assert.deepEqual(leftovers(), [])
})

test('没有库是 missing；是符号链接不跟；坏的库是 failed；取消了是 cancelled；都不留拷贝', async (t) => {
  const { dir, leftovers } = scratch(t)
  const signal = new AbortController().signal
  const missing = await readHistory('chromium', join(dir, 'none'), { now: NOW, signal })
  assert.equal(missing.status, 'missing')

  const real = join(dir, 'real')
  writeChromiumHistory(join(real, 'History'), [{ url: 'https://a.example/', title: 'A', at: NOW }])
  const linked = join(dir, 'linked')
  mkdirSync(linked)
  symlinkSync(join(real, 'History'), join(linked, 'History'))
  const link = await readHistory('chromium', linked, { now: NOW, signal })
  assert.equal(link.status, 'failed')

  const broken = join(dir, 'broken')
  mkdirSync(broken)
  writeFileSync(join(broken, 'History'), 'not a database at all, just text')
  const bad = await readHistory('chromium', broken, { now: NOW, signal })
  assert.equal(bad.status, 'failed')

  const controller = new AbortController()
  controller.abort()
  const cancelled = await readHistory('chromium', real, { now: NOW, signal: controller.signal })
  assert.equal(cancelled.status, 'cancelled')
  assert.deepEqual(leftovers(), [])
})
