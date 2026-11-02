import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { anrEvent, currentAnr, waitAndroidReady } from './android-health.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
test('ANR 按进程判定：Litch 主/子进程、系统、未知；普通日志不命中', () => {
  for (const [process, owner] of [
    ['dev.litch.app', 'litch'],
    ['dev.litch.app:worker', 'litch'],
    ['com.google.android.apps.nexuslauncher', 'system'],
    ['dev.litch.application', 'unknown'],
  ]) {
    assert.equal(anrEvent(`I/am_anr( 222): [0,123,${process},0,reason]`).owner, owner)
    assert.equal(anrEvent(`E/ActivityManager( 222): ANR in ${process}`).owner, owner)
  }
  assert.equal(anrEvent('I/am_anr( 2): malformed').owner, 'unknown')
  assert.equal(anrEvent('normal log'), null)
  assert.match(currentAnr('notResponding=true', ''), /notResponding/)
  assert.match(currentAnr('', 'Window{Application Not Responding: Litch}'), /Litch/)
  assert.equal(currentAnr('notResponding=false', 'mCurrentFocus=null'), null)
})

test('预检复用截止时间；命令和状态轮询都不能重新获得完整启动预算', async () => {
  let clock = 999
  const timeouts = []
  await assert.rejects(
    waitAndroidReady({
      deadline: 1000,
      now: () => clock,
      run: async (_args, timeout) => {
        timeouts.push(timeout)
        return 'offline'
      },
      watch: { assert() {} },
      pause: async (ms) => {
        clock += ms
      },
    }),
    /原有启动预算/,
  )
  assert.deepEqual(timeouts, [1])
  assert.equal(clock, 1000)
  await assert.rejects(
    waitAndroidReady({
      deadline: 999,
      now: () => clock,
      run: () => assert.fail('已过期不能调用 ADB'),
      watch: { assert() {} },
    }),
    /原有启动预算/,
  )
})

test('系统就绪依赖五项状态；活动 ANR 提前退出而非等满预算', async () => {
  const seen = []
  const run = async (args) => {
    seen.push(args.join(' '))
    if (args[0] === 'get-state') return 'device'
    if (args.includes('getprop')) return '1'
    if (args.includes('processes')) return 'notResponding=false'
    if (args.includes('window') && !args.includes('windows'))
      return 'mCurrentFocus=Window{abc u0 com.android.launcher/com.android.launcher.Home}'
    if (args.includes('resolve-activity')) return 'com.android.launcher/.Home'
    assert.fail(args.join(' '))
  }
  await waitAndroidReady({
    run,
    deadline: Date.now() + 1000,
    watch: {
      assert() {},
      async checkpoint() {
        seen.push('anr-checkpoint')
      },
    },
  })
  assert.equal(seen.length, 6)
  await assert.rejects(
    waitAndroidReady({
      run: async (args) => (args.includes('processes') ? 'notResponding=true' : run(args)),
      deadline: Date.now() + 1000,
      watch: {
        assert() {},
        async checkpoint() {},
        reportCurrent(line) {
          throw Object.assign(new Error(`当前存在 ANR：${line}`), { fatal: true })
        },
      },
      pause: () => assert.fail('ANR 不轮询等待消失'),
    }),
    /当前存在 ANR/,
  )
})

test('Full 把预检和模拟器启动放在同一个 600 秒预算内', () => {
  const workflow = readFileSync(join(repo, '.github/workflows/full.yml'), 'utf8')
  assert.match(workflow, /emulator-boot-timeout: 600/)
  assert.match(
    workflow,
    /pre-emulator-launch-script: \|\s+node scripts\/ci\/android-diagnostics.mjs host\s+node scripts\/ci\/android-health.mjs mark-start/,
  )
  assert.match(workflow, /LITCH_E2E_BOOT_MARKER: '1'/)
})
