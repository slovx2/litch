// 用法：node scripts/ci/local-mac-fallback.mjs --run 123 [--dry-run]
// 本机只测试并签署证明；不会重跑Prepare、修改远端设置、签名产品或公开Release。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createPrivateKey, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkEnvelope, checkHistory } from './local-mac-policy.mjs'
import { readSmallArtifact, sourceState } from './local-mac-remote.mjs'
import { api, gh, pages, validateArtifact } from './release-artifacts.mjs'
import { isolatedEnvironment } from './run-checks.mjs'

const args = process.argv.slice(2)
const dry = args.includes('--dry-run')
const at = args.indexOf('--run')
assert.ok(
  at >= 0 && /^[1-9]\d*$/.test(args[at + 1] ?? ''),
  '必须指定 --run <ID>；单独SHA不能证明容量失败',
)
assert.ok(
  args.every((arg, index) => arg === '--dry-run' || arg === '--run' || index === at + 1),
  '未知参数',
)
const repository = 'slovx2/litch'
const runId = Number(args[at + 1])
assert.ok(Number.isSafeInteger(runId))
const run = api(`repos/${repository}/actions/runs/${runId}`)
const context = { repository, runId, sha: run.head_sha }
assert.equal(run.status, 'completed', '先等原run完全结束，不与托管检查竞争')
const state = sourceState(context)
const job = state.history.findLast((item) => ['failure', 'cancelled'].includes(item.conclusion))
assert.ok(job, '没有容量失败的Mac检查')
const source = { ...context, attempt: job.run_attempt, jobId: job.id }
checkHistory(state.history, source, state.name)
assert.equal(
  state.branch.commit.sha,
  context.sha,
  '来源分支已经移动，不能在不同工作流SHA上传证明；请在原SHA的受保护release分支准备新run',
)
const listed = pages(
  `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
  'artifacts',
)
const name = `mac-native-request-${source.attempt}`
const matches = listed.filter((item) => item.name === name && !item.expired)
assert.equal(matches.length, 1, '来源没有唯一的Mac请求清单；旧版工作流不支持兜底')
const artifact = validateArtifact(matches[0], { run: runId, sha: context.sha, name })
// gh登录态只用于控制器API，不交给被测试代码。
if (!process.env.GH_TOKEN)
  process.env.GH_TOKEN = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
const request = await readSmallArtifact(repository, artifact, 'mac-native-request.json')
for (const key of ['repository', 'sha', 'runId', 'attempt']) assert.equal(request[key], source[key])
console.log(JSON.stringify({ source, selected: request.selected, dryRun: dry }))
if (dry) process.exit(0)
assert.equal(process.platform, 'darwin')
assert.equal(process.arch, 'arm64')
const keyPath = process.env.LITCH_LOCAL_MAC_SIGNING_KEY
assert.ok(keyPath, '请由维护者配置 LITCH_LOCAL_MAC_SIGNING_KEY（独立Ed25519 PEM私钥路径）')
const publicKey = api(`repos/${repository}/actions/variables/LITCH_LOCAL_MAC_PUBLIC_KEY`).value
// 源码放在工作区，不放/tmp；测试配置及下载缓存只在本次目录内。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const parent = join(root, '.artifacts')
mkdirSync(parent, { recursive: true })
const temp = mkdtempSync(join(parent, 'local-mac-'))
const home = join(temp, 'home')
const checkout = join(temp, 'source')
mkdirSync(home)
mkdirSync(checkout)
// 允许列表避免把个人模型、SSH、npm、云服务凭据带进测试；HOME隔离不是OS安全沙箱。
const env = isolatedEnvironment(
  { PATH: process.env.PATH, TMPDIR: temp, LANG: 'en_US.UTF-8', CI: '1' },
  home,
)
Object.assign(env, {
  GITHUB_REPOSITORY: repository,
  GITHUB_SHA: context.sha,
  GITHUB_RUN_ID: String(runId),
  GITHUB_RUN_ATTEMPT: String(source.attempt),
  GITHUB_WORKSPACE: checkout,
  RUNNER_TEMP: temp,
  NATIVE_DOMAINS: JSON.stringify(request.selected),
  npm_config_cache: join(temp, 'npm-cache'),
  electron_config_cache: join(temp, 'electron-cache'),
  GOCACHE: join(temp, 'go-cache'),
  GOMODCACHE: join(temp, 'go-modules'),
})
const execute = (command, argv, capture = false) =>
  execFileSync(command, argv, {
    cwd: checkout,
    env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  })
try {
  execute('git', ['init', '--quiet'])
  execute('git', ['fetch', '--depth=1', `https://github.com/${repository}.git`, context.sha])
  execute('git', ['checkout', '--detach', '--quiet', 'FETCH_HEAD'])
  assert.equal(execute('git', ['rev-parse', 'HEAD'], true).trim(), context.sha)
  const environment = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    os: execute('sw_vers', ['-productVersion'], true).trim(),
    go: execute('go', ['version'], true).trim(),
    xcode: execute('xcodebuild', ['-version'], true).trim(),
    sdk: execute('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version'], true).trim(),
    ruby: execute('ruby', ['-e', 'print RUBY_VERSION'], true).trim(),
  }
  const startedAt = new Date().toISOString()
  execute(process.execPath, ['scripts/ci/prepare-mac-native.mjs'])
  // 构建生成的未跟踪文件正常；任何已跟踪源码被改动均不可签署。
  execute('git', ['diff', '--exit-code', 'HEAD'])
  const payload = JSON.stringify({
    schema: 1,
    source,
    environment,
    startedAt,
    completedAt: new Date().toISOString(),
    proof: JSON.parse(readFileSync(join(checkout, 'mac-native-proof.json'))),
  })
  const key = createPrivateKey(readFileSync(keyPath))
  assert.equal(key.asymmetricKeyType, 'ed25519')
  const envelope = {
    schema: 1,
    payload,
    signature: sign(null, Buffer.from(payload), key).toString('base64'),
  }
  checkEnvelope(envelope, publicKey, context, request.selected)
  const encoded = Buffer.from(JSON.stringify(envelope)).toString('base64')
  assert.ok(encoded.length < 60000, '证明超过dispatch输入上限')
  // 上传前再次核验原run，防止测试期间发生产品失败或分支移动。
  const latest = sourceState(context)
  assert.equal(latest.run.run_attempt, run.run_attempt)
  assert.equal(latest.branch.commit.sha, context.sha)
  checkHistory(latest.history, source, latest.name)
  gh(
    [
      'api',
      `repos/${repository}/actions/workflows/local-mac-proof.yml/dispatches`,
      '--method',
      'POST',
      '--input',
      '-',
    ],
    {
      input: JSON.stringify({
        ref: run.head_branch,
        inputs: { 'source-run': String(runId), envelope: encoded },
      }),
    },
  )
  console.log(
    `证明已提交接收工作流，等待local-mac-fallback环境审批。通过后由维护者重跑原run ${runId} 的Mac路由及下游：gh api repos/${repository}/actions/jobs/${latest.routeId}/rerun --method POST。本命令不重跑发版。`,
  )
} finally {
  rmSync(temp, { recursive: true, force: true })
}
