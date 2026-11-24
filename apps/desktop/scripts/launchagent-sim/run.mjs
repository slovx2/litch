// 本机由 Litch 系统自启（macOS LaunchAgent）管着的设备服务，应用更新后换上自带新版的真机模拟。只在 macOS 上跑，不进 CI。
// 在临时目录里摆一份假的“应用自带适配器”（真的 Go 程序，设备进程换成 device-fixture.mjs），用隔离的状态目录登记自启。
// 自启的标签由状态目录算出（com.litch.device.<哈希>），是这次专用的；登记文件按系统账号写在 ~/Library/LaunchAgents 下，
// 用完即卸载、核对已删。不碰用户真实的 ~/.codex-harness-adapter 和别的 LaunchAgent。
// 像应用原地更新那样，用改名把内置命令行换成新版（在跑的旧进程不受影响），再用桌面端真的本机连接代码
// （dist/adapter-check.mjs，即 local-adapter.mts）连上：
//   1. 有回合在跑：不动，结果是“等着换”（autostart）；“现在重启”不等空闲，由 launchd 起新版，停之前问了续跑准备
//   2. 再换一版、空闲：连上时自动重新登记换上，launchd 管着的进程换成新版
//   node apps/desktop/scripts/launchagent-sim/run.mjs   （先 npm run build --prefix apps/desktop）
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

assert.equal(process.platform, 'darwin', '只在 macOS 上跑')
const repo = fileURLToPath(new URL('../../../..', import.meta.url))
const here = fileURLToPath(new URL('.', import.meta.url))
const tool = fileURLToPath(new URL('../../dist/adapter-check.mjs', import.meta.url))
assert.ok(existsSync(tool), '先 npm run build --prefix apps/desktop')
const VERSIONS = ['0.1.0', '0.2.0', '0.3.0']
const uid = spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim()

// 套接字路径有长度上限：放在 /tmp 下的短目录里
const work = mkdtempSync('/tmp/lla-')
const root = join(work, 'app', 'adapter')
const home = join(work, 'state')
const userHome = join(work, 'home')
const bin = join(root, 'bin', 'codex-harness-adapter')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...options })
  if (result.status !== 0 && !options.allowFail) {
    throw new Error(
      `${command} ${args.join(' ')} 退出码 ${result.status}\n${result.stdout}\n${result.stderr}`,
    )
  }
  return result
}

const env = { ...process.env, HOME: userHome, SHELL: '/nonexistent/csh', CHA_LANG: 'zh-CN' }
const adapter = (args, input) =>
  run(bin, [...args, '--home', home], { env, ...(input ? { input } : {}) })
const serviceFacts = () =>
  JSON.parse(readFileSync(join(home, 'device', 'service.json'), 'utf8')).service
const status = () => JSON.parse(adapter(['device-autostart', 'get']).stdout)
const activity = (value) =>
  writeFileSync(join(home, 'device', 'sim-activity.json'), JSON.stringify(value))
const resumes = () => {
  const file = join(home, 'device', 'sim-resume.log')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0
}
/** launchd 眼里这个标签现在的状态和进程号 */
function launchd(label) {
  const raw = run('launchctl', ['print', `gui/${uid}/${label}`], { allowFail: true }).stdout
  return {
    state: raw.match(/^\tstate = (\S+)/m)?.[1] ?? null,
    pid: Number(raw.match(/^\tpid = (\d+)/m)?.[1] ?? 0) || null,
    program: raw.match(/^\tprogram = (.+)$/m)?.[1] ?? null,
  }
}
/** 像应用原地更新：新版先放到旁边，再一步改名盖过去；在跑的旧进程还拿着原来那份 */
function update(version) {
  const next = `${bin}.next`
  run('cp', [join(work, 'build', version), next])
  renameSync(next, bin)
}
/** 用桌面端真的本机连接代码连一次，取结果那一行（以及 restarted） */
function connect(...flags) {
  const out = run(process.execPath, [tool, ...flags], {
    env: { ...env, LITCH_ADAPTER_ROOT: root, LITCH_ADAPTER_HOME: home, LITCH_LANG: 'zh-CN' },
    allowFail: true,
    timeout: 600_000,
  })
  const lines = out.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const result = lines.find((line) => line.result)
  assert.equal(result?.result, 'ok', `${out.stdout}\n${out.stderr}`)
  return { result, restarted: lines.find((line) => line.restarted)?.restarted }
}

