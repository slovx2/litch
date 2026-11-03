// Full 的测试 APK 验签与 manifest 校验；不把调试证书当作正式发版身份。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function checkManifest(badging, expected) {
  const pkg = badging.match(/^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m)
  assert.ok(pkg, 'APK 缺少可识别的 package manifest')
  assert.equal(pkg[1], expected.package, 'APK package 不符')
  assert.equal(pkg[3], expected.version, 'APK versionName 不符')
  assert.ok(Number(pkg[2]) > 0, 'APK versionCode 必须为正整数')
  assert.match(badging, /^launchable-activity:/m, 'APK 缺少启动 Activity')
  const abis = [...(badging.match(/^native-code: (.+)$/m)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(
    (entry) => entry[1],
  )
  assert.ok(abis.includes('x86_64'), '测试 APK 缺少 x86_64 原生库')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const apk = process.argv[2]
  assert.ok(apk, '用法：check-mobile-apk.mjs APK路径')
  assert.ok(process.env.ANDROID_HOME, '缺少 ANDROID_HOME')
  // 与当前 Expo/RN 构建选用的精确版本一致，不依赖 runner 的“最新”预装工具。
  const tools = join(process.env.ANDROID_HOME, 'build-tools', '36.0.0')
  execFileSync(join(tools, 'apksigner'), ['verify', '--verbose', resolve(apk)], {
    stdio: 'inherit',
  })
  const badging = execFileSync(join(tools, 'aapt2'), ['dump', 'badging', resolve(apk)], {
    encoding: 'utf8',
  })
  const { expo } = JSON.parse(
    readFileSync(new URL('../../apps/mobile/app.json', import.meta.url), 'utf8'),
  )
  checkManifest(badging, { package: expo.android.package, version: expo.version })
  console.log(
    `测试 APK 签名与 manifest 通过：${expo.android.package} ${expo.version} x86_64；不作为正式发布证书证明`,
  )
}
