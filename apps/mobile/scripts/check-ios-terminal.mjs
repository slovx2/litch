// 独立 XCUITest：逐字符、系统粘贴、拼音候选都经真实 UIKit/WebKit 输入链。
// 使用专用模拟器和隔离 sshd；不启动 Maestro，不占其全机 7001 端口。
// testInputDisconnect 自己占用 8765 配置口：fixture.mjs 不要带 --serve。LITCH_TERMINAL_KEEP=1 保留验收证据。
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { iosTestHelper } from './ios-test-helper.mjs'
import { installTerminalAudit } from './terminal-audit.mjs'
import { terminalInputRelay } from './terminal-input-relay.mjs'

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [simulator, configPath, ...tests] = process.argv.slice(2)
const devices = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', '--json']))
const device = Object.values(devices.devices)
  .flat()
  .find((entry) => entry.udid === simulator)
if (!device?.name.startsWith('Litch-iOS-')) throw new Error('必须使用专用 iOS 模拟器')
const config = JSON.parse(readFileSync(configPath, 'utf8'))
mkdirSync(join(mobile, '.artifacts'), { recursive: true })
const artifacts = mkdtempSync(join(mobile, '.artifacts/ios-native-'))
let relay
let helper
let child
try {
  relay = tests.includes('testInputDisconnect') ? await terminalInputRelay(config) : null
  helper = await iosTestHelper(config, artifacts, simulator, relay)
  installTerminalAudit(config)
  writeFileSync(join(config.work, 'e2e-shell-commands.txt'), '')
  writeFileSync(join(config.work, 'e2e-mark.txt'), '')
  const settings = join(artifacts, 'validation.json')
  const link = new URL('litch-dev://terminal')
  link.searchParams.set('device', 'fixture')
  link.searchParams.set('root', config.work)
  writeFileSync(
    settings,
    JSON.stringify({ helper: helper.url, work: config.work, terminal: link.href }),
  )
  execFileSync('ruby', [
    join(mobile, 'scripts/ios-test-project.rb'),
    artifacts,
    join(mobile, 'e2e/ios/TerminalInputTests.swift'),
    settings,
  ])
  try {
    execFileSync('xcrun', ['simctl', 'terminate', simulator, 'dev.litch.app.dev'], {
      stdio: 'ignore',
    })
  } catch {
    // 测试开始前应用可以尚未启动。
  }
  const args = [
    '-project',
    join(artifacts, 'TerminalTests.xcodeproj'),
    '-scheme',
    'TerminalTests',
    '-destination',
    `platform=iOS Simulator,id=${simulator}`,
    '-derivedDataPath',
    join(artifacts, 'build'),
    'CODE_SIGNING_ALLOWED=NO',
    'test',
  ]
  for (const test of tests) {
    if (!/^test[A-Za-z]+$/.test(test)) throw new Error('无效测试方法')
    args.push(`-only-testing:TerminalTests/TerminalInputTests/${test}`)
  }
  child = spawn('xcodebuild', args, { stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
  process.exitCode = await new Promise((done, fail) => {
    child.on('exit', (code) => done(code ?? 1))
    child.on('error', fail)
  })
} finally {
  await helper?.stop()
  await relay?.stop()
  if (process.env.LITCH_TERMINAL_KEEP === '1') console.log(`终端验收证据：${artifacts}`)
  else rmSync(artifacts, { recursive: true })
}
