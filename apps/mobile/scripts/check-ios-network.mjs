// 独立签名宿主验证真实 iOS Go/Keychain；CA 仅装进专用模拟器，结束即重置其 Keychain。
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { iosTestHelper } from './ios-test-helper.mjs'

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [simulator, fixturePath, tailnetPath, mode] = process.argv.slice(2)
if (mode && !['ui', 'pairing', 'cold', 'regression'].includes(mode))
  throw new Error('仅支持省略模式、ui、pairing、cold 或 regression')
const devices = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', '--json']))
const device = Object.values(devices.devices)
  .flat()
  .find((entry) => entry.udid === simulator)
if (!device?.name.startsWith('Litch-iOS-Network'))
  throw new Error('只允许可重置 Keychain 的 Litch-iOS-Network 专用模拟器')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
const tailnet = JSON.parse(readFileSync(tailnetPath, 'utf8'))
if (!fixture.work?.startsWith('/tmp/litch-ssh-')) throw new Error('需要隔离 SSH 夹具')
mkdirSync(join(mobile, '.artifacts'), { recursive: true })
const artifacts = mkdtempSync(join(mobile, '.artifacts/ios-network-'))
let child
let helper
try {
  const config = join(artifacts, 'validation.json')
  if (mode) helper = await iosTestHelper(fixture, artifacts, simulator)
  const remote = new URL('litch-dev://remote')
  remote.searchParams.set('adapter', fixture.adapter)
  remote.searchParams.set('env', 'LITCH_FX_MODE=svc')
  writeFileSync(
    config,
    JSON.stringify(
      helper
        ? { helper: helper.url, controlURL: tailnet.controlURL, remote: remote.href }
        : { target: fixture.target, controlURL: tailnet.controlURL },
    ),
    { mode: 0o600 },
  )
  writeFileSync(
    join(artifacts, 'Host.swift'),
    `import UIKit
@main final class Host: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    window = UIWindow(frame: UIScreen.main.bounds)
    window?.rootViewController = UIViewController()
    window?.makeKeyAndVisible()
    return true
  }
}
`,
  )
  writeFileSync(
    join(artifacts, 'Host.entitlements'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>keychain-access-groups</key><array>
<string>$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER)</string>
</array></dict></plist>`,
  )
  execFileSync(
    'ruby',
    mode
      ? [
          join(mobile, 'scripts/ios-test-project.rb'),
          artifacts,
          join(
            mobile,
            'e2e/ios',
            {
              ui: 'TailscaleUITests.swift',
              pairing: 'PairingUITests.swift',
              cold: 'TerminalColdStartTests.swift',
              regression: 'UIRegressionTests.swift',
            }[mode],
          ),
          config,
        ]
      : [join(mobile, 'scripts/ios-network-test-project.rb'), artifacts, mobile, config],
  )
  execFileSync('xcrun', ['simctl', 'keychain', simulator, 'add-root-cert', tailnet.ca])
  if (mode === 'pairing') {
    // 配对从空设备列表开始，不能让上次失败留下的设备配置掩盖结果。
    execFileSync('xcrun', ['simctl', 'uninstall', simulator, 'dev.litch.app.dev'])
    execFileSync('xcrun', [
      'simctl',
      'install',
      simulator,
      join(mobile, 'ios/build/Build/Products/Release-iphonesimulator/LitchDev.app'),
    ])
  }
  child = spawn(
    'xcodebuild',
    [
      '-project',
      join(artifacts, mode ? 'TerminalTests.xcodeproj' : 'NetworkTests.xcodeproj'),
      '-scheme',
      mode ? 'TerminalTests' : 'NetworkTests',
      '-destination',
      `platform=iOS Simulator,id=${simulator}`,
      '-derivedDataPath',
      join(artifacts, 'build'),
      ...(process.env.LITCH_IOS_TEST_ONLY
        ? [`-only-testing:${process.env.LITCH_IOS_TEST_ONLY}`]
        : []),
      'test',
    ],
    { stdio: 'inherit' },
  )
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
  process.exitCode = await new Promise((done, fail) => {
    child.on('exit', (code) => done(code ?? 1))
    child.on('error', fail)
  })
} finally {
  await helper?.stop()
  execFileSync('xcrun', ['simctl', 'keychain', simulator, 'reset'])
  try {
    execFileSync('xcrun', ['simctl', 'uninstall', simulator, 'dev.litch.networkhost'])
  } catch {}
  rmSync(artifacts, { recursive: true })
}
