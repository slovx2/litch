// 独立签名宿主验证真实 iOS Go/Keychain；CA 仅装进专用模拟器，结束即重置其 Keychain。
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [simulator, fixturePath, tailnetPath] = process.argv.slice(2)
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
try {
  const config = join(artifacts, 'validation.json')
  writeFileSync(
    config,
    JSON.stringify({ target: fixture.target, controlURL: tailnet.controlURL }),
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
  execFileSync('ruby', [
    join(mobile, 'scripts/ios-network-test-project.rb'),
    artifacts,
    mobile,
    config,
  ])
  execFileSync('xcrun', ['simctl', 'keychain', simulator, 'add-root-cert', tailnet.ca])
  child = spawn(
    'xcodebuild',
    [
      '-project',
      join(artifacts, 'NetworkTests.xcodeproj'),
      '-scheme',
      'NetworkTests',
      '-destination',
      `platform=iOS Simulator,id=${simulator}`,
      '-derivedDataPath',
      join(artifacts, 'build'),
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
  execFileSync('xcrun', ['simctl', 'keychain', simulator, 'reset'])
  try {
    execFileSync('xcrun', ['simctl', 'uninstall', simulator, 'dev.litch.networkhost'])
  } catch {}
  rmSync(artifacts, { recursive: true })
}
