import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkApkBuildMode } from '../../../scripts/ci/apk-build-mode.mjs'
import configure from '../app.config.js'

test('APK 产物按显式档位验收，缺失和错档不能作为发布包或 E2E 包', () => {
  for (const e2e of [false, true]) {
    checkApkBuildMode({ extra: { litchE2E: e2e } }, e2e)
    for (const value of [undefined, null, !e2e, String(e2e), Number(e2e)])
      assert.throws(() => checkApkBuildMode({ extra: { litchE2E: value } }, e2e))
    assert.throws(() => checkApkBuildMode({}, e2e))
  }
})

test('Expo 配置默认关闭入口，显式 E2E 开启，分发签名构建拒绝 E2E', () => {
  const names = ['EXPO_PUBLIC_LITCH_E2E', 'LITCH_ANDROID_KEYSTORE', 'LITCH_IOS_BUILD_NUMBER']
  const saved = names.map((name) => process.env[name])
  try {
    for (const name of names) delete process.env[name]
    assert.equal(configure({ config: {} }).extra.litchE2E, false)
    process.env.EXPO_PUBLIC_LITCH_E2E = '1'
    assert.equal(configure({ config: {} }).extra.litchE2E, true)
    for (const name of names.slice(1)) {
      process.env[name] = name === 'LITCH_IOS_BUILD_NUMBER' ? '1' : '/test/release.p12'
      assert.throws(() => configure({ config: {} }), /分发构建不能开启 E2E/)
      delete process.env[name]
    }
  } finally {
    names.forEach((name, index) => {
      if (saved[index] === undefined) delete process.env[name]
      else process.env[name] = saved[index]
    })
  }
})
