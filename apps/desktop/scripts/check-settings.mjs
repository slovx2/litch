// 设置页和外观的验收：不显示窗口，对着模拟核心起两次桌面外壳，两次用同一份临时的用户数据目录。
//   头一遍  设置页的开合与五个分组、入口（侧栏、快捷键、应用菜单）；皮肤、明暗、密度、缩放、语言点了当场生效；
//           皮肤预览画的是那种皮肤的变量；快捷键一览和真的应用菜单对账；关于与许可；回合正在跑的时候换外观；
//           六套组合（三种皮肤乘深浅）下对话区、侧栏、审批卡片、已归档对话、设置页各组的溢出与对比度；
//           缩放到最小和最大时终端的行列数、对话区、文件树；重新加载之后都还在。最后留下一份不是默认的外观
//   第二遍  冷启动：窗口一建出来的底色、缩放、最小的大小就是上一遍留下的那一份，页面头一眼也是
// 量法在 src/probe-settings*.mts。只跑一遍：--first 或 --cold（单跑 --cold 没有上一遍留下的东西，必然不过，只用来看输出）。
//   --verbose  把外壳的输出原样打出来；--json  把量到的东西整份打出来
//   LITCH_SETTINGS_SHOTS=<目录>  顺手存几张截图到这个目录里（给人看的，平时不存）
//
// “关于”里的许可文本：装好的应用是从资源目录读的。这里用打包时的那个函数（scripts/licenses.mjs）现收一份到临时目录，
// 经 LITCH_LICENSES_DIR 交给外壳，所以量到的是“真的许可目录到界面”这一整条路，只差打包器把目录放进应用那一步。
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectLicenses } from './licenses.mjs'

const require = createRequire(import.meta.url)
// electron 这个包的默认导出就是它的可执行文件的路径
const electron = require('electron')
const appDir = fileURLToPath(new URL('..', import.meta.url))
const repo = fileURLToPath(new URL('../../..', import.meta.url))
const only = ['first', 'cold'].filter((name) => process.argv.includes(`--${name}`))
const wanted = only.length > 0 ? only : ['first', 'cold']
const verbose = process.argv.includes('--verbose')

/** 每一遍外壳自己的时限之外，再给这么久：到点它连报都没报，就强行结束 */
const KILL_AFTER_MS = { first: 600_000, cold: 150_000 }
const MODES = { first: 'settings', cold: 'settings-cold' }
const NAMES = { first: '设置页与外观', cold: '冷启动' }

// 中途被叫停（Ctrl+C、被上层结束）：把正在跑的外壳结束掉，照常收尾，剩下的不跑了
let stopped = false
let running = null
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopped = true
    running?.kill('SIGKILL')
  })
}

const scratch = mkdtempSync(join(tmpdir(), 'litch-settings-'))
const profile = join(scratch, 'profile')
const licenses = join(scratch, 'licenses')
mkdirSync(profile)
// 内置浏览器已保存的密码：三条，加密那一栏是假的（设置页只列、搜、删，不解密）。
// 和 src/probe-settings-passwords.mts 的 SEEDED_PASSWORDS、SEEDED_SEALED 对得上
mkdirSync(join(profile, 'browser'))
writeFileSync(
  join(profile, 'browser', 'passwords.json'),
  JSON.stringify({
    version: 1,
    entries: [
      ['https://bank.example', 'ann@example.com'],
      ['https://bank.example', 'bob@example.com'],
      ['https://mail.example', 'carol'],
    ].map(([origin, username], index) => ({
      id: `seed-${index}`,
      origin,
      username,
      password: 'U0VBTEVELU5PVC1BLVJFQUwtUEFTU1dPUkQ=',
      source: 'chrome:Default',
      store: 'profile',
      createdAt: 1_760_000_000_000,
      importedAt: 1_760_000_000_000,
    })),
  }),
)
// 和打包时一样：逐包的许可文本，加上本项目自己的两份
const bundled = collectLicenses(licenses)
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  cpSync(join(repo, file), join(licenses, file))
}

