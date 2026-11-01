// 经理与工作线的后台命令在界面上的状态：正式桌面外壳（默认隐藏窗口）+ managed 隔离设备 + 真实 Claude Code；
// 模型只用回环夹具（“后台跑”起一条 sleep 放到后台）。Claude 必须给 CHA_CLAUDE_CLI 隔离副本。
//   npm run client:check:manager-background-real -- [--show]
// 判定：经理自己有后台命令时侧栏用后台记号、对话页有后台任务行，右侧页能看到命令、用时、停止；
// 只有工作线在跑时经理行不画成“运行中”，而是写明几条工作线在跑。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { accessSync, constants, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'
import { startManagerFixture } from '../../../scripts/client-fixture-manager-check.mjs'

const { values } = parseArgs({ options: { show: { type: 'boolean' } } })
const repo = fileURLToPath(new URL('../../..', import.meta.url))
const require = createRequire(import.meta.url)
const cli = process.env.CHA_CLAUDE_CLI?.trim()
if (!cli) {
  console.error('需要 CHA_CLAUDE_CLI 指向隔离的 Claude Code 命令行')
  process.exit(1)
}
accessSync(cli, constants.X_OK)
const directory = join(
  repo,
  '.artifacts/manager-background-real',
  new Date().toISOString().replaceAll(':', '-'),
)
mkdirSync(directory, { recursive: true })

/** 每一步的期望；返回没达到的说明 */
const expectations = {
  '02-own-background': (e) => [
    e.bar?.count === '1' || `经理页输入框上方没有“1 个后台任务”：${JSON.stringify(e.bar)}`,
    e.tasks?.some((task) => task.title.includes('sleep') && task.stop) ||
      `后台任务页没有可停止的 sleep 命令：${JSON.stringify(e.tasks)}`,
    /\bbg\b/.test(e.row?.mark ?? '') || `侧栏经理行没有后台记号：${JSON.stringify(e.row)}`,
    e.row?.label.includes('后台任务') || `侧栏经理行没写后台任务：${JSON.stringify(e.row)}`,
  ],
  '03-own-finished': (e) => [
    !e.bar || `后台命令跑完后仍有后台任务行：${JSON.stringify(e.bar)}`,
    !/\b(run|bg)\b/.test(e.row?.mark ?? '') || `跑完后经理行仍有状态记号：${JSON.stringify(e.row)}`,
  ],
  '04-line-background': (e) => [
    !/\brun\b/.test(e.row?.mark ?? '') ||
      `经理自己空闲、只有工作线在跑，经理行却画成运行中：${JSON.stringify(e.row)}`,
    e.row?.label.includes('工作线') || `经理行没写明工作线在跑：${JSON.stringify(e.row)}`,
    !e.managerBar || `经理自己没有后台命令，经理页却有后台任务行：${JSON.stringify(e.managerBar)}`,
    /\bbg\b/.test(e.lineMark ?? '') || `工作线行没有后台记号：${e.lineMark}`,
  ],
  '05-line-page': (e) => [
    e.bar?.count === '1' || `工作线页没有“1 个后台任务”：${JSON.stringify(e.bar)}`,
    e.tasks?.some((task) => task.title.includes('sleep') && task.stop) ||
      `工作线页的后台任务页没有可停止的命令：${JSON.stringify(e.tasks)}`,
  ],
}

const cleanup = []
let child
let failed = []
try {
  const fixture = await startManagerFixture(
    { after: (fn) => cleanup.push(fn) },
    // 后台命令睡 60 秒，回合结束后留出观察和截图的时间
    { CHA_CLAUDE_CLI: cli, LITCH_FIXTURE_BG_SECONDS: '60' },
  )
  const scratch = mkdtempSync(join(fixture.root, 'desktop-'))
  const home = join(scratch, 'home')
  mkdirSync(home)
  const bootstrap = join(scratch, 'manager-background-real.mjs')
  await build({
    entryPoints: [join(repo, 'apps/desktop/src/probe-manager-background-real.mts')],
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
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: join(home, '.codex'),
      TMPDIR: scratch,
      LITCH_PROFILE: join(scratch, 'profile'),
      LITCH_ENTRY: fixture.socket,
      LITCH_LANG: 'zh-CN',
      LITCH_BG_REAL: JSON.stringify({
        cwd: fixture.engines.cwd,
        directory,
        show: Boolean(values.show),
        main: pathToFileURL(join(repo, 'apps/desktop/dist/main.mjs')).href,
      }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 900_000)
  const code = await new Promise((resolve, reject) => {
    child.once('exit', resolve)
    child.once('error', reject)
  }).finally(() => clearTimeout(timer))
  writeFileSync(join(directory, 'desktop.log'), output)
  const summary = output.split('\n').find((line) => line.startsWith('LITCH_BG_RESULT '))
  assert.ok(summary, `桌面外壳未返回结果（退出码 ${code}）：${output.slice(-5000)}`)
  const { rows } = JSON.parse(summary.slice('LITCH_BG_RESULT '.length))
  for (const [step, row] of Object.entries(rows)) {
    const misses = row.status.startsWith('失败')
      ? [row.status]
      : (expectations[step]?.(row.evidence) ?? []).filter((entry) => entry !== true)
    console.log(
      `${step} ｜ ${misses.length ? '未达到' : '达到'} ｜ ${JSON.stringify(row.evidence)}`,
    )
    for (const miss of misses) console.log(`  - ${miss}`)
    failed.push(...misses.map((miss) => `${step}：${miss}`))
  }
  writeFileSync(join(directory, 'result.json'), JSON.stringify({ rows, failed }, null, 2))
} catch (error) {
  failed = [...failed, String(error?.stack ?? error)]
  console.error(error)
} finally {
  for (const close of cleanup.reverse()) {
    try {
      await close()
    } catch (error) {
      failed.push(String(error))
      console.error(error)
    }
  }
}
console.log(`截图与结果：${directory}`)
console.log(`经理后台状态验收${failed.length ? '未通过' : '通过'}`)
process.exit(failed.length ? 1 : 0)
