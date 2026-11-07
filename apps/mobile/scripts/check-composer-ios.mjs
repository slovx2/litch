// 在已安装本分支 E2E 开发包的 Litch-iOS 专用模拟器上检查输入框和用量菜单。
// node scripts/check-composer-ios.mjs <UDID>；XCUITest 不使用 Maestro 的 7001 端口。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const mobile = fileURLToPath(new URL('..', import.meta.url))
const serial = process.argv[2]
const devices = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', '--json']))
const device = Object.values(devices.devices)
  .flat()
  .find((one) => one.udid === serial)
assert.ok(
  device?.name.startsWith('Litch-iOS-') && device.state === 'Booted',
  '只接受已启动的专用 iOS 模拟器',
)
const work = mkdtempSync(join(tmpdir(), 'litch-composer-ios-'))
let child
try {
  const config = join(work, 'validation.json')
  writeFileSync(config, '{}')
  execFileSync(process.env.RUBY ?? 'ruby', [
    join(mobile, 'scripts/ios-test-project.rb'),
    work,
    join(mobile, 'e2e/ios/ComposerLayoutUITests.swift'),
    config,
  ])
  child = spawn(
    'xcodebuild',
    [
      '-project',
      join(work, 'TerminalTests.xcodeproj'),
      '-scheme',
      'TerminalTests',
      '-destination',
      `platform=iOS Simulator,id=${serial}`,
      '-derivedDataPath',
      join(work, 'build'),
      '-parallel-testing-enabled',
      'NO',
      'CODE_SIGNING_ALLOWED=NO',
      'test',
    ],
    { stdio: 'inherit' },
  )
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('exit', (code) => resolve(code ?? 1))
    child.once('error', reject)
  })
} finally {
  rmSync(work, { recursive: true })
}
