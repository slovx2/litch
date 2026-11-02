// 就绪预检和 ANR 判定不能随普通诊断日志的容量上限停止，也不能重试到绿。
import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startEventMonitor } from './android-event-monitor.mjs'

const appId = 'dev.litch.app'
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

export function anrEvent(line) {
  // 现在读完整 events 缓冲区，只认日志标签；普通事件正文提到 ANR 不算 ANR。
  const parsed = line.match(
    /^(?:[A-Z]\/([\w]+)\s*\([^)]*\)|\s*\d+\.\d+\s+\d+\s+\d+\s+[A-Z]\s+([\w]+))\s*:\s*(.*)$/,
  )
  if (!parsed) return null
  const tag = parsed[1] ?? parsed[2]
  const payload = parsed[3]
  if (tag !== 'am_anr' && !(tag === 'ActivityManager' && /^ANR in\b/.test(payload))) return null
  const process =
    payload.match(/^\[\d+,\d+,([^,\]]+)/)?.[1]?.trim() ?? payload.match(/^ANR in\s+([\w.:]+)/)?.[1]
  const owner =
    process === appId || process?.startsWith(`${appId}:`)
      ? 'litch'
      : process &&
          /^(?:com\.android\.(?:systemui|launcher3)|com\.google\.android\.apps\.nexuslauncher|android|system_server)(?::[\w.]+)?$/.test(
            process,
          )
        ? 'system'
        : 'unknown'
  return { process: process ?? null, owner, line }
}

