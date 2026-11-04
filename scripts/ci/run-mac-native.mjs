// Mac检查只共用准备和构建，不改变每个探针的超时、断言或原有可选原生用例。
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliInventory } from './install-test-clis.mjs'
import { iosReadiness } from './ios-checks.mjs'
import { nativePlan } from './mac-native-plan.mjs'
import { isolatedEnvironment } from './run-checks.mjs'

assert.equal(process.platform, 'darwin')
assert.equal(process.arch, 'arm64')
const plan = nativePlan(JSON.parse(process.env.NATIVE_DOMAINS))
const home = mkdtempSync(join(tmpdir(), 'litch-native-'))
const env = isolatedEnvironment(process.env, home)
// 两项都由工作流指定到runner临时目录，不能沿用个人设备或模型配置。
for (const name of ['LITCH_CHROME_BINARY', 'LITCH_PROJECTIONS_OUTPUT']) {
  if (process.env[name]) env[name] = process.env[name]
}
Object.assign(
  env,
  JSON.parse(execFileSync('go', ['env', '-json', 'GOCACHE', 'GOMODCACHE'], { encoding: 'utf8' })),
)
const proof = {
  schema: 1,
  repository: process.env.GITHUB_REPOSITORY,
  sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workflowSha: process.env.GITHUB_SHA,
  runId: Number(process.env.GITHUB_RUN_ID),
  attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  platform: process.platform,
  arch: process.arch,
  plan,
  ios: plan.domains.includes('ios') ? iosReadiness() : null,
  clis: cliInventory(
    plan.domains.some((name) => ['client-engines', 'adapters'].includes(name))
      ? ['CLAUDE', 'DSH']
      : [],
    JSON.parse(readFileSync('protocol/versions.json')),
  ),
  complete: false,
  results: [],
}
try {
  for (const check of plan.checks) {
    console.log(`MAC_CHECK_START ${check.id}`)
    const at = performance.now()
    const [binary, ...args] = check.command
    const result = spawnSync(binary === 'node' ? process.execPath : binary, args, {
      env,
      stdio: 'inherit',
    })
    const item = {
      id: check.id,
      code: result.status ?? 1,
      signal: result.signal ?? null,
      seconds: (performance.now() - at) / 1000,
    }
    proof.results.push(item)
    console.log(`MAC_CHECK_RESULT ${JSON.stringify(item)}`)
    assert.equal(item.code, 0, `Mac检查失败：${check.id}`)
    assert.equal(item.signal, null)
  }
  proof.complete = true
} finally {
  writeFileSync('mac-native-proof.json', `${JSON.stringify(proof, null, 2)}\n`)
  rmSync(home, { recursive: true, force: true })
}
