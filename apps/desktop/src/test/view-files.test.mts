// 存在这台电脑上的会话视图（src/view-files.mts）：写放到下一拍、读回来、太大砍回合、超了个数删最早的、换版本不用、去掉设备一起删
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SessionView } from '@litch/core'
import { viewFiles } from '../view-files.mjs'

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

/** 一个有 turns 个回合的视图，每个回合一条 size 个字的回答 */
function view(sessionId: string, turns = 1, size = 10, deviceId = 'd1'): SessionView {
  const items: Record<string, unknown> = {}
  const list = []
  for (let n = 0; n < turns; n++) {
    items[`m${n}`] = { kind: 'agentMessage', id: `m${n}`, text: 'x'.repeat(size) }
    list.push({ id: `t${n}`, status: 'completed', itemIds: [`m${n}`] })
  }
  return {
    deviceId,
    sessionId,
    harness: 'codex',
    settings: {},
    live: true,
    turns: list,
    items,
    requests: [],
    queued: [],
  } as unknown as SessionView
}

test('存了下一拍才写；写之前读得到等着写的那份，写完从文件读回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'litch-views-'))
  const store = viewFiles(dir, '1.0.0').views('d1')
  store.save(view('a'))
  assert.deepEqual(readdirSync(dir), [])
  assert.equal(store.load('a')?.sessionId, 'a')
  await tick()
  assert.ok(readdirSync(dir).includes('index.json'))
  const fresh = viewFiles(dir, '1.0.0').views('d1')
  assert.equal(fresh.load('a')?.turns.length, 1)
  assert.equal(fresh.load('b'), null)
  // 别的设备的同名会话不混
  assert.equal(viewFiles(dir, '1.0.0').views('d2').load('a'), null)
})

test('换了版本当没存过，旧文件清掉', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'litch-views-'))
  viewFiles(dir, '1.0.0').views('d1').save(view('a'))
  await tick()
  const next = viewFiles(dir, '1.0.1').views('d1')
  assert.equal(next.load('a'), null)
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.startsWith('view-')),
    [],
  )
})

test('一份太大：砍掉一半回合再存，留最近的', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'litch-views-'))
  const files = viewFiles(dir, '1.0.0')
  files.views('d1').save(view('a', 4, 600_000))
  await tick()
  const back = viewFiles(dir, '1.0.0').views('d1').load('a')
  assert.deepEqual(
    back?.turns.map((turn) => turn.id),
    ['t2', 't3'],
  )
})

test('超过 24 个：删存得最早的', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'litch-views-'))
  const store = viewFiles(dir, '1.0.0').views('d1')
  for (let n = 0; n < 25; n++) {
    store.save(view(`s${n}`))
    await tick()
  }
  const back = viewFiles(dir, '1.0.0').views('d1')
  assert.equal(back.load('s0'), null)
  assert.equal(back.load('s24')?.sessionId, 's24')
  assert.equal(readdirSync(dir).filter((name) => name.startsWith('view-')).length, 24)
})

test('会话删了、设备去掉了：文件一起删；坏文件当没存过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'litch-views-'))
  const files = viewFiles(dir, '1.0.0')
  files.views('d1').save(view('a'))
  files.views('d1').save(view('b'))
  files.views('d2').save(view('c', 1, 10, 'd2'))
  await tick()
  files.views('d1').forget('a')
  assert.equal(viewFiles(dir, '1.0.0').views('d1').load('a'), null)
  files.forgetDevice('d1')
  const back = viewFiles(dir, '1.0.0')
  assert.equal(back.views('d1').load('b'), null)
  assert.equal(back.views('d2').load('c')?.sessionId, 'c')
  const [file] = readdirSync(dir).filter((name) => name.startsWith('view-'))
  writeFileSync(join(dir, file ?? 'x'), '{broken')
  assert.equal(viewFiles(dir, '1.0.0').views('d2').load('c'), null)
})
