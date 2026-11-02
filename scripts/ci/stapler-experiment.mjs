// 同一 Accepted 包、同一 ARM runner、平衡顺序；不重试单次样本，不改变产品断言。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkpointContext,
  restoreCheckpoint,
} from '../../apps/desktop/scripts/macos-checkpoint.mjs'
import { isStaplerNetworkFailure } from '../../apps/desktop/scripts/notarize.mjs'

assert.equal(process.platform, 'darwin')
assert.equal(process.arch, 'arm64')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const dir = process.argv[2]
const context = checkpointContext()
const results = []
const status = () => {
  const result = spawnSync('sudo', ['pfctl', '-s', 'info'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  return /Status: (Enabled|Disabled)/.exec(result.stdout)?.[1]
}
const original = status()
assert.ok(original)
for (const [index, mode] of [
  'default',
  'tcp',
  'tcp',
  'default',
  'tcp',
  'default',
  'default',
  'tcp',
].entries()) {
  const out = mkdtempSync(join(tmpdir(), 'litch-stapler-trial-'))
  try {
    const { app, dmg } = await restoreCheckpoint(dir, out, context)
    for (const [kind, file] of [
      ['dmg', dmg],
      ['app', app],
    ]) {
      let stapled = false
      for (const operation of ['staple', 'validate']) {
        if (operation === 'validate' && !stapled) {
          console.log(
            `STAPLER_SKIPPED ${JSON.stringify({ trial: index + 1, mode, kind, operation, reason: '本轮 staple 未成功，不能将缺票计为网络失败' })}`,
          )
          continue
        }
        const start = Date.now()
        const result =
          mode === 'tcp'
            ? spawnSync('bash', ['scripts/ci/stapler-tcp.sh', operation, file], {
                encoding: 'utf8',
                timeout: 90_000,
              })
            : spawnSync('xcrun', ['stapler', operation, file], {
                encoding: 'utf8',
                timeout: 60_000,
              })
        const row = {
          trial: index + 1,
          mode,
          kind,
          operation,
          status: result.status,
          networkFailure: isStaplerNetworkFailure(result),
          elapsedMs: Date.now() - start,
        }
        results.push(row)
        if (operation === 'staple') stapled = result.status === 0
        console.log(`STAPLER_TRIAL ${JSON.stringify(row)}`)
        if (result.stdout) process.stdout.write(result.stdout)
        if (result.stderr) process.stderr.write(result.stderr)
        assert.equal(status(), original, '实验后 PF 状态未恢复')
        if (result.status !== 0 && !row.networkFailure)
          throw new Error('非已知票据网络错误，停止实验并保留原输出')
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}
const summary = ['default', 'tcp'].map((mode) => {
  const sample = results.filter((row) => row.mode === mode)
  return {
    mode,
    commands: sample.length,
    failures: sample.filter((row) => row.status !== 0).length,
    networkFailures: sample.filter((row) => row.networkFailure).length,
  }
})
console.log(`STAPLER_RESULT ${JSON.stringify(summary)}`)
appendFileSync(
  process.env.GITHUB_STEP_SUMMARY,
  `\n## ARM 票据网络对照\n\n同一 Accepted 包，ABBA/BAAB，每条件4轮，每轮 DMG/App 的 staple/validate 各一次，不重试。PF 原始状态 ${original}，每次 TCP 命令后已核对恢复。\n\n\`\`\`json\n${JSON.stringify({ summary, results }, null, 2)}\n\`\`\`\n`,
)
