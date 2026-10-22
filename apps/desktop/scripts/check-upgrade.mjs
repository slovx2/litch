// 远程设备服务一键升级在外壳这一头的自检：起一台假的远程机器（scripts/client-ssh-fixture.mjs 的 upgrade 别名），
// 拿 ssh/upgrade.mts 的三件事（看一眼、装、请服务停下）对着它跑，看脚本报回来的字读成了什么。不起界面，不联网。
// 那台机器上的适配器是替身：安装脚本把“新版”装进 ~/.local/bin 之后就交给新版；新版的发布包是这里现造的
// （一个照发布包布局的压缩包，里面的命令行和 Node 都是几行 sh），和真的 install.sh、校验和清单一起放在
// 一个本地目录里，经 LITCH_REMOTE_RELEASES=file://… 交给安装脚本，照真的发布页的路径取。
// 走的几种结果：装好马上停、装好不闲、只因为客户端连着不闲、下载失败、太旧不认识停止请求；另有一种替身 brew（装完还是旧的）。
//   npm run check:upgrade
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const tool = fileURLToPath(new URL('../dist/ssh-check.mjs', import.meta.url))
/** 假装应用的版本：要装的就是这一版 */
const VERSION = '9.9.9'
const NAME = 'codex-harness-adapter'

/** 起假的远程机器，等它就绪 */
function startFixture() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/client-ssh-fixture.mjs'], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const onData = (chunk) => {
      output += chunk
      const line = output.split('\n').find((entry) => entry.startsWith('LITCH_SSH_FIXTURE '))
      if (!line) return
      resolve({
        ...JSON.parse(line.slice('LITCH_SSH_FIXTURE '.length)),
        stop: () =>
          new Promise((done) => {
            child.once('exit', done)
            child.kill('SIGTERM')
          }),
      })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) =>
      reject(new Error(`假的远程机器没起来（退出码 ${code}）：\n${output}`)),
    )
  })
}

/** 这台电脑的系统和架构，照 install.sh 的认法：发布包按它取 */
function targetOf() {
  const system = { Darwin: 'darwin', Linux: 'linux' }[
    spawnSync('uname', ['-s']).stdout.toString().trim()
  ]
  const machine = spawnSync('uname', ['-m']).stdout.toString().trim()
  return `${system}-${{ x86_64: 'x64', amd64: 'x64', aarch64: 'arm64', arm64: 'arm64' }[machine]}`
}

/**
 * 造一个本地的“发布页”：download/v<版本>/ 下放 install.sh、发布包和校验和清单。
 * 发布包里的命令行是几行 sh：version 报这一版；device-stop 按主目录下 stop-mode 文件里写的退出码答，
 * 并把收到的参数记进 stop.log
 */
