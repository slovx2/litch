// 只截本轮自有 AppKit 窗口一次；遇系统确认立即停止，不代点、不重试、不发送输入。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  MacLauncher,
  PROBE_IDENTITY,
  probeAppPath,
} from '../../.artifacts/integration/remote-driver.mjs'
import { acquireProbeBuildLock } from './shared-probe.mjs'

const output = process.argv[2]
assert(output && !existsSync(output), '需要新的验收记录目录')
const out = resolve(output)
mkdirSync(out, { recursive: true })
const cu = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const root = mkdtempSync('/tmp/litch-cu-capture-')
for (const name of ['home', 'codex']) mkdirSync(join(root, name))
const env = { HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex') }
const bundle = join(out, 'Litch Capture Fixture.app')
const app = 'io.github.slovx2.litch.capture-fixture'
mkdirSync(join(bundle, 'Contents/MacOS'), { recursive: true })
writeFileSync(
  join(bundle, 'Contents/Info.plist'),
  `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${app}</string>
<key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleName</key><string>Litch Capture Fixture</string><key>LSUIElement</key><true/></dict></plist>`,
)
execFileSync(
  'swiftc',
  [
    join(cu, 'probes/background/Fixture.swift'),
    '-o',
    join(bundle, 'Contents/MacOS/Fixture'),
    '-framework',
    'AppKit',
  ],
  { env: { ...process.env, ...env } },
)
execFileSync('codesign', ['--force', '--sign', '-', bundle])
const appPath = probeAppPath()
const launcher = new MacLauncher({
  identity: PROBE_IDENTITY,
  appPath,
  directory: join(root, 'helper'),
  version: null,
  async launch(path, keys) {
    execFileSync('open', [
      '-n',
      '-g',
      '-a',
      path,
      ...Object.entries({ ...keys, ...env, LITCH_CU_PROBE_NO_PRIVATE: '1' }).flatMap(
        ([key, value]) => ['--env', `${key}=${value}`],
      ),
    ])
  },
})
const report = {
  root,
  appPath,
  startedAt: new Date().toISOString(),
  success: false,
  blocked: false,
  foreground: [],
}
const controller = new AbortController()
let client, fixturePid, monitor
try {
  client = await launcher.establish('zh-CN', console.log)
  report.hello = client.hello
  assert.equal(client.hello.bundlePath, appPath)
  let unexpectedRelease
  try {
    unexpectedRelease = await acquireProbeBuildLock(appPath)
    assert.fail('运行中的原生探针必须阻止重建')
  } catch (error) {
    assert.match(error.message, /探针正在运行或构建中/)
    report.runningBuildBlocked = true
  } finally {
    await unexpectedRelease?.()
  }
  report.permissions = await client.request('permissions')
  assert(
    report.permissions.accessibility && report.permissions.screenRecording,
    '缺少既有系统权限；停止，不请求授权',
  )
  const audit = () => {
    try {
      const row = JSON.parse(readFileSync(join(root, 'helper/foreground.json'), 'utf8'))
      if (report.foreground.at(-1)?.frontBundle !== row.frontBundle) report.foreground.push(row)
      if (
        [
          'com.apple.loginwindow',
          'com.apple.SecurityAgent',
          'com.apple.UserNotificationCenter',
        ].includes(row.frontBundle)
      ) {
        report.blocked = true
        controller.abort()
        clearInterval(monitor)
      }
    } catch {}
  }
  audit()
  assert.equal(report.blocked, false, '已有系统确认在前台，停止验收')
  monitor = setInterval(audit, 50)
  execFileSync('open', [
    '-n',
    '-g',
    '-a',
    bundle,
    ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    '--args',
    '--directory',
    join(root, 'fixture'),
    '--role',
    'capture',
  ])
  for (let i = 0; i < 100 && !fixturePid && !report.blocked; i++) {
    try {
      fixturePid = JSON.parse(readFileSync(join(root, 'fixture/state.json'), 'utf8')).pid
    } catch {
      await delay(50)
    }
  }
  assert(fixturePid && !report.blocked, '自有夹具未就绪或已出现系统确认')
  const state = await client.request(
    'getAppState',
    { session: 'capture-check', app, turnId: 'capture-check', actionId: 'capture-once' },
    15000,
    controller.signal,
  )
  assert(state.screenshot?.data, '必须返回实际截图')
  writeFileSync(join(out, 'fixture.jpg'), Buffer.from(state.screenshot.data, 'base64'))
  report.capture = {
    width: state.screenshot.width,
    height: state.screenshot.height,
    window: state.window,
  }
  // 系统确认可能晚于截图结果出现；只观察本轮审计文件，不再请求任何采集或输入。
  for (let i = 0; i < 30 && !report.blocked; i++) await delay(50)
  report.success = !report.blocked
} catch (error) {
  report.error = error.message
  process.exitCode = 1
} finally {
  clearInterval(monitor)
  if (fixturePid) {
    try {
      process.kill(fixturePid, 'SIGTERM')
    } catch {}
  }
  await client?.request('shutdown').catch(() => {})
  client?.close()
  await launcher.afterShutdown()
  report.finishedAt = new Date().toISOString()
  if (report.blocked) process.exitCode = 1
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
