// 共享检查执行器：仅去掉重复构建，不改断言/超时；失败和跳过都不能形成完整证明。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { checkPlan, expectsNodeTests } from './check-catalog.mjs'
import { cliInventory } from './install-test-clis.mjs'

export function coverage(output) {
  const names = []
  const totals = { tests: 0, fail: 0, skipped: 0, cancelled: 0 }
  for (const line of stripVTControlCharacters(output).split('\n')) {
    const text = line.trim()
    const spec = /^[✔✖﹣] (.+?)(?: \([\d.]+ms\))?(?: # .*)?$/.exec(text)
    const tap = /^# Subtest: (.+)$/.exec(text)
    if (spec || tap) names.push((spec || tap)[1])
    const summary = /^(?:ℹ|#) (tests|fail|skipped|cancelled) (\d+)$/.exec(text)
    if (summary) totals[summary[1]] += Number(summary[2])
  }
  return { ...totals, names: names.sort() }
}

export function isolatedEnvironment(env, home) {
  const result = { ...env }
  for (const key of Object.keys(result)) {
    if (
      /^(LITCH_|ANTHROPIC_|OPENAI_|CLAUDE_CODE_|GH_|GITHUB_TOKEN$)/.test(key) ||
      /(?:_API_KEY|_AUTH_TOKEN)$/.test(key)
    )
      delete result[key]
  }
  delete result.NODE_TEST_CONTEXT
  delete result.NODE_OPTIONS
  delete result.ELECTRON_RUN_AS_NODE
  return {
    ...result,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CHA_CLAUDE_HOME: join(home, '.claude'),
    DSH_HOME: join(home, '.dsh'),
    PI_CODING_AGENT_DIR: join(home, '.pi'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CACHE_HOME: join(home, 'cache'),
    NODE_DISABLE_COLORS: '1',
    FORCE_COLOR: '0',
  }
}

function commandRun(command, env) {
  return new Promise((resolveRun, reject) => {
    const binary = command[0] === 'node' ? process.execPath : command[0]
    const child = spawn(binary, command.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    let bytes = 0
    let overflow = false
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        process.stdout.write(chunk)
        bytes += chunk.length
        if (bytes <= 32 * 1024 ** 2) chunks.push(chunk)
        else {
          overflow = true
          child.kill('SIGTERM')
        }
      })
    }
    child.once('error', reject)
    child.once('close', (code, signal) =>
      resolveRun({
        code: overflow ? 1 : (code ?? 1),
        signal,
        output: Buffer.concat(chunks).toString(),
        overflow,
      }),
    )
  })
}

export async function executeChecks(
  plan,
  { execute = commandRun, env = process.env, built = false, onResult = () => {} } = {},
) {
  for (const cli of plan.clis) {
    const key = `CHA_${cli}_CLI`
    assert.ok(env[key], `缺少隔离 CLI：${key}`)
    accessSync(env[key], constants.X_OK)
  }
  if (plan.desktopBuild && !built) {
    const build = await execute(['npm', 'run', 'client:build'], env)
    assert.equal(build.code, 0, '桌面准备失败')
  }
  const results = []
  for (const check of plan.checks) {
    console.log(`CI_CHECK_START ${check.id}`)
    const at = performance.now()
    const result = await execute(check.command, env)
    const tests = coverage(result.output)
    const item = {
      id: check.id,
      code: result.code,
      signal: result.signal ?? null,
      seconds: (performance.now() - at) / 1000,
      tests,
    }
    results.push(item)
    onResult(item)
    console.log(`CI_CHECK_RESULT ${JSON.stringify(item)}`)
    assert.equal(result.code, 0, `检查失败：${check.id}`)
    assert.equal(item.signal, null, `检查被中断：${check.id}`)
    assert.equal(tests.fail + tests.cancelled + tests.skipped, 0, `检查不完整：${check.id}`)
    // Node 测试集合必须有实际用例；不能把空目录或 reporter 丢失算作等价。
    if (expectsNodeTests(check.id)) {
      assert.ok(tests.tests > 0 && tests.names.length > 0, `没有用例清单：${check.id}`)
    }
  }
  return results
}

async function main() {
  const args = process.argv.slice(2)
  const built = args.includes('--built')
  const names = args.filter((value) => value !== '--built')
  const plan = checkPlan(names)
  const home = mkdtempSync(join(tmpdir(), 'litch-checks-'))
  const proof = {
    schema: 1,
    repository: process.env.GITHUB_REPOSITORY ?? null,
    sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    runId: process.env.GITHUB_RUN_ID ?? null,
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 0),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    versions: JSON.parse(readFileSync('protocol/versions.json', 'utf8')),
    plan,
    complete: false,
    results: [],
  }
  try {
    proof.clis = cliInventory(plan.clis, proof.versions)
    const env = isolatedEnvironment(process.env, home)
    Object.assign(
      env,
      JSON.parse(
        execFileSync('go', ['env', '-json', 'GOCACHE', 'GOMODCACHE'], { encoding: 'utf8' }),
      ),
    )
    await executeChecks(plan, { env, built, onResult: (result) => proof.results.push(result) })
    proof.complete = true
  } finally {
    if (process.env.CI_CHECK_REPORT) {
      const file = resolve(process.env.CI_CHECK_REPORT)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(proof, null, 2)}\n`)
    }
    rmSync(home, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
