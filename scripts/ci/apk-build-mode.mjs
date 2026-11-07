// 读取 APK 内的 Expo 配置；release 构建也可能是 E2E 包，不能只看 debuggable。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

export function checkApkBuildMode(config, e2e) {
  assert.equal(config.extra?.litchE2E, e2e, 'APK 的 E2E 开发入口档位不符合预期')
}

export function auditApkBuildMode(apk, e2e) {
  const config = JSON.parse(
    execFileSync('unzip', ['-p', apk, 'assets/app.config'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }),
  )
  checkApkBuildMode(config, e2e)
}
