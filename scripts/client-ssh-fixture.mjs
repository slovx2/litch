// 给远程连接的开发和自检用的隔离环境：一台假的“远程机器”。
// 在回环地址上起一个用户态的 sshd（临时的主机密钥和客户端密钥，只认这一把钥匙），登录进去之后
// HOME 是临时目录，PATH 里的 codex 是替身（client-ssh-codex.mjs），替身背后接的是
// client-fixture.mjs 起的隔离入口。用户自己的 ssh 配置、密钥代理、known_hosts、codex 数据一样都不碰。
// 另有几种“装了适配器”的情形：那里的适配器是真的 Go 命令行，客户端经 ssh 执行它的 device-start
// 才把常驻服务拉起来（真的设备进程加一份隔离的 Pi，模型是回环上的假模型），见 client-ssh-fixture-service.mjs。
// 每种情形一个别名，登录时由别名带一个记号（LITCH_FX_MODE），启动脚本按它定主目录和 PATH。
//
// 用法：node scripts/client-ssh-fixture.mjs [--native <codex 的路径>] [--engines claude,dsh,opencode,codex]
//   --engines：装了适配器的那台（svc）除了 Pi 再起这几家，各用 CHA_CLAUDE_CLI 之类给的隔离副本，
//   模型一样是回环上的假模型（写法和隔离见 client-fixture-engines.mjs）。
//   --native：替身换成这台电脑上真的 codex，它的数据目录放在临时目录里（不登录、不碰平时用的那一份）。
//   用来对着原生 codex 核对一遍探测、启动、代理这三步；没有登录，所以只能握手和列会话，跑不了回合。
//   就绪后输出一行 LITCH_SSH_FIXTURE {"config": "...", "aliases": {...}, ...}，然后一直运行到被结束，
//   退出时停掉 sshd、替身起的常驻服务和被拉起来的设备服务，清掉临时目录。
//   客户端那边设 LITCH_SSH_CONFIG=<config>，就会用这份 ssh 配置去连下面这些别名；
//   LITCH_REMOTE_CODEX、LITCH_REMOTE_ADAPTER 设成就绪行里的 codex、adapter（两个替身的名字）。
//   grow 那个别名一开始只有 codex；就绪行里 growFlag 那个文件一建出来，它就“装上了适配器”，删掉又没了。
import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { refuseHarnessOnPath, wantedEngines } from './client-fixture-engines.mjs'
import { longestSocket, prepareService } from './client-ssh-fixture-service.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sshd = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((path) => existsSync(path))
if (!sshd) {
  console.error('这台机器上没有 sshd，起不了假的远程机器')
  process.exit(1)
}

/** 假的远程机器上那个替身的命令名 */
const CODEX = 'litch-fx-codex'
const nativeAt = process.argv.indexOf('--native')
/** 给了就用这台电脑上真的 codex 当“远程机器上的 codex” */
const native = nativeAt < 0 ? null : resolve(process.argv[nativeAt + 1] ?? '')
if (native && !existsSync(native)) {
  console.error(`没有这个文件：${native}`)
  process.exit(1)
}

/** --engines 要的那几家（隔离的命令行），没带是全 null */
const engines = wantedEngines()
// 服务的 PATH 里只有起夹具的这份 Node 的目录和系统目录：那里不能有用户装的 harness
refuseHarnessOnPath([dirname(process.execPath)])

