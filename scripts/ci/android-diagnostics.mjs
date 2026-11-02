// 只观察 CI 模拟器，不重启 ADB/设备、不改变测试结果。掉线前的日志不能等首败后再截尾。
import { execFileSync, spawn } from 'node:child_process'
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs'
import { createConnection } from 'node:net'
import { cpus, freemem, homedir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function cappedWriter(path, limit, onLimit = () => {}) {
  let bytes = 0
  let capped = false
  let broken = false
  writeFileSync(path, '')
  return (chunk) => {
    if (broken) return
    const data = Buffer.from(chunk)
    const take = Math.min(data.length, limit - bytes)
    try {
      if (take > 0) appendFileSync(path, data.subarray(0, take))
    } catch (error) {
      broken = true
      console.warn(`Android 诊断写入失败：${error.message}`)
      return
    }
    bytes += take
    if (take < data.length && !capped) {
      capped = true
      onLimit()
    }
  }
}

/** ADB smart socket：OKAY 后是四位十六进制长度 + 完整设备快照；不能把 TCP chunk 当消息。 */
export function trackerDecoder(onSnapshot) {
  let pending = Buffer.alloc(0)
  let accepted = false
  return (chunk) => {
    pending = Buffer.concat([pending, chunk])
    if (!accepted) {
      if (pending.length < 4) return
      if (pending.subarray(0, 4).toString() !== 'OKAY') throw new Error('ADB 拒绝状态订阅')
      accepted = true
      pending = pending.subarray(4)
    }
    while (pending.length >= 4) {
      const header = pending.subarray(0, 4).toString()
      if (!/^[0-9a-f]{4}$/i.test(header)) throw new Error('ADB 状态帧长度损坏')
      const length = Number.parseInt(header, 16)
      if (pending.length < 4 + length) return
      onSnapshot(pending.subarray(4, 4 + length).toString())
      pending = pending.subarray(4 + length)
    }
  }
}

export function startAndroidDiagnostics({ adbBin, serial, directory, port = 5037 }) {
  mkdirSync(directory, { recursive: true })
  const events = cappedWriter(join(directory, 'android-events.jsonl'), 2 * 1024 * 1024)
  const mark = (kind, data = {}) =>
    events(`${JSON.stringify({ at: new Date().toISOString(), kind, ...data })}\n`)
  const children = new Set()
  const timers = new Set()
  let stopped = false
  let socket
  let disconnected = Promise.resolve()
  let state = 'unknown'
  let logcat = null
  let segments = 0
  let reconnects = 0
  let stopping = null
  let settleReady
  const ready = new Promise((done) => {
    settleReady = done
  })
  const readyTimer = setTimeout(() => {
    mark('tracker-ready-timeout')
    settleReady()
  }, 5000)
  const seen = () => {
    clearTimeout(readyTimer)
    settleReady()
  }
  const later = (run) => {
    if (stopped) return
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (!stopped) run()
    }, 1000)
    timers.add(timer)
  }
  const launch = (args, output) => {
    const child = spawn(adbBin, ['-P', String(port), '-s', serial, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.add(child)
    child.stdout.on('data', output)
    child.stderr.on('data', (chunk) =>
      mark('observer-stderr', { command: args[0], text: String(chunk) }),
    )
    child.on('error', (error) => mark('observer-error', { command: args[0], error: error.message }))
    child.on('close', (code, signal) => {
      children.delete(child)
      mark('observer-close', { command: args[0], code, signal })
    })
    return child
  }
  const startLogcat = () => {
    if (stopped || logcat || state !== 'device' || segments >= 12) return
    const segment = ++segments
    let output
    try {
      output = cappedWriter(
        join(directory, `android-logcat-${segment}.txt`),
        16 * 1024 * 1024,
        () => mark('logcat-capped', { segment }),
      )
    } catch (error) {
      mark('logcat-error', { error: error.message })
      return
    }
    mark('logcat-start', { segment })
    // 仅重接观察流；不重新运行 flow。首次掉线前的段永不覆盖。
    logcat = launch(['logcat', '-b', 'all', '-v', 'epoch', '-T', '1'], output)
    logcat.once('close', () => {
      logcat = null
      later(startLogcat)
    })
  }
  const identity = () => {
    let text = ''
    const child = launch(
      [
        'shell',
        'cat /proc/sys/kernel/random/boot_id; pidof adbd; getprop sys.boot_completed; getprop init.svc.adbd; getprop sys.usb.state; getprop ro.build.fingerprint',
      ],
      (chunk) => {
        if (text.length < 4096) text += chunk
      },
    )
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    child.once('close', () => {
      clearTimeout(timer)
      mark('guest-identity', { text })
    })
  }
  const connect = () => {
    const decode = trackerDecoder((snapshot) => {
      const next =
        snapshot
          .split('\n')
          .map((line) => line.trim().split(/\s+/))
          .find((parts) => parts[0] === serial)?.[1] ?? 'absent'
      mark('transport', { serial, state: next, previous: state, snapshot })
      if (next !== state) {
        state = next
        if (state === 'device') {
          identity()
          startLogcat()
        }
      }
      seen()
    })
    socket = createConnection({ host: '127.0.0.1', port }, () => {
      const request = 'host:track-devices-l'
      socket.write(`${request.length.toString(16).padStart(4, '0')}${request}`)
    })
    disconnected = new Promise((done) => socket.once('close', done))
    socket.on('data', (chunk) => {
      try {
        decode(chunk)
      } catch (error) {
        mark('tracker-error', { error: error.message })
        socket.destroy()
      }
    })
    socket.on('error', (error) => {
      mark('tracker-error', { error: error.message })
      seen()
    })
    socket.on('close', () => {
      mark('tracker-close')
      state = 'unknown'
      // 仅重新订阅 host 状态，不能启动或重启 ADB server。
      if (!stopped && reconnects++ < 3) later(connect)
    })
  }
  connect()
  return {
    ready,
    mark,
    stop() {
      stopping ??= (async () => {
        stopped = true
        seen()
        for (const timer of timers) clearTimeout(timer)
        socket.destroy()
        await Promise.all([
          disconnected,
          ...[...children].map(
            (child) =>
              new Promise((done) => {
                const timer = setTimeout(() => child.kill('SIGKILL'), 1500)
                child.once('close', () => {
                  clearTimeout(timer)
                  done()
                })
                child.kill('SIGTERM')
              }),
          ),
        ])
        mark('diagnostics-stop')
      })()
      return stopping
    },
  }
}

function hostDiagnostics(mode) {
  if (process.env.GITHUB_ACTIONS !== 'true')
    throw new Error('宿主日志采集仅用于隔离的 GitHub runner')
  const directory = process.env.LITCH_E2E_ARTIFACTS
  if (!directory) throw new Error('缺少 LITCH_E2E_ARTIFACTS')
  mkdirSync(directory, { recursive: true })
  const sdk = process.env.ANDROID_HOME
  const run = (binary, args) => {
    try {
      return execFileSync(binary, args, {
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      })
    } catch (error) {
      return `ERROR: ${error.message}`
    }
  }
  const read = (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  }
  if (mode === 'host') {
    const data = {
      at: new Date().toISOString(),
      os: process.platform,
      arch: process.arch,
      cpu: cpus().map(({ model }) => model),
      totalmem: totalmem(),
      freemem: freemem(),
      runner: process.env.RUNNER_NAME,
      image: process.env.ImageVersion,
      adb: run(join(sdk, 'platform-tools/adb'), ['version']),
      emulator: read(join(sdk, 'emulator/source.properties')),
      systemImage: read(join(sdk, 'system-images/android-35/google_apis/x86_64/source.properties')),
      avd: read(
        join(
          process.env.ANDROID_AVD_HOME ?? join(homedir(), '.android/avd'),
          'test.avd/config.ini',
        ),
      ),
      acceleration: run(join(sdk, 'emulator/emulator'), ['-accel-check']),
      memory: read('/proc/meminfo'),
    }
    writeFileSync(join(directory, 'android-host.json'), `${JSON.stringify(data, null, 2)}\n`)
    console.log(
      `Android 宿主：${data.cpu[0]} × ${data.cpu.length}；${data.totalmem} bytes；${data.acceleration.trim()}`,
    )
  } else if (mode === 'collect') {
    const status = run(join(sdk, 'platform-tools/adb'), ['server-status'])
    writeFileSync(join(directory, 'adb-server-status.txt'), status)
    const match = status.match(/^log_absolute_path: (".*")$/m)
    if (!match) throw new Error('ADB 没报告宿主日志路径')
    const fd = openSync(JSON.parse(match[1]), 'r')
    try {
      const data = Buffer.alloc(32 * 1024 * 1024)
      const count = readSync(fd, data, 0, data.length, 0)
      writeFileSync(join(directory, 'adb-server.log'), data.subarray(0, count))
      if (count === data.length) console.warn('ADB 宿主日志达到32MiB，保留开头，可能已截断')
    } finally {
      closeSync(fd)
    }
  } else throw new Error('诊断模式须为 host 或 collect')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    hostDiagnostics(process.argv[2])
  } catch (error) {
    // 诊断缺失必须可见，但不能覆盖测试的首败或把失败变绿。
    console.warn(`::warning::Android 诊断采集失败：${error.message}`)
  }
}
