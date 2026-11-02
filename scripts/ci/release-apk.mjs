import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function checkApkManifest(badging, version, packageName) {
  const [major, minor, patch] = version.split('.').map(Number)
  const code = major * 1_000_000 + minor * 1000 + patch
  const pkg = /^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/m.exec(badging)
  assert.ok(pkg, 'APK 缺少 package manifest')
  assert.equal(pkg[1], packageName, 'APK packageName')
  assert.equal(pkg[2], String(code), 'APK versionCode')
  assert.equal(pkg[3], version, 'APK versionName')
  assert.ok(!/^application-debuggable/m.test(badging), '正式 APK 不允许 debuggable')
  assert.match(badging, /^native-code: 'arm64-v8a'\s*$/m, 'APK ABI')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sdk = join(process.env.ANDROID_HOME, 'build-tools')
  const tool = readdirSync(sdk)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .at(-1)
  const badging = execFileSync(join(sdk, tool, 'aapt'), ['dump', 'badging', process.argv[2]], {
    encoding: 'utf8',
  })
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
  const { expo } = JSON.parse(readFileSync('apps/mobile/app.json', 'utf8'))
  assert.equal(expo.version, version, '手机版本必须与候选相同')
  checkApkManifest(badging, version, expo.android.package)
  console.log(`APK manifest/版本/ABI 已验证：${expo.android.package} ${version}`)
}