let label = null
try {
  mkdirSync(join(work, 'build'))
  for (const version of VERSIONS) {
    run(
      'go',
      [
        'build',
        '-ldflags',
        `-X main.buildVersion=${version}`,
        '-o',
        join(work, 'build', version),
        './cmd/codex-harness-adapter',
      ],
      {
        cwd: repo,
      },
    )
  }
  const main = join(root, 'packages', 'device', 'dist', 'packages', 'device', 'src', 'main.mjs')
  mkdirSync(join(root, 'bin'), { recursive: true })
  mkdirSync(join(root, 'node', 'bin'), { recursive: true })
  mkdirSync(join(main, '..'), { recursive: true })
  mkdirSync(join(home, 'device'), { recursive: true, mode: 0o700 })
  mkdirSync(userHome, { mode: 0o700 })
  symlinkSync(process.execPath, join(root, 'node', 'bin', 'node'))
  writeFileSync(main, `import ${JSON.stringify(join(here, 'device-fixture.mjs'))}\n`)
  update('0.1.0')

  // 0.1.0 登记自启
  const enabled = adapter(
    ['device-autostart', 'enable', '--wait'],
    '{"operationId":"init","expectedRevision":0}',
  )
  assert.equal(
    JSON.parse(enabled.stdout.trim().split('\n').at(-1)).state,
    'completed',
    enabled.stdout,
  )
  const before = status()
  label = before.serviceId
  assert.equal(before.instance.mode, 'managed')
  const first = serviceFacts()
  assert.equal(first.version, '0.1.0')
  assert.equal(launchd(label).pid, first.pid)
  assert.match(label, /^com\.litch\.device\.[0-9a-f]{24}$/)
  console.log(`✓ 0.1.0 由 LaunchAgent ${label} 管着（进程 ${first.pid}）`)

  // 应用更新到 0.2.0；有回合在跑：连上时不动，等着换
  update('0.2.0')
  activity({ turns: ['pi'] })
  const waiting = connect().result
  assert.deepEqual(
    [waiting.upgrade.action, waiting.upgrade.reason, waiting.view.autostart],
    ['kept', 'busy', true],
    JSON.stringify(waiting.upgrade),
  )
  assert.equal(serviceFacts().pid, first.pid, '忙时不该停')
  assert.equal(launchd(label).pid, first.pid)
  assert.equal(status().lastOperation.operationId, 'init', '作罢后操作记录恢复成之前的样子')
  console.log('✓ 应用更新到 0.2.0 后有回合在跑：没有动，显示等待重启生效')

  // 现在重启：不等空闲，由 launchd 起 0.2.0；停之前问了续跑准备
  const prepared = resumes()
  const { restarted } = connect('--restart-now')
  assert.deepEqual(restarted.stop, { result: 'stopped' }, JSON.stringify(restarted))
  const second = serviceFacts()
  assert.equal(second.version, '0.2.0')
  assert.equal(second.detached, false)
  assert.notEqual(second.pid, first.pid)
  assert.equal(launchd(label).pid, second.pid, 'launchd 管着的就是新进程')
  assert.equal(launchd(label).state, 'running')
  assert.equal(status().instance.mode, 'managed')
  assert.equal(resumes(), prepared + 1, '停之前问了 restart.prepare')
  assert.equal(restarted.after.version, '0.2.0')
  console.log(`✓ “现在重启”不等空闲换上 0.2.0（进程 ${second.pid}），由 launchd 管着`)

  // 应用再更新到 0.3.0，空闲：连上时自动换上
  update('0.3.0')
  activity({})
  const replaced = connect().result
  assert.deepEqual(
    [replaced.upgrade.action, replaced.view.previous, replaced.last.service.version],
    ['replaced', '0.2.0', '0.3.0'],
    JSON.stringify(replaced.upgrade),
  )
  const third = serviceFacts()
  assert.equal(launchd(label).pid, third.pid)
  assert.equal(status().state, 'enabled')
  console.log(`✓ 应用更新到 0.3.0 且空闲：连上时自动换上（进程 ${third.pid}），自启状态 enabled`)
  console.log('LaunchAgent 托管设备的换版本模拟通过')
} finally {
  if (label) {
    const revision = status().revision
    adapter(
      ['device-autostart', 'disable', '--wait'],
      JSON.stringify({ operationId: 'cleanup', expectedRevision: revision, confirmStop: true }),
    )
    const plist = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
    assert.equal(existsSync(plist), false, `登记文件还在：${plist}`)
    assert.equal(launchd(label).state, null, 'launchd 里还有这个标签')
    console.log(`已卸载临时 LaunchAgent ${label}`)
  }
  rmSync(work, { recursive: true, force: true })
}