/** 各种情形各一个别名。除了 ok，其余都是为了验某一种“没连上” */
const ALIASES = {
  /** 正常：codex 在启动脚本才加进 PATH 的目录里，服务没在跑 */
  ok: 'litch-fx',
  /** 什么都没装 */
  bare: 'litch-fx-bare',
  /** codex 的版本低于下限 */
  old: 'litch-fx-old',
  /** codex 在，但服务起不来 */
  nostart: 'litch-fx-nostart',
  /** 主机密钥不在 known_hosts 里 */
  untrusted: 'litch-fx-untrusted',
  /** 钥匙不对，认证过不去 */
  denied: 'litch-fx-denied',
  /** 端口上没人听 */
  down: 'litch-fx-down',
  // ---- 下面几种是“装了适配器”的 ----
  /** 装了适配器，没有 codex。服务没在跑，连的时候才拉起来 */
  svc: 'litch-fx-svc',
  /** 适配器和 codex 都有：该连的是设备服务。和 svc 是同一台“机器”（同一个主目录和状态目录） */
  both: 'litch-fx-both',
  /** 适配器的命令只在默认的安装位置（~/.local/bin）里，不在登录 shell 的 PATH 里 */
  svcHome: 'litch-fx-svc-home',
  /** 适配器够新，但状态目录上跑着一份不带聚合面的旧服务 */
  legacy: 'litch-fx-svc-legacy',
  /** 适配器在，它的设备服务起不来 */
  svcDown: 'litch-fx-svc-nostart',
  /** 适配器太旧：还没有设备服务，连版本都报不出来 */
  svcOld: 'litch-fx-svc-old',
  /** 一开始只有 codex；growFlag 那个文件建出来之后“装上了适配器”（和 svc 是同一台），删掉又只剩 codex */
  grow: 'litch-fx-grow',
}

// 套接字路径有长度上限，目录名都起得很短。系统给的临时目录太长就退到 /tmp
const base = [tmpdir(), '/tmp'].find(
  (directory) => longestSocket(join(directory, 'litch-ssh-XXXXXX')) <= 96,
)
if (!base) {
  console.error('找不到路径够短的临时目录，套接字建不出来')
  process.exit(1)
}
const root = mkdtempSync(join(base, 'litch-ssh-'))
const home = join(root, 'h')
mkdirSync(join(home, 'bin'), { recursive: true })
chmodSync(root, 0o700)

let entryChild = null
let sshdChild = null
/** “装了适配器”的那一半，见 client-ssh-fixture-service.mjs */
let service = null
let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  sshdChild?.kill('SIGTERM')
  // 经 ssh 被拉起来的设备服务是脱离出去的：请它们自己停，等退干净
  const left = service?.stop() ?? []
  if (left.length > 0) console.error(`还有设备服务没退：进程号 ${left.join('、')}`)
  // 替身起的常驻服务是脱离 ssh 的，要按它记下的进程号来停。
  // 真的 codex 是一个启动脚本再带一个子进程，两个都要停；只按记下的进程号找，不按名字找，
  // 免得碰到这台电脑上平时在跑的 codex
  for (const name of ['c.sock.pid', 'n.sock.pid']) {
    try {
      const pid = Number(readFileSync(join(root, name), 'utf8'))
      let children = []
      try {
        children = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
          .split('\n')
          .filter(Boolean)
          .map(Number)
      } catch {
        // 没有子进程
      }
      for (const target of [...children, pid]) process.kill(target, 'SIGTERM')
    } catch {
      // 没起过，或者已经退了
    }
  }
  entryChild?.kill('SIGTERM')
  rmSync(root, { recursive: true, force: true })
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanup()
    process.exit(0)
  })
}
process.on('exit', cleanup)

/** 起隔离入口（Pi 引擎加假模型），等它把会话造好 */
function startEntry() {
  return new Promise((done, fail) => {
    entryChild = spawn(process.execPath, [join(repo, 'scripts/client-fixture.mjs')], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const onData = (chunk) => {
      output += chunk
      const line = output.split('\n').find((entry) => entry.startsWith('LITCH_FIXTURE '))
      // 入口给的是 unix:// 开头的地址，替身要的是套接字文件的路径
      if (line) {
        done(JSON.parse(line.slice('LITCH_FIXTURE '.length)).entry.replace(/^unix:\/\//, ''))
      }
    }
    entryChild.stdout.on('data', onData)
    entryChild.stderr.on('data', onData)
    entryChild.on('exit', (code) =>
      fail(new Error(`隔离入口没起来（退出码 ${code}）：\n${output}`)),
    )
  })
}

/** 找一个现在没人用的回环端口 */
const freePort = () =>
  new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => done(port))
    })
  })

