// 系统自启（systemd 用户服务）管着的远程设备点“升级”之后的换版本模拟。
// 在一个跑着真 systemd 的 Debian 容器里装三版适配器（真的 Go 程序，设备进程换成 device-fixture.mjs），
// 由 0.1.0 登记自启，再照桌面端一键升级的做法经 `exec sh` 喂 apps/desktop/src/ssh/script.mts 的探测和换版本脚本：
//   忙（有回合）时带 ifIdle 不动、登记和运行实例照旧；只有客户端连着时照换；“现在重启”不等空闲且先为续跑做准备；
//   换上之后 systemd 单元指向新版、运行实例是自启管着的新版；不是自启登记的实例时什么都不做。
// 不碰本机和真实设备：容器用完即删。要 Docker（容器要 --privileged 跑 systemd）和能拉 Debian 软件包的网络。
//   node scripts/systemd-upgrade-sim/run.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { probeScript, swapScript } from '../../apps/desktop/src/ssh/script.mts'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const here = fileURLToPath(new URL('.', import.meta.url))
const IMAGE = 'litch-systemd-upgrade-sim:bookworm'
const NAME = `litch-systemd-upgrade-sim-${process.pid}`
const HOME = '/home/sim'
const BASE = `${HOME}/.local/share/codex-harness-adapter`
const STATE = `${HOME}/.codex-harness-adapter/device`
const VERSIONS = ['0.1.0', '0.2.0', '0.3.0']

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...options })
  if (result.status !== 0 && !options.allowFail) {
    throw new Error(
      `${command} ${args.join(' ')} 退出码 ${result.status}\n${result.stdout}\n${result.stderr}`,
    )
  }
  return result
}

const root = (script, options) => run('docker', ['exec', '-i', NAME, 'sh', '-c', script], options)
/** 以 sim 的身份跑，环境照 ssh 登录进来的样子（没有 XDG_RUNTIME_DIR，适配器自己补） */
const sim = (script, options) =>
  run(
    'docker',
    [
      'exec',
      '-i',
      '-u',
      'sim',
      '-e',
      `HOME=${HOME}`,
      '-e',
      `PATH=${HOME}/.local/bin:/usr/bin:/bin`,
      '-w',
      HOME,
      NAME,
      'sh',
      '-c',
      script,
    ],
    options,
  )
const systemctl = (args) =>
  sim(`XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user --no-pager ${args}`).stdout.trim()

/** 照桌面端的送法：远程命令是 exec sh，脚本从标准输入喂，只认标记之后的 键=值 */
function remote(script) {
  const result = run(
    'docker',
    ['exec', '-i', '-u', 'sim', '-e', `HOME=${HOME}`, '-w', HOME, NAME, 'sh'],
    { input: script.text, allowFail: true },
  )
  const lines = result.stdout.split('\n')
  const at = lines.indexOf(script.marker)
  assert.ok(at >= 0, `没见到标记：\n${result.stdout}\n${result.stderr}`)
  const fields = {}
  for (const line of lines.slice(at + 1)) {
    const cut = line.indexOf('=')
    if (cut <= 0) continue
    const key = line.slice(0, cut)
    fields[key] = key in fields ? `${fields[key]}\n${line.slice(cut + 1)}` : line.slice(cut + 1)
  }
  return fields
}

const serviceFacts = () => JSON.parse(sim(`cat ${STATE}/service.json`).stdout).service
const autostart = () => JSON.parse(sim('codex-harness-adapter device-autostart get').stdout)
const activity = (value) =>
  sim(`printf '%s' '${JSON.stringify(value)}' > ${STATE}/sim-activity.json`)
const resumes = () =>
  sim(`cat ${STATE}/sim-resume.log 2>/dev/null || true`).stdout.split('\n').filter(Boolean).length
const install = (version) => sim(`ln -sfn ${BASE}/${version} ${BASE}/current`)

