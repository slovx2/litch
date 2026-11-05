import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { exportPlist, releaseOptions, verifyApp } from '../../apps/mobile/scripts/archive-ios.mjs'

const env = { LITCH_IOS_TEAM_ID: 'ABCD123456', LITCH_IOS_BUILD_NUMBER: '1.0.1' }
test('签名参数拒绝开发包、不完整 API key 和无效构建号', () => {
  assert.equal(releaseOptions(env).build, '1.0.1')
  for (const patch of [
    { LITCH_MOBILE_DEV: '1' },
    { LITCH_IOS_TEAM_ID: '' },
    { LITCH_IOS_BUILD_NUMBER: '12345' },
    { LITCH_IOS_BUILD_NUMBER: '1.100.1' },
    { LITCH_ASC_KEY_ID: 'ABC' },
  ])
    assert.throws(() => releaseOptions({ ...env, ...patch }))
  assert.throws(
    () =>
      releaseOptions({
        ...env,
        LITCH_ASC_KEY_PATH: new URL('../../private.p8', import.meta.url).pathname,
        LITCH_ASC_KEY_ID: 'ABC123',
        LITCH_ASC_ISSUER_ID: '12345678-1234-1234-1234-123456789abc',
      }),
    /不能放在仓库/,
  )
  assert.ok(
    exportPlist(env.LITCH_IOS_TEAM_ID).includes(
      '<key>manageAppVersionAndBuildNumber</key><false/>',
    ),
  )
})

test('IPA 校验拒绝错误团队、开发签名、ad-hoc、企业、过期和错版本', () => {
  const info = {
    CFBundleIdentifier: 'dev.litch.app',
    CFBundleShortVersionString: '0.33.0',
    CFBundleVersion: '1.0.1',
  }
  const entitlements = {
    'com.apple.developer.team-identifier': 'ABCD123456',
    'get-task-allow': false,
    'application-identifier': 'ABCD123456.dev.litch.app',
    'keychain-access-groups': ['ABCD123456.dev.litch.app'],
  }
  const profile = {
    TeamIdentifier: ['ABCD123456'],
    ExpirationDate: '2099-01-01',
    Entitlements: {
      'get-task-allow': false,
      'application-identifier': entitlements['application-identifier'],
    },
  }
  const expected = { version: '0.33.0', build: '1.0.1', team: 'ABCD123456' }
  verifyApp(info, entitlements, profile, expected)
  for (const patch of [
    { ProvisionedDevices: ['device'] },
    { ProvisionsAllDevices: true },
    { ExpirationDate: '2020-01-01' },
    { TeamIdentifier: ['WRONGTEAM1'] },
  ])
    assert.throws(() => verifyApp(info, entitlements, { ...profile, ...patch }, expected))
  assert.throws(() =>
    verifyApp(info, { ...entitlements, 'get-task-allow': true }, profile, expected),
  )
  assert.throws(() =>
    verifyApp(
      { ...info, CFBundleIdentifier: 'dev.litch.app.dev' },
      entitlements,
      profile,
      expected,
    ),
  )
  assert.throws(() => verifyApp({ ...info, CFBundleVersion: '2' }, entitlements, profile, expected))
})

test('TestFlight 不能绕过已封存候选或换 SHA，上传同一 IPA', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/release.yml', import.meta.url),
    'utf8',
  )
  const job = workflow.split('\n  ios-testflight:\n')[1].split('\n  seal:\n')[0]
  assert.match(job, /needs: \[candidate, seal\]/)
  assert.match(job, /!inputs.bypass-gate/)
  assert.match(job, /needs.seal.result == 'success'/)
  assert.match(job, /ref: \$\{\{ needs.candidate.outputs.sha \}\}/)
  assert.doesNotMatch(job, /upload-artifact|continue-on-error/)
  const script = readFileSync(new URL('./ios-testflight.mjs', import.meta.url), 'utf8')
  assert.match(script, /assert.equal\(sha, process.env.CANDIDATE_SHA/)
  assert.match(script, /result.ipa/)
})
