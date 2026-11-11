// macOS 隔离验收：Launch Services 后台启动，窗口单独最小化，进程身份按独有 profile 核对。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { withChromiumTestArgs } from '../../third_party/litch-automation/scripts/chromium-test-args.mjs'
import { until } from '../chrome-m0/cdp.mjs'

export async function minimizeTarget(cdp, targetId) {
  const { windowId } = await cdp.call('Browser.getWindowForTarget', { targetId })
  await cdp.call('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
  await until(
    async () =>
      (await cdp.call('Browser.getWindowBounds', { windowId })).bounds.windowState === 'minimized',
    'minimized background Chrome window',
  )
}

export async function launchBackgroundChrome(binary, args, env, profile) {
  assert.ok(binary.includes('Google Chrome for Testing.app/Contents/MacOS/'))
  assert.ok(args.includes(`--user-data-dir=${profile}`))
  const app = binary.slice(0, binary.indexOf('.app/Contents/MacOS/') + 4)
  const launcher = spawn(
    '/usr/bin/open',
    [
      '-g',
      '-n',
      '-W',
      '-a',
      app,
      ...Object.entries(env)
        .filter(([, value]) => value !== undefined)
        .flatMap(([key, value]) => ['--env', `${key}=${value}`]),
      '--args',
      ...withChromiumTestArgs(args),
    ],
    { env, stdio: 'ignore' },
  )
  try {
    const pid = await until(() => {
      if (launcher.exitCode !== null)
        throw Error(`Background Chrome launch exited: ${launcher.exitCode}`)
      const matches = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
        .split('\n')
        .filter(
          (line) =>
            line.includes(binary) &&
            line.includes(`--user-data-dir=${profile}`) &&
            !line.includes('--type='),
        )
      assert.ok(matches.length <= 1, 'isolated profile must identify only one Chrome process')
      return matches[0] ? Number(matches[0].trim().split(/\s+/)[0]) : null
    }, 'background Chrome process')
    return {
      pid,
      get exitCode() {
        return launcher.exitCode
      },
      once: launcher.once.bind(launcher),
      kill(signal) {
        try {
          process.kill(pid, signal)
        } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      },
    }
  } catch (error) {
    launcher.kill('SIGTERM')
    throw error
  }
}

export async function foregroundGuard(work) {
  const executable = join(work, 'foreground-watch')
  execFileSync('/usr/bin/xcrun', [
    'swiftc',
    fileURLToPath(new URL('./foreground-watch.swift', import.meta.url)),
    '-o',
    executable,
  ])
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  const records = []
  let errors = ''
  child.stderr.on('data', (value) => {
    errors += value
  })
  createInterface({ input: child.stdout }).on('line', (line) => records.push(JSON.parse(line)))
  const next = (token) =>
    until(() => {
      if (child.exitCode !== null) throw Error(`Frontmost application monitor exited: ${errors}`)
      return records.find((record) => record.token === token)
    }, `NSWorkspace ${token}`)
  try {
    const baseline = await next('ready')
    assert.ok(baseline.pid > 0, 'a frontmost user application must exist')
    let sequence = 0
    let violation
    return {
      async check(stage) {
        if (violation) throw violation
        const token = `checkpoint-${++sequence}`
        child.stdin.write(`${token}\n`)
        const current = await next(token)
        const changed = records.filter((record) => record.pid > 0 && record.pid !== baseline.pid)
        try {
          assert.deepEqual(
            changed,
            [],
            `NSWorkspace: foreground application changed during ${stage}; baseline ${JSON.stringify(baseline)}`,
          )
          assert.equal(current.pid, baseline.pid, `NSWorkspace: foreground before/after ${stage}`)
        } catch (error) {
          violation = error
          throw error
        }
      },
      async close() {
        child.stdin.end()
        if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve))
      },
    }
  } catch (error) {
    child.kill('SIGTERM')
    throw error
  }
}