function build(work) {
  const arch = run('docker', ['info', '--format', '{{.Architecture}}']).stdout.trim()
  const goarch = { aarch64: 'arm64', arm64: 'arm64', x86_64: 'amd64' }[arch]
  assert.ok(goarch, `认不出 Docker 的架构：${arch}`)
  for (const version of VERSIONS) {
    run(
      'go',
      [
        'build',
        '-ldflags',
        `-X main.buildVersion=${version}`,
        '-o',
        join(work, version),
        './cmd/codex-harness-adapter',
      ],
      {
        cwd: repo,
        env: { ...process.env, GOOS: 'linux', GOARCH: goarch, CGO_ENABLED: '0' },
      },
    )
  }
  const dockerfile = [
    'FROM debian:bookworm-slim',
    'RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus dbus-user-session nodejs procps && rm -rf /var/lib/apt/lists/*',
    'RUN useradd -m -s /bin/sh sim',
    'CMD ["/lib/systemd/systemd"]',
    '',
  ].join('\n')
  run('docker', ['build', '-t', IMAGE, '-'], {
    input: dockerfile,
    stdio: ['pipe', 'inherit', 'inherit'],
  })
}

function layout(work) {
  for (const version of VERSIONS) {
    const dir = `${BASE}/${version}`
    sim(
      `mkdir -p ${dir}/bin ${dir}/libexec/bin ${dir}/libexec/node/bin ${dir}/libexec/packages/device/dist/packages/device/src`,
    )
    run('docker', ['cp', join(work, version), `${NAME}:${dir}/libexec/bin/codex-harness-adapter`])
    run('docker', [
      'cp',
      join(repo, 'scripts/adapter-launcher.sh'),
      `${NAME}:${dir}/bin/codex-harness-adapter`,
    ])
    run('docker', [
      'cp',
      join(here, 'device-fixture.mjs'),
      `${NAME}:${dir}/libexec/packages/device/dist/packages/device/src/main.mjs`,
    ])
    root(
      `chown -R sim:sim ${dir} && chmod 755 ${dir}/bin/codex-harness-adapter ${dir}/libexec/bin/codex-harness-adapter`,
    )
    sim(
      `printf '{"version":"${version}"}' > ${dir}/libexec/package.json && ln -sf /usr/bin/node ${dir}/libexec/node/bin/node`,
    )
  }
  sim(
    `mkdir -p ${HOME}/.local/bin && ln -sfn ${BASE}/current/bin/codex-harness-adapter ${HOME}/.local/bin/codex-harness-adapter`,
  )
}

function waitFor(what, check, seconds = 30) {
  const end = Date.now() + seconds * 1000
  for (;;) {
    try {
      if (check()) return
    } catch {}
    if (Date.now() > end) throw new Error(`等不到：${what}`)
    spawnSync('sleep', ['0.5'])
  }
}