/** 起一次外壳跑一遍。返回它打出来的结果，和外面另外查到的不合格项 */
async function runOne(kind) {
  const outside = []
  let output = ''
  const child = spawn(electron, [appDir], {
    env: {
      ...process.env,
      LITCH_SMOKE: MODES[kind],
      LITCH_PROFILE: profile,
      LITCH_LICENSES_DIR: licenses,
      LITCH_LICENSES_COUNT: String(bundled.length),
      // 外观要从记下来的那一份读：这几个临时指定不能带进来
      LITCH_SKIN: '',
      LITCH_THEME: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  running = child
  if (stopped) child.kill('SIGKILL')
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      output += chunk
      if (verbose) process.stderr.write(chunk)
    })
  }
  const startedAt = Date.now()
  let killed = false
  const timer = setTimeout(() => {
    killed = true
    child.kill('SIGKILL')
  }, KILL_AFTER_MS[kind])
  const code = await new Promise((done) => child.on('exit', done))
  clearTimeout(timer)
  running = null
  if (killed) {
    outside.push(
      `外壳 ${Math.round((Date.now() - startedAt) / 1000)} 秒没有结束，被强行结束了；它一共输出了 ${output.length} 个字`,
    )
  }
  const line = output.split('\n').find((item) => item.startsWith('LITCH_SMOKE '))
  let result = null
  try {
    result = line ? JSON.parse(line.slice('LITCH_SMOKE '.length)) : null
  } catch {
    // 结果行不完整
  }
  const failed = [...(result?.failed ?? (result ? [] : ['没有拿到结果'])), ...outside]
  return {
    kind,
    code,
    result,
    failed,
    output,
    seconds: Math.round((Date.now() - startedAt) / 1000),
  }
}

/** 头一遍量到的东西里，值得一眼看到的几个数 */
function numbers(probe) {
  if (!probe?.screens) return ''
  const rows = probe.screens.rows ?? []
  const lowest = rows.reduce((least, row) => (row.audit.lowest < least.audit.lowest ? row : least))
  const below = rows.reduce((sum, row) => sum + row.audit.below45, 0)
  const texts = rows.reduce((sum, row) => sum + row.audit.texts, 0)
  return [
    `快捷键 ${probe.keys?.length ?? 0} 条`,
    `许可 ${probe.about?.packages ?? 0} 份`,
    `换外观时贴底差 ${probe.turn?.followSpread}、没贴底挪 ${probe.turn?.freeSpread}`,
    `量了 ${rows.length} 屏 ${texts} 处字，对比度最低 ${lowest.audit.lowest}（${lowest.where} ${lowest.audit.lowestAt}），不到 4.5 的 ${below} 处`,
    ...(probe.zooms ?? []).map(
      (zoom) =>
        `缩放 ${Math.round(zoom.zoom * 100)}% 页面 ${zoom.inner.join('×')} 终端 ${zoom.term.told}`,
    ),
  ].join('｜')
}

let allOk = true
for (const kind of wanted) {
  if (stopped) break
  const run = await runOne(kind)
  if (stopped) break
  const ok = run.failed.length === 0 && run.code === 0
  allOk &&= ok
  const seen = numbers(run.result?.probe)
  if (ok) {
    console.log(`设置验收通过：${NAMES[kind]}（${run.seconds} 秒）${seen ? `｜${seen}` : ''}`)
  } else {
    console.error(`设置验收没过：${NAMES[kind]}（退出码 ${run.code}，${run.seconds} 秒）`)
    for (const entry of run.failed) console.error(`  - ${entry}`)
    if (seen) console.error(`  量到的：${seen}`)
    console.error(
      run.output
        .split('\n')
        .filter((entry) => !entry.startsWith('LITCH_SMOKE '))
        .slice(-40)
        .join('\n'),
    )
  }
  if (process.argv.includes('--json') && run.result) {
    console.log(JSON.stringify(run.result.probe, null, 2))
  }
  // 头一遍没过，第二遍没有它留下的东西可看
  if (!ok) break
}
// 临时的用户数据目录和现收的许可文本都在这里面
rmSync(scratch, { recursive: true, force: true })
if (existsSync(scratch)) {
  console.error(`临时目录没删掉：${scratch}`)
  allOk = false
}
if (stopped) {
  console.error('设置的验收被中途叫停了，已经收尾')
  process.exit(130)
}
process.exit(allOk ? 0 : 1)
