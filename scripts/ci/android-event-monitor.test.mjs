import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { replayEvents } from './android-event-monitor.mjs'
import { anrEvent, startAnrWatch } from './android-health.mjs'

const first = '1700000000.000001 100 100 I am_proc_start: [0,123,ready]'
const later = '1700000001.000001 100 100 I am_proc_start: [0,456,later]'
const litch = '1700000000.500001 100 100 I am_anr: [0,123,dev.litch.app,123,input timeout]'

test('完整缓冲区回读核对断点原文，同时间戳及回拨事件不被 -T 过滤掉', () => {
  assert.equal(anrEvent(later.replace('later', 'ANR in dev.litch.app')), null)
  assert.equal(anrEvent(litch).owner, 'litch')
  const sameTime = first.replace('ready', 'another')
  const backdated = later.replace('1700000001', '1699999999')
  const observed = []
  const result = replayEvents(
    [first, sameTime, backdated, litch].join('\n'),
    { timestamp: '1700000000.000001', line: first },
    (line) => observed.push(line),
  )
  assert.equal(result.replayed, 3)
  assert.deepEqual(observed, [first, sameTime, backdated, litch])
  assert.throws(() => replayEvents(sameTime, { line: first }, () => {}), /找不到断点/)
  assert.throws(
    () =>
      replayEvents(
        `${first}\n1700000001.000001 100 100 I chatty: uid=1000 expire 20 lines`,
        { line: first },
        () => {},
      ),
    /丢弃记录/,
  )
})

for (const mode of ['recover', 'litch', 'unknown', 'overwritten', 'reboot']) {
  test(`真实 adb 子进程中断后核对补读：${mode}`, { timeout: 10000 }, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'litch-event-replay-'))
    const state = join(directory, 'buffer.json')
    const adb = join(directory, 'adb')
    const out = join(directory, 'out')
    mkdirSync(out)
    const save = (lines, boot = 'boot-1') => writeFileSync(state, JSON.stringify({ lines, boot }))
    save(first)
    writeFileSync(
      adb,
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
if (args.includes('boot_id')) console.log(data.boot);
else if (args.some(arg => arg.endsWith('/boot_id'))) console.log(data.boot);
else if (args.includes('logcat')) { console.log(data.lines); if (!args.includes('-d')) setInterval(()=>{},1000); }
`,
      { mode: 0o755 },
    )
    let recovered
    const recovery = new Promise((done) => {
      recovered = done
    })
    const watch = startAnrWatch({
      adbBin: adb,
      serial: 'test-device',
      directory: out,
      onRecovery: (event) => {
        if (event.kind === 'recovered') recovered(event)
      },
    })
    t.after(async () => {
      await watch.stop()
      rmSync(directory, { recursive: true, force: true })
    })
    await watch.checkpoint()
    const events = readFileSync(join(out, 'anr-monitor.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse)
    const pid = events.findLast((event) => event.kind === 'stream-start').pid
    save(
      mode === 'overwritten'
        ? later
        : `${first}\n${mode === 'litch' ? litch : mode === 'unknown' ? litch.replace('dev.litch.app', 'unrecognized') : later}`,
      mode === 'reboot' ? 'boot-2' : 'boot-1',
    )
    // 只杀这个观察 adb，不重启 server；新的 ANR 只在断开后的缓冲区里，必须靠回读发现。
    process.kill(pid, 'SIGTERM')
    if (mode === 'recover') {
      const event = await recovery
      assert.equal(event.replayed, 1)
      assert.equal(event.from, '1700000000.000001')
      assert.equal(event.to, '1700000001.000001')
      await watch.checkpoint()
      assert.equal(watch.failure, null)
      assert.ok(readFileSync(join(out, 'anr-monitor.jsonl'), 'utf8').includes('stream-close'))
    } else {
      const failure = await watch.failed
      assert.equal(failure.kind, mode === 'litch' || mode === 'unknown' ? 'anr' : 'monitor')
      assert.equal(failure.owner, mode === 'litch' ? 'litch' : 'unknown')
      if (mode === 'overwritten') assert.match(failure.line, /缓冲区已覆盖/)
      if (mode === 'reboot') assert.match(failure.line, /boot_id 改变/)
      await assert.rejects(watch.checkpoint(), /健康检查失败/)
    }
  })
}
