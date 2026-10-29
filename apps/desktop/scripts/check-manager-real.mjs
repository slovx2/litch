// 正式桌面外壳 + managed 隔离设备 + 真实 Claude Code / 原生 Codex；模型只用回环夹具。
// npm run client:check:manager-real -- [--show] [--skip-missing]
// Claude 必须给 CHA_CLAUDE_CLI 隔离副本；Codex 用 CHA_CODEX_CLI 或 PATH。
// 默认隐藏窗口，--show 显示同一个真实窗口。缺 CLI 默认失败，显式跳过会标明不完整。
// 不启用 CDP：独立引导程序加载正式 dist/main.mjs，经 webContents 操作界面并截图。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'
import { startManagerFixture } from '../../../scripts/client-fixture-manager-check.mjs'
import { findCodex } from '../../../scripts/client-fixture-responses.mjs'

const { values } = parseArgs({
  options: { show: { type: 'boolean' }, 'skip-missing': { type: 'boolean' } },
})
const repo = fileURLToPath(new URL('../../..', import.meta.url))
const require = createRequire(import.meta.url)
const engines = {}
const skipped = []
for (const id of ['claude-code', 'codex']) {
  try {
    const cli = id === 'claude-code' ? process.env.CHA_CLAUDE_CLI?.trim() : findCodex()
    if (!cli)
      throw new Error(id === 'claude-code' ? '未给 CHA_CLAUDE_CLI 隔离副本' : 'PATH 中没有 codex')
    accessSync(cli, constants.X_OK)
    engines[id === 'codex' ? 'CHA_CODEX_CLI' : 'CHA_CLAUDE_CLI'] = cli
  } catch (error) {
    skipped.push({ harness: id, reason: error.message })
  }
}
if (skipped.length && !values['skip-missing']) {
  console.error('经理真实界面验收未运行：缺少命令行。', skipped)
  console.error('只有显式传 --skip-missing 才允许跳过；跳过不算完整验收。')
  process.exit(1)
}
const ids = ['claude-code', 'codex'].filter((id) => !skipped.some((s) => s.harness === id))
const directory = join(
  repo,
  '.artifacts/manager-real',
  new Date().toISOString().replaceAll(':', '-'),
)
mkdirSync(directory, { recursive: true })
const cleanup = []
let child
let stopped = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopped = true
    child?.kill('SIGTERM')
  })
}
let failed = false
try {
  for (const entry of skipped) console.log(`没验：${entry.harness}：${entry.reason}`)
  if (!ids.length) throw new Error('没有可验收的 harness（不完整）')
  const fixture = await startManagerFixture({ after: (fn) => cleanup.push(fn) }, engines)
  if (stopped) throw new Error('验收被中止')
  // 放进夹具自己的临时根，收场沿用它的清理；不在仓库写生成物。
  const scratch = mkdtempSync(join(fixture.root, 'desktop-'))
  const home = join(scratch, 'home')
  mkdirSync(home)
  const versions = Object.fromEntries(
    Object.entries(engines).map(([key, cli]) => {
      const version = spawnSync(cli, ['--version'], {
        env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, '.codex') },
        encoding: 'utf8',
        timeout: 15_000,
      })
      assert.equal(version.status, 0, `${key} 无法读取版本：${version.stderr || version.error}`)
      return [key, version.stdout.trim()]
    }),
  )
  // 只读配置取证：Codex 由 managed 服务运行，必须使用夹具生成的独立配置目录。
  if (ids.includes('codex')) {
    const settings = JSON.parse(
      readFileSync(join(fixture.root, 'h/device/settings.json'), 'utf8'),
    ).values
    const env = settings['harness.codex.env']
    assert.equal(env.find((entry) => entry.name === 'CODEX_HOME')?.value, join(fixture.root, 'cx'))
    assert.ok(!env.some((entry) => entry.name.startsWith('OPENAI_')))
  }
  console.log(`隔离设备就绪：${JSON.stringify(versions)}；窗口${values.show ? '显示' : '隐藏'}`)
  const bootstrap = join(scratch, 'manager-real.mjs')
  await build({
    entryPoints: [join(repo, 'apps/desktop/src/probe-manager-real.mts')],
    outfile: bootstrap,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['electron'],
  })
  let output = ''
  child = spawn(require('electron'), [bootstrap], {
    cwd: repo,
    // 白名单，既不带个人模型凭据，也不从登录 shell 补进来。
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: join(home, '.codex'),
      TMPDIR: scratch,
      LITCH_PROFILE: join(scratch, 'profile'),
      LITCH_ENTRY: fixture.socket,
      LITCH_LANG: 'zh-CN',
      LITCH_MANAGER_REAL: JSON.stringify({
        ids,
        cwd: fixture.engines.cwd,
        directory,
        show: Boolean(values.show),
        main: pathToFileURL(join(repo, 'apps/desktop/dist/main.mjs')).href,
      }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let pending = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop()
    for (const line of lines) if (line.startsWith('LITCH_MANAGER_REAL ')) console.log(line)
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 900_000)
  let code
  try {
    code = await new Promise((resolve, reject) => {
      child.once('exit', resolve)
      child.once('error', reject)
    })
  } finally {
    clearTimeout(timer)
    writeFileSync(join(directory, 'desktop.log'), output)
  }
  const summary = output.split('\n').find((line) => line.startsWith('LITCH_MANAGER_RESULT '))
  if (!summary) throw new Error(`桌面外壳未返回结果（退出码 ${code}）：${output.slice(-5000)}`)
  const result = JSON.parse(summary.slice('LITCH_MANAGER_RESULT '.length))
  writeFileSync(
    join(directory, 'result.json'),
    JSON.stringify({ ...result, versions, show: Boolean(values.show), skipped }, null, 2),
  )
  console.log(`\n步骤 ｜ ${ids.join(' ｜ ')}`)
  for (const step of result.steps) {
    console.log(
      `${step} ｜ ${ids.map((id) => result.rows[id]?.[step]?.status ?? '没验：前序失败').join(' ｜ ')}`,
    )
  }
  failed = code !== 0 || result.failed.length > 0
  if (failed) console.error(result.failed.join('\n'))
} catch (error) {
  failed = true
  console.error(error)
} finally {
  for (const close of cleanup.reverse()) {
    try {
      await close()
    } catch (error) {
      failed = true
      console.error(error)
    }
  }
}
console.log(`截图与结果：${directory}`)
console.log(
  `经理真实界面验收${failed ? '未通过' : '通过'}${skipped.length ? '（不完整：跳过缺失 harness）' : ''}`,
)
process.exit(stopped ? 130 : failed ? 1 : 0)