export function adbCommand(adbBin, serial) {
  return (args, timeout = 15000) =>
    new Promise((done, fail) => {
      execFile(
        adbBin,
        ['-s', serial, ...args],
        { timeout, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => (error ? fail(error) : done(stdout)),
      )
    })
}

/** ANR 和监测缺口均锁存为失败；后续成功不能覆盖。只保存首败，流仍持续消费。 */
export function startAnrWatch({ adbBin, serial, directory, deadline, onRecovery = () => {} }) {
  mkdirSync(directory, { recursive: true })
  const run = adbCommand(adbBin, serial)
  let failure = null
  let settle
  const seen = new Set()
  const failed = new Promise((done) => {
    settle = done
  })
  const fail = (event) => {
    if (seen.has(event.line)) return
    seen.add(event.line)
    const record = { at: new Date().toISOString(), ...event }
    appendFileSync(join(directory, 'anr-events.jsonl'), `${JSON.stringify(record)}\n`)
    if (!failure) {
      failure = { ...record, owners: [event.owner] }
      writeFileSync(
        join(directory, 'anr-first-failure.json'),
        `${JSON.stringify(record, null, 2)}\n`,
      )
    } else {
      failure.owners = [...new Set([...failure.owners, event.owner])]
      // 系统首败不能把随后出现的 Litch 或未知 ANR 包装成可恢复基础设施问题。
      failure.owner = failure.owners.includes('litch')
        ? 'litch'
        : failure.owners.includes('unknown')
          ? 'unknown'
          : 'system'
    }
    writeFileSync(join(directory, 'anr-status.json'), `${JSON.stringify(failure, null, 2)}\n`)
    settle(failure)
  }
  const monitor = startEventMonitor({
    adbBin,
    serial,
    run,
    startupDeadline: deadline,
    onLine(line) {
      const event = anrEvent(line)
      if (event) fail({ kind: 'anr', ...event })
    },
    onFailure(line) {
      fail({ kind: 'monitor', owner: 'unknown', line })
    },
    record(kind, detail) {
      const event = { at: new Date().toISOString(), kind, ...detail }
      appendFileSync(join(directory, 'anr-monitor.jsonl'), `${JSON.stringify(event)}\n`)
      if (kind === 'stream-close' || kind === 'recovered') onRecovery(event)
    },
  })
  return {
    failed,
    get failure() {
      return failure
    },
    assert() {
      if (failure) throw new Error(`Android 健康检查失败：${JSON.stringify(failure)}`)
    },
    reportCurrent(line) {
      fail({ kind: 'anr', owner: 'unknown', process: null, line })
      this.assert()
    },
    // 开始、每条 flow 结束及最终成功前再读取，避免流的缓冲尚未送达就假绿。
    async checkpoint(timeout = 15000) {
      await monitor.checkpoint(timeout)
      this.assert()
    },
    stop() {
      return monitor.stop()
    },
  }
}

/** 不猜弹窗的应用显示名；只从进程或系统事件归属。历史 lastanr 不用于就绪判断。 */
export function currentAnr(activity, windows) {
  const active = activity
    .split('\n')
    .find((line) => /(?:notResponding|mNotResponding)=true/.test(line))
  const dialog = windows.split('\n').find((line) => /Application Not Responding:/.test(line))
  return active ?? dialog ?? null
}

function componentOf(text) {
  const found = text?.match(/([\w.]+)\/(\.?[\w.$]+)/)
  return found ? `${found[1]}/${found[2].startsWith('.') ? found[1] : ''}${found[2]}` : null
}

export async function waitAndroidReady({ run, deadline, watch, now = Date.now, pause = sleep }) {
  let last = '尚未查询'
  const remaining = () => {
    const left = deadline - now()
    if (left <= 0) throw new Error('启动预算耗尽')
    return Math.min(left, 5000)
  }
  const query = (args) => run(args, remaining())
  while (now() < deadline) {
    watch.assert()
    try {
      if ((await query(['get-state'])).trim() !== 'device') throw new Error('ADB 未在线')
      if ((await query(['shell', 'getprop', 'sys.boot_completed'])).trim() !== '1')
        throw new Error('boot_completed 未完成')
      const activity = await query(['shell', 'dumpsys', 'activity', 'processes'])
      // API 35 的 windows 子命令不含 mCurrentFocus，必须读完整 window dump。
      const windows = await query(['shell', 'dumpsys', 'window'])
      const anr = currentAnr(activity, windows)
      if (anr) {
        // 优先取结构化进程名；只有弹窗/进程状态而没有归属证据时按未知处理。
        await watch.checkpoint(remaining())
        watch.reportCurrent(anr)
      }
      const home = (
        await query([
          'shell',
          'cmd',
          'package',
          'resolve-activity',
          '--brief',
          '-a',
          'android.intent.action.MAIN',
          '-c',
          'android.intent.category.HOME',
        ])
      )
        .split('\n')
        .map((line) => line.trim())
        .find((line) => /^[\w.]+\/[\w.$]+$/.test(line))
      if (!home) throw new Error('包管理器未能解析 HOME')
      const focus = windows.split('\n').find((line) => /mCurrentFocus=Window/.test(line))
      if (componentOf(focus) !== componentOf(home))
        throw new Error(`HOME 尚无焦点窗口：${focus ?? '无焦点'}`)
      await watch.checkpoint(remaining())
      if (now() >= deadline) throw new Error('启动预算耗尽')
      return
    } catch (error) {
      if (error.fatal || watch.failure) throw error
      last = error.message
    }
    await pause(Math.max(0, Math.min(1000, deadline - now())))
  }
  throw new Error(`Android 就绪预检超出原有启动预算：${last}`)
}

export async function captureAndroidHealth(run, directory) {
  mkdirSync(directory, { recursive: true })
  for (const service of ['window', 'activity', 'input']) {
    try {
      writeFileSync(
        join(directory, `precheck-${service}.txt`),
        await run(['shell', 'dumpsys', service]),
      )
    } catch (error) {
      appendFileSync(join(directory, 'precheck-errors.txt'), `${service}: ${error.message}\n`)
    }
  }
}

export function bootDeadline(directory) {
  // CI 在 action 的 pre-emulator-launch-script 记下时刻，SDK 下载不占启动预算。
  const start = Number(readFileSync(join(directory, 'emulator-start-ms'), 'utf8'))
  if (!Number.isFinite(start) || start <= 0 || start > Date.now())
    throw new Error('模拟器启动时刻无效')
  return start + 600000
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'mark-start') {
  const directory = process.env.LITCH_E2E_ARTIFACTS
  if (!directory) throw new Error('缺少 LITCH_E2E_ARTIFACTS')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'emulator-start-ms'), String(Date.now()))
}