function makeReleases(work) {
  const target = targetOf()
  const top = `${NAME}-${VERSION}-${target}`
  const tree = join(work, 'tree', top)
  mkdirSync(join(tree, 'bin'), { recursive: true })
  mkdirSync(join(tree, 'libexec', 'node', 'bin'), { recursive: true })
  const write = (path, lines) => {
    writeFileSync(path, [...lines, ''].join('\n'))
    chmodSync(path, 0o755)
  }
  write(join(tree, 'libexec', 'node', 'bin', 'node'), ['#!/bin/sh', 'echo v24.0.0'])
  write(join(tree, 'bin', NAME), [
    '#!/bin/sh',
    'case "$1" in',
    `  version) echo "${NAME} ${VERSION}" ;;`,
    '  device-proxy) exit 1 ;;',
    '  device-stop)',
    '    echo "$*" >>"$HOME/stop.log"',
    '    mode=$(cat "$HOME/stop-mode" 2>/dev/null || echo 0)',
    '    case $mode in',
    `      0) echo '{"result":"stopped","pid":4242}'; echo '已停止常驻服务（进程 4242）。' >&2; exit 0 ;;`,
    `      4) echo '{"result":"busy","pid":4242,"busy":[{"reason":"activeTurns","harnesses":["pi"]},{"reason":"deviceProcesses","count":2},{"reason":"clients","count":1}]}'; echo '没有停：服务不闲' >&2; exit 4 ;;`,
    // c：只因为连着的客户端不闲，带 --if-idle 时不停，不带就停
    `      c) if [ "$2" = --if-idle ]; then echo '{"result":"busy","pid":4242,"busy":[{"reason":"clients","count":2}]}'; exit 4; fi`,
    `         echo '{"result":"stopped","pid":4242}'; exit 0 ;;`,
    `      5) echo '{"result":"unsupported"}'; echo '这个状态目录上有服务在运行，但这条命令停不了它：它不认识停止的请求' >&2; exit 5 ;;`,
    '    esac ;;',
    '  *) echo "未知命令: $1" >&2; exit 2 ;;',
    'esac',
  ])
  const releases = join(work, 'releases')
  const at = join(releases, 'download', `v${VERSION}`)
  mkdirSync(at, { recursive: true })
  const archive = `${top}.tar.gz`
  const packed = spawnSync('tar', ['-czf', join(at, archive), '-C', join(work, 'tree'), top], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  assert.equal(packed.status, 0, packed.stderr?.toString())
  const sum = spawnSync('shasum', ['-a', '256', join(at, archive)])
    .stdout.toString()
    .split(' ')[0]
  writeFileSync(join(at, `${NAME}-SHA256SUMS.txt`), `${sum}  ${archive}\n`)
  writeFileSync(join(at, 'install.sh'), readFileSync(join(repo, 'scripts', 'install.sh')))
  return releases
}

const work = mkdtempSync(join(tmpdir(), 'litch-upgrade-'))
const fixture = await startFixture()
const releases = makeReleases(work)
const home = fixture.upgradeHome
const env = {
  ...process.env,
  LITCH_SSH_CONFIG: fixture.config,
  LITCH_REMOTE_CODEX: fixture.codex,
  LITCH_REMOTE_ADAPTER: fixture.adapter,
  LITCH_REMOTE_RELEASES: `file://${releases}`,
}
const target = JSON.stringify({ kind: 'alias', alias: fixture.aliases.upgrade })

/** 跑一次小工具，返回它打的那一行 */
function run(...args) {
  const done = spawnSync(process.execPath, [tool, target, ...args], {
    env,
    encoding: 'utf8',
    timeout: 180_000,
  })
  const line = done.stdout.split('\n').filter(Boolean).at(-1)
  assert.ok(line, `小工具没有输出：\n${done.stderr}`)
  return JSON.parse(line)
}

const passed = []
const check = (name, body) => {
  body()
  passed.push(name)
  console.log(`  ✓ ${name}`)
}

try {
  check('看一眼：报出装着的旧版本和命令的位置', () => {
    const { facts } = run('--inspect')
    assert.equal(facts.version, '0.0.1')
    assert.equal(facts.path, join(home, 'bin', fixture.adapter))
  })

  check('下载失败：这一版的发布页上没有安装脚本，停在下载那一步，带着 curl 的原话', () => {
    const { install } = run('--install', 'script', '9.9.8')
    assert.equal(install.ok, false)
    assert.equal(install.at, 'download')
    assert.ok(install.code > 0)
    assert.match(install.said ?? '', /curl/)
    assert.equal(existsSync(join(home, '.local', 'bin', NAME)), false, '什么都没装')
  })

  check('装：安装脚本从本地发布页装上这一版，装完问到的就是它', () => {
    const { install } = run('--install', 'script', VERSION)
    assert.equal(install.ok, true, JSON.stringify(install))
    assert.equal(install.installed, VERSION)
    assert.match(install.said ?? '', /已安装|已从|Installed|Switched/)
    assert.ok(existsSync(join(home, '.local', 'share', NAME, VERSION, 'bin', NAME)))
    const { facts } = run('--inspect')
    assert.equal(facts.version, VERSION, '命令名指到了新版')
  })

  check('装好马上停：闲着就停了，带的是 --if-idle', () => {
    writeFileSync(join(home, 'stop-mode'), '0')
    const { stop } = run('--stop')
    assert.deepEqual(stop, { result: 'stopped' })
    assert.equal(
      readFileSync(join(home, 'stop.log'), 'utf8').trim().split('\n').at(-1),
      'device-stop --if-idle',
    )
  })

  check('装好不闲：没停，逐条原因读成 busy', () => {
    writeFileSync(join(home, 'stop-mode'), '4')
    const { stop } = run('--stop')
    assert.equal(stop.result, 'busy')
    assert.deepEqual(
      stop.busy,
      [
        { reason: 'activeTurns', harnesses: ['pi'], count: 0 },
        { reason: 'deviceProcesses', harnesses: [], count: 2 },
      ],
      '连着的客户端不列出来',
    )
  })

  check('只因为连着的客户端不闲：紧接着不带 --if-idle 停掉（客户端会自己重连）', () => {
    writeFileSync(join(home, 'stop-mode'), 'c')
    const { stop } = run('--stop')
    assert.deepEqual(stop, { result: 'stopped' })
    assert.deepEqual(readFileSync(join(home, 'stop.log'), 'utf8').trim().split('\n').slice(-2), [
      'device-stop --if-idle',
      'device-stop',
    ])
  })

  check('立即换上：不带 --if-idle', () => {
    writeFileSync(join(home, 'stop-mode'), '0')
    run('--stop', '--force')
    assert.equal(
      readFileSync(join(home, 'stop.log'), 'utf8').trim().split('\n').at(-1),
      'device-stop',
    )
  })

  check('太旧不认识停止请求：unsupported，带着它的原话', () => {
    writeFileSync(join(home, 'stop-mode'), '5')
    const { stop } = run('--stop')
    assert.equal(stop.result, 'unsupported')
    assert.match(stop.said ?? '', /不认识停止的请求/)
  })

  check('Homebrew（替身）：brew upgrade 照常退出，报回装着的版本，由核心去比新旧', () => {
    rmSync(join(home, '.local'), { recursive: true, force: true })
    const { install } = run('--install', 'brew', VERSION)
    assert.deepEqual([install.ok, install.installed], [true, '0.0.1'])
    assert.equal(
      readFileSync(join(home, 'brew.log'), 'utf8').trim(),
      'brew upgrade codex-harness-adapter',
    )
  })

  console.log(`一键升级的远端脚本：${passed.length} 项全部通过`)
} finally {
  await fixture.stop()
  rmSync(work, { recursive: true, force: true })
}