const canConnect = (port) =>
  new Promise((done) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      done(true)
    })
    socket.once('error', () => done(false))
  })

const keygen = (file, comment) =>
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', file])

try {
  const entry = await startEntry()
  service = await prepareService({ repo, root, engines })
  const [port, deadPort] = [await freePort(), await freePort()]
  /** 这个文件在，grow 那个别名就是“装上了适配器” */
  const growFlag = join(root, 'grow.installed')

  keygen(join(root, 'host_key'), 'litch-test-host')
  // 扫码绑定手机：设备服务按 sshd 的规矩读 ssh_host_*_key.pub 报主机钥匙，这里放一份夹具 sshd 用的那把
  // （LITCH_SSH_HOST_KEYS_DIR 指过来，见 client-ssh-fixture-service.mjs），不读这台电脑的 /etc/ssh
  mkdirSync(join(root, 'host-keys'))
  writeFileSync(
    join(root, 'host-keys', 'ssh_host_ed25519_key.pub'),
    readFileSync(join(root, 'host_key.pub')),
  )
  keygen(join(root, 'client_key'), 'litch-test-client')
  // 另一把没被授权的钥匙，用来验认证失败
  keygen(join(root, 'other_key'), 'litch-test-other')
  writeFileSync(join(root, 'authorized_keys'), readFileSync(join(root, 'client_key.pub')), {
    mode: 0o600,
  })
  const hostKey = readFileSync(join(root, 'host_key.pub'), 'utf8').split(' ').slice(0, 2).join(' ')
  writeFileSync(join(root, 'known_hosts'), `[127.0.0.1]:${port} ${hostKey}\n`)
  writeFileSync(join(root, 'known_hosts_empty'), '')

  // 假的远程机器上的 codex：一个包装脚本，把要用的路径交给替身。
  // 它不叫 codex，而是一个别处不会有的名字（客户端那边用 LITCH_REMOTE_CODEX 指过来）：
  // 这样“什么都没装”的情形在装了 codex 的电脑上也成立，自检也绝不会跑到这台电脑上真的 codex。
  const q = (text) => `'${text.replaceAll("'", `'\\''`)}'`
  const nativeScript = native && [
    '#!/bin/sh',
    // 常驻的那一份记下进程号，收尾时按它来停
    `case "$1 $2" in "app-server --listen") echo $$ >${q(join(root, 'c.sock.pid'))} ;; esac`,
    // 数据目录在临时目录里；node 的目录补进 PATH（npm 装的 codex 是个 node 脚本）
    `CODEX_HOME=${q(join(root, 'cx'))} PATH=${q(dirname(process.execPath))}":$PATH" exec ${q(native)} "$@"`,
    '',
  ]
  if (native) mkdirSync(join(root, 'cx'))
  writeFileSync(
    join(home, 'bin', CODEX),
    nativeScript?.join('\n') ??
      [
        '#!/bin/sh',
        // “版本太低”“服务起不来”这两种情形用另一个没人听的套接字，免得直接连上正常情形起的那一份
        // （真的旧版本根本没有代理子命令，本来就连不上）
        `case "$LITCH_FX_MODE" in old|nostart) sock=${q(join(root, 'n.sock'))} ;; *) sock=${q(join(root, 'c.sock'))} ;; esac`,
        `LITCH_FX_SOCK="$sock" LITCH_FX_ENTRY=${q(entry)} exec ${q(process.execPath)} ${q(join(repo, 'scripts/client-ssh-codex.mjs'))} "$@"`,
        '',
      ].join('\n'),
    { mode: 0o755 },
  )
  // 启动脚本：学真实机器的样子，工具目录只在这里才加进 PATH，并且往标准输出里写点无关的东西。
  // 客户端要是没经登录 shell 就找不到 codex，要是没把这些输出切掉就握不了手。
  const codexBin = q(join(home, 'bin'))
  const { homes, bins } = service
  const rc = [
    'echo "Welcome to the test machine."',
    // 每种情形是一台不同的“机器”：主目录各是各的（状态目录、默认的安装位置都跟着主目录走）。
    // 真的机器上不会有这一段，这里是拿一个 sshd 冒充好几台
    'case "$LITCH_FX_MODE" in',
    `  svc|both) HOME=${q(homes.svc)} ;;`,
    `  svchome) HOME=${q(homes.path)} ;;`,
    `  legacy) HOME=${q(homes.legacy)} ;;`,
    `  svcdown) HOME=${q(service.down)} ;;`,
    `  grow) if [ -e ${q(growFlag)} ]; then HOME=${q(homes.svc)}; fi ;;`,
    'esac',
    'export HOME',
    // sshd 把会话放在这台电脑真的家目录里开始；挪到临时的家目录去，起的服务就不会去看真的那一份
    'cd "$HOME"',
    // 工具目录只在这里才加进 PATH：什么都没装的不加；svchome 也不加，它的命令只在 ~/.local/bin 里
    'case "$LITCH_FX_MODE" in',
    '  bare|svchome) ;;',
    `  svc|legacy) PATH=${q(bins.ok)}":$PATH" ;;`,
    `  svcdown) PATH=${q(bins.down)}":$PATH" ;;`,
    `  svcold) PATH=${q(bins.old)}":$PATH" ;;`,
    `  both) PATH=${q(bins.ok)}:${codexBin}":$PATH" ;;`,
    `  grow) PATH=${codexBin}":$PATH"; if [ -e ${q(growFlag)} ]; then PATH=${q(bins.ok)}":$PATH"; fi ;;`,
    `  *) PATH=${codexBin}":$PATH" ;;`,
    'esac',
    'export PATH',
    '',
  ].join('\n')
  for (const name of ['.zshrc', '.bashrc', '.profile']) writeFileSync(join(home, name), rc)
  writeFileSync(join(home, '.bash_profile'), '. "$HOME/.bashrc"\n')

  writeFileSync(
    join(root, 'sshd_config'),
    [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${join(root, 'host_key')}`,
      `PidFile ${join(root, 'sshd.pid')}`,
      `AuthorizedKeysFile ${join(root, 'authorized_keys')}`,
      'PubkeyAuthentication yes',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'UsePAM no',
      // 临时目录的属主和权限不合 sshd 平时的要求
      'StrictModes no',
      // 只许客户端这头的 -L：远端 localhost 的转发要用；反向转发、套接字转发都不开
      'AllowTcpForwarding local',
      'AllowStreamLocalForwarding no',
      'AllowAgentForwarding no',
      'X11Forwarding no',
      'PermitTunnel no',
      // 登录进去的环境和这台电脑平时的隔开：家目录换成临时的
      `SetEnv HOME=${home}`,
      'AcceptEnv LITCH_FX_MODE',
      // 移动端的对照组（旧的 tyrs-hand 客户端）选项目目录时走 SFTP
      'Subsystem sftp internal-sftp',
      '',
    ].join('\n'),
  )

  const user = userInfo().username
  /** 一个别名的配置。changes 里的项盖掉共用的那几项；extra 是另加的行 */
  const host = (alias, changes = {}, extra = []) => {
    const options = {
      HostName: '127.0.0.1',
      Port: port,
      User: user,
      IdentityFile: join(root, 'client_key'),
      IdentitiesOnly: 'yes',
      // 不碰用户的密钥代理和 known_hosts；主机密钥严格校验，不自动接受
      IdentityAgent: 'none',
      UserKnownHostsFile: join(root, 'known_hosts'),
      GlobalKnownHostsFile: '/dev/null',
      StrictHostKeyChecking: 'yes',
      ...changes,
    }
    return [
      `Host ${alias}`,
      ...Object.entries(options).map(([name, value]) => `  ${name} ${value}`),
      ...extra.map((line) => `  ${line}`),
      '',
    ].join('\n')
  }
  writeFileSync(
    join(root, 'ssh_config'),
    [
      host(ALIASES.ok),
      host(ALIASES.bare, {}, ['SetEnv LITCH_FX_MODE=bare']),
      host(ALIASES.old, {}, ['SetEnv LITCH_FX_MODE=old']),
      host(ALIASES.nostart, {}, ['SetEnv LITCH_FX_MODE=nostart']),
      host(ALIASES.untrusted, { UserKnownHostsFile: join(root, 'known_hosts_empty') }),
      host(ALIASES.denied, { IdentityFile: join(root, 'other_key') }),
      host(ALIASES.down, { Port: deadPort }),
      host(ALIASES.svc, {}, ['SetEnv LITCH_FX_MODE=svc']),
      host(ALIASES.both, {}, ['SetEnv LITCH_FX_MODE=both']),
      host(ALIASES.svcHome, {}, ['SetEnv LITCH_FX_MODE=svchome']),
      host(ALIASES.legacy, {}, ['SetEnv LITCH_FX_MODE=legacy']),
      host(ALIASES.svcDown, {}, ['SetEnv LITCH_FX_MODE=svcdown']),
      host(ALIASES.svcOld, {}, ['SetEnv LITCH_FX_MODE=svcold']),
      host(ALIASES.grow, {}, ['SetEnv LITCH_FX_MODE=grow']),
    ].join('\n'),
  )

  // OpenSSH 9.8 起 sshd 默认按来源地址记罚分（PerSourcePenalties）：认证失败几次之后一段时间里直接断开回环上的新连接，
  // 而自检要故意试几次登不进去的钥匙（比如扫码绑定的端到端）。认这个选项的版本关掉它，不认的版本本来就没有
  try {
    execFileSync(sshd, ['-t', '-f', join(root, 'sshd_config'), '-o', 'PerSourcePenalties=no'], {
      stdio: 'ignore',
    })
    writeFileSync(join(root, 'sshd_config'), 'PerSourcePenalties no\n', { flag: 'a' })
  } catch {
    // 这个 sshd 没有这一项
  }
  sshdChild = spawn(sshd, ['-D', '-e', '-f', join(root, 'sshd_config')], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let sshdLog = ''
  sshdChild.stderr.on('data', (chunk) => {
    sshdLog = (sshdLog + chunk).slice(-4000)
  })
  sshdChild.on('exit', (code) => {
    if (cleaned) return
    console.error(`sshd 退出了（退出码 ${code}）：\n${sshdLog}`)
    process.exit(1)
  })
  for (let n = 0; !(await canConnect(port)); n++) {
    if (n > 100) throw new Error(`sshd 没有在监听：\n${sshdLog}`)
    await new Promise((done) => setTimeout(done, 50))
  }

  console.log(
    `LITCH_SSH_FIXTURE ${JSON.stringify({
      config: join(root, 'ssh_config'),
      /** 客户端要用 LITCH_REMOTE_CODEX 指到这个名字上 */
      codex: CODEX,
      /** 客户端要用 LITCH_REMOTE_ADAPTER 指到这个名字上 */
      adapter: service.adapter,
      /** 各种“装了适配器”的情形各自的状态目录：svc（both、grow 装上之后也是它）、path、legacy、down */
      states: service.states,
      /** 建出这个文件，grow 那个别名就“装上了适配器”；删掉就又只剩 codex */
      growFlag,
      /** 设备服务那边新建会话时用的工作目录，和每次模型请求记一行的文件 */
      work: service.work,
      modelLog: service.modelLog,
      root,
      /** 替身起的常驻服务把进程号记在这里 */
      daemonPid: join(root, 'c.sock.pid'),
      aliases: ALIASES,
    })}`,
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  cleanup()
  process.exit(1)
}
