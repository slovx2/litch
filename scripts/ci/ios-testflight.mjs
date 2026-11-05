// 只在独立 CI runner 执行。密钥来自 GitHub secrets，退出时清理临时明文及签名钥匙串。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { archive } from '../../apps/mobile/scripts/archive-ios.mjs'

assert.equal(process.env.GITHUB_ACTIONS, 'true', '此包装器只允许隔离 GitHub runner')
assert.equal(process.platform, 'darwin')
for (const name of [
  'LITCH_ASC_PRIVATE_KEY',
  'LITCH_ASC_KEY_ID',
  'LITCH_ASC_ISSUER_ID',
  'LITCH_IOS_TEAM_ID',
  'LITCH_IOS_BUILD_NUMBER',
  'CANDIDATE_SHA',
  'RUNNER_TEMP',
])
  assert.ok(process.env[name], `缺少 ${name}`)
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
assert.equal(sha, process.env.CANDIDATE_SHA, 'iOS 必须使用通过门禁的源码 SHA')
const temp = mkdtempSync(join(process.env.RUNNER_TEMP, 'litch-ios-signing-'))
const keychain = join(temp, 'signing.keychain-db')
const password = randomBytes(32).toString('hex')
const security = (args, options = {}) =>
  execFileSync('/usr/bin/security', args, { stdio: 'pipe', ...options })
const original =
  security(['list-keychains', '-d', 'user'])
    .toString()
    .match(/"([^"]+)"/g)
    ?.map((value) => value.slice(1, -1)) ?? []
const originalDefault = security(['default-keychain', '-d', 'user'])
  .toString()
  .trim()
  .replace(/^"|"$/g, '')
let keychainCreated = false
try {
  const keyPath = join(temp, `AuthKey_${process.env.LITCH_ASC_KEY_ID}.p8`)
  writeFileSync(keyPath, process.env.LITCH_ASC_PRIVATE_KEY, { mode: 0o600 })
  delete process.env.LITCH_ASC_PRIVATE_KEY
  process.env.LITCH_ASC_KEY_PATH = keyPath
  security(['create-keychain', '-p', password, keychain])
  keychainCreated = true
  security(['set-keychain-settings', '-lut', '21600', keychain])
  security(['unlock-keychain', '-p', password, keychain])
  security(['list-keychains', '-d', 'user', '-s', keychain, ...original])
  security(['default-keychain', '-d', 'user', '-s', keychain])
  const result = archive()
  // 上传刚验证并计算摘要的同一个 IPA，不重新构建或重新导出。
  execFileSync(
    'xcrun',
    [
      'altool',
      '--upload-app',
      '-f',
      result.ipa,
      '-t',
      'ios',
      '--apiKey',
      process.env.LITCH_ASC_KEY_ID,
      '--apiIssuer',
      process.env.LITCH_ASC_ISSUER_ID,
    ],
    { stdio: 'inherit', env: { ...process.env, API_PRIVATE_KEYS_DIR: temp } },
  )
  if (process.env.GITHUB_STEP_SUMMARY)
    writeFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### iOS TestFlight 上传已接受\n\n源码：${sha}\n\n版本/构建：${result.proof.version} (${result.proof.build})\n\nIPA SHA-256：${result.proof.sha256}\n\n仍需在 App Store Connect 确认处理、出口合规与内部测试组；未提交 App Store 审核。\n`,
      { flag: 'a' },
    )
} finally {
  try {
    if (keychainCreated) {
      try {
        security(['default-keychain', '-d', 'user', '-s', originalDefault])
        security(['list-keychains', '-d', 'user', '-s', ...original])
      } finally {
        security(['delete-keychain', keychain])
      }
    }
  } finally {
    // 只清理由本进程创建的唯一目录，不遍历或清理用户钥匙串。
    for (const name of readdirSync(temp)) rmSync(join(temp, name), { force: true })
    rmSync(temp, { recursive: true, force: true })
  }
}