const work = mkdtempSync(join(tmpdir(), 'litch-systemd-sim-'))
try {
  build(work)
  run('docker', [
    'run',
    '-d',
    '--name',
    NAME,
    '--privileged',
    '--cgroupns=host',
    '-v',
    '/sys/fs/cgroup:/sys/fs/cgroup:rw',
    '--tmpfs',
    '/run',
    '--tmpfs',
    '/run/lock',
    IMAGE,
  ])
  waitFor('systemd 起来', () =>
    /running|degraded/.test(root('systemctl is-system-running || true').stdout),
  )
  root('loginctl enable-linger sim')
  waitFor('sim 的用户服务管理器', () =>
    root('test -S /run/user/$(id -u sim)/bus && echo ok').stdout.includes('ok'),
  )
  layout(work)

  // 0.1.0 登记自启
  install('0.1.0')
  sim(`mkdir -p ${STATE} && chmod 700 ${HOME}/.codex-harness-adapter ${STATE}`)
  const enabled = sim(
    `printf '{"operationId":"init","expectedRevision":0,"allowLinger":true}' | codex-harness-adapter device-autostart enable --wait`,
  )
  assert.equal(
    JSON.parse(enabled.stdout.trim().split('\n').at(-1)).state,
    'completed',
    enabled.stdout,
  )
  const first = serviceFacts()
  assert.equal(first.version, '0.1.0')
  const status = autostart()
  assert.equal(status.state, 'enabled')
  assert.equal(status.instance.mode, 'managed')
  const unit = `${status.serviceId}.service`
  console.log(`✓ 0.1.0 由 systemd 用户服务 ${unit} 管着（进程 ${first.pid}）`)

  // 装上 0.2.0：current 换了，在跑的还是 0.1.0。探测认得出是自启管着的
  install('0.2.0')
  const probe = remote(probeScript())
  assert.equal(probe.adapterVersion, 'codex-harness-adapter 0.2.0')
  assert.equal(probe.adapterRunning, 'yes')
  assert.equal(probe.adapterAutostart, 'managed')
  assert.equal(serviceFacts().version, '0.1.0')
  console.log('✓ 装上 0.2.0 后在跑的仍是 0.1.0；探测报 adapterAutostart=managed')

  // 有回合在跑：带 ifIdle 不动
  activity({ turns: ['pi'], connections: 1 })
  const busy = remote(swapScript({ ifIdle: true, lang: 'zh-CN' }))
  assert.equal(busy.code, '4', JSON.stringify(busy))
  assert.deepEqual(
    JSON.parse(busy.out).busy.map((entry) => entry.reason),
    ['activeTurns', 'clients'],
  )
  assert.equal(serviceFacts().pid, first.pid, '忙时不该停')
  assert.match(systemctl(`show -p ExecStart ${unit}`), /\/0\.1\.0\/libexec\//)
  const after = autostart()
  assert.equal(after.lastOperation.operationId, 'init', '作罢后操作记录恢复成之前的样子')
  assert.equal(after.state, 'enabled')
  console.log(`✓ 有回合在跑时没有动：${busy.said}`)

  // 只有客户端连着：照换，换上之后 systemd 单元指向 0.2.0
  activity({ connections: 2 })
  const swapped = remote(swapScript({ ifIdle: true, lang: 'zh-CN' }))
  assert.equal(swapped.code, '0', JSON.stringify(swapped))
  const second = serviceFacts()
  assert.equal(second.version, '0.2.0')
  assert.notEqual(second.pid, first.pid)
  assert.ok(second.options.some((option) => option.startsWith('--litch-autostart=')))
  assert.match(systemctl(`show -p ExecStart ${unit}`), /\/0\.2\.0\/libexec\//)
  assert.equal(systemctl(`is-active ${unit}`), 'active')
  assert.equal(autostart().instance.mode, 'managed')
  console.log(`✓ 空闲（只有客户端连着）时换上 0.2.0（进程 ${second.pid}），systemd 单元指向新版`)

  // 现在重启：装上 0.3.0，有回合在跑也不等；停之前先为续跑做准备
  install('0.3.0')
  activity({ turns: ['claude-code'] })
  const prepared = resumes()
  const forced = remote(swapScript({ ifIdle: false, lang: 'zh-CN' }))
  assert.equal(forced.code, '0', JSON.stringify(forced))
  assert.equal(serviceFacts().version, '0.3.0')
  assert.equal(resumes(), prepared + 1, '停之前问了 restart.prepare')
  assert.match(systemctl(`show -p ExecStart ${unit}`), /\/0\.3\.0\/libexec\//)
  console.log('✓ “现在重启”不等空闲换上 0.3.0，停之前为续跑做了准备')

  // 不是自启登记的实例：什么都不做
  sim(
    `printf '{"operationId":"off","expectedRevision":${autostart().revision},"confirmStop":true}' | codex-harness-adapter device-autostart disable --wait`,
  )
  sim('codex-harness-adapter device-start --ssh=off')
  const manual = serviceFacts()
  const skipped = remote(swapScript({ ifIdle: true, lang: 'zh-CN' }))
  assert.equal(skipped.swap, 'unmanaged')
  assert.equal(serviceFacts().pid, manual.pid)
  console.log('✓ 按需拉起的实例：报 unmanaged，不动它')
  console.log('systemd 托管设备的换版本模拟通过')
} finally {
  // LITCH_SIM_KEEP=1：失败时留着容器排查（用完自己 docker rm -f）
  if (process.env.LITCH_SIM_KEEP === '1') console.log(`容器留着：${NAME}`)
  else run('docker', ['rm', '-f', NAME], { allowFail: true })
  rmSync(work, { recursive: true, force: true })
}
