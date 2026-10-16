// 要在远程机器上跑的那几段脚本，以及怎么把它们送过去。
//
// 对面有两种东西可以连，先找前一种（设计文档 03 第七节、第 12.1 节）：
//   设备服务：那台机器上装了我们的适配器。一条连接里是那台机器上全部的 harness（完整模式）
//   codex：只有原生 codex。连它自己的常驻服务（单 harness 模式）
// 三步走的命令各是：
//                 设备服务                                   codex
//   探测          <适配器> version                            codex --version
//   启动（幂等）   <适配器> device-start --ssh=off             codex app-server --listen unix://（在后台）
//   代理          <适配器> device-proxy                       codex app-server proxy
// 适配器的 device-start 自己就是幂等的，拉起的服务自己脱离这次登录（另起会话，标准输入输出都不继承），
// 所以那一步不用 nohup，也不用我们自己轮询；它给官方桌面端开的那几个 SSH 端口这里一律不要（--ssh=off），
// 我们接的是套接字文件。状态目录用它默认的那一个（~/.codex-harness-adapter），和那台机器上平时用的是同一份。
//
// 送法：ssh 的远程命令固定是 `exec sh`，脚本从标准输入喂给它。这样脚本不经过对面登录 shell 的
// 引号规则（bash、zsh、fish、csh 各不相同），远程命令里也就没有任何要转义的东西。
// 脚本里没有任何用户给的值：命令名是写死的，只有开发和自检能用环境变量换成别的名字。
//
// 脚本分两层。外层由 sh 执行，只做一件事：换到用户的登录 shell 里再执行内层，这样 PATH 之类的
// 环境和用户自己开终端时一致（codex 常常装在只有启动脚本才会加进 PATH 的目录里）。
// 内层仍然是 POSIX sh 的写法，放在环境变量里带过去。
//
// 登录 shell 的启动脚本会往标准输出里写各种东西（欢迎语、提示符的装饰）。内层脚本开工前先打印一行
// 随机的标记，这一行之前的输出全部丢掉。
import { randomBytes } from 'node:crypto'

/** 远程脚本用退出码说明停在了哪一步。ssh 自己出错是 255，这几个避开常见的值 */
export const EXIT = {
  /** 找不到要用的那个命令：适配器和 codex 都没有，或者指定要的那一个没有 */
  notFound: 71,
  /** codex 在，但运行不了（报不出版本号） */
  broken: 72,
  /** 放日志的目录建不出来 */
  noDir: 73,
  /** 服务起了但一直没就绪，或者一起来就退了 */
  startFailed: 74,
} as const

/** 原生 codex 从这个版本起才有“常驻服务加代理子命令”（app-server --listen unix:// 和 app-server proxy） */
export const MIN_CODEX = '0.125.0'

/**
 * 适配器的版本下限。真正的门槛是它认不认识 version 子命令：这条命令和 device-start、device-proxy
 * 是同一批加的，认识它就有设备服务；更早的版本对它报“未知命令”，那时连版本号都问不出来。
 * 这个数是给以后留的：哪一版起客户端离不开某样东西，就把它提到那一版。
 */
export const MIN_ADAPTER = '0.6.0'

/** 对面连的是哪一种 */
export type Peer = 'service' | 'codex'

/** 只许是一个不带空白和引号的命令名或路径 */
function commandName(variable: string, fallback: string): string {
  const name = process.env[variable]?.trim() || fallback
  if (!/^[A-Za-z0-9_./-]+$/.test(name) || name.startsWith('-')) {
    throw new Error(`${variable} 不是一个合规的命令名：${name}`)
  }
  return name
}

/**
 * 远程机器上 codex 的命令名。平时就是 codex；LITCH_REMOTE_CODEX 可以换成别的名字或绝对路径
 * （装在不寻常的位置时用，自检也用它指向一个替身）。
 */
const codexCommand = (): string => commandName('LITCH_REMOTE_CODEX', 'codex')

/**
 * 远程机器上适配器的命令名。平时就是 codex-harness-adapter；LITCH_REMOTE_ADAPTER 只给开发和自检用：
 * 假的远程机器就是这台电脑，换一个别处不会有的名字，自检才不会跑到这台电脑上真装着的那一份。
 */
const adapterCommand = (): string => commandName('LITCH_REMOTE_ADAPTER', 'codex-harness-adapter')

/** 把一段字放进 POSIX sh 的单引号里 */
const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`

export interface RemoteScript {
  /** 喂给对面 sh 的全部内容 */
  text: string
  /** 这一行之后才是脚本自己的输出 */
  marker: string
}

interface Names {
  marker: string
  /** 已经加好引号，可以直接写进脚本 */
  adapter: string
  codex: string
}

/** 把内层脚本包成可以喂给 `exec sh` 的样子 */
function wrap(inner: (names: Names) => string[]): RemoteScript {
  const marker = `litch-${randomBytes(16).toString('hex')}`
  const body = [
    // 用户自己的 PATH 在前；后面补几个常见的安装位置，启动脚本没生效时也还找得到。
    // ~/.local/bin 是适配器的安装脚本（scripts/install.sh）放命令的地方，也是 codex 的安装脚本默认的位置
    // （它认 CODEX_INSTALL_DIR，设了就把那个目录也补上）；后两个是 Homebrew 的。
    // 补在最后：用户自己排在前面的同名命令优先
    'PATH="$PATH:${CODEX_INSTALL_DIR:+$CODEX_INSTALL_DIR:}$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"',
    'export PATH',
    ...inner({ marker, adapter: quote(adapterCommand()), codex: quote(codexCommand()) }),
  ].join('\n')
  // 整段外层脚本包在一对花括号里，是一条完整的命令：sh 要把它整个读完才开始执行。
  // 不这样的话，sh 执行到中间那句 exec 时，后面还没读的几行会留在标准输入里，
  // 被接下来的代理子命令当成数据发给对面的服务，握手就坏了。花括号之后只能有一个换行。
  const text = [
    '{',
    `LITCH_RUN=${quote(body)}`,
    'export LITCH_RUN',
    'shell="${SHELL:-}"',
    // 认得的 shell 才换过去：它们都支持 -l -i -c，也都能照原样执行下面这一句。
    // 别的（csh、nu 之类）就留在 sh 里跑，那时用户启动脚本里的设置不生效。
    'case "${shell##*/}" in',
    '  bash|zsh|ksh|mksh|dash|ash|sh|fish)',
    `    if [ -x "$shell" ]; then exec "$shell" -l -i -c 'exec sh -c "$LITCH_RUN"'; fi ;;`,
    'esac',
    'exec sh -c "$LITCH_RUN"',
    '}',
    '',
  ].join('\n')
  return { text, marker }
}

/** 有没有这个命令 */
const has = (command: string): string => `command -v ${command} >/dev/null 2>&1`

/**
 * 看一眼对面有什么：适配器在不在、报不报得出版本、它的服务现在在不在跑；codex 在不在、是什么版本。
 * 两样都看，由这边按“先设备服务、后 codex”定；不启动任何东西。输出是一行一个 `键=值`。
 * “服务在不在跑”用代理子命令来试：标准输入直接结束时，聚合面连得上它以 0 退出，连不上以非 0 退出。
 */
export function probeScript(): RemoteScript {
  return wrap(({ marker, adapter, codex }) => [
    `printf '%s\\n' ${quote(marker)}`,
    `printf 'system=%s\\n' "$(uname -s 2>/dev/null)"`,
    `if ${has(adapter)}; then`,
    '  echo adapter=yes',
    // 报不出版本的：把它的原话带回来，多半是一句“未知命令”
    `  if said=$(${adapter} version </dev/null 2>&1); then`,
    `    printf '%s\\n' "$said" | sed -n '1s/^/adapterVersion=/p'`,
    `    if ${adapter} device-proxy </dev/null >/dev/null 2>&1; then echo adapterRunning=yes; fi`,
    '  else',
    `    printf '%s\\n' "$said" | sed 's/^/adapterSaid=/'`,
    '  fi',
    'fi',
    `if ${has(codex)}; then`,
    '  echo codex=yes',
    `  if said=$(${codex} --version </dev/null 2>/dev/null); then`,
    `    printf '%s\\n' "$said" | sed -n '1s/^/codexVersion=/p'`,
    '  fi',
    'fi',
  ])
}

/**
 * 让对面的服务常驻，等它能连上再返回。起的那一份脱离这条 ssh：这条连接断了，对面的会话和正在跑的回合都不受影响。
 *
 * 设备服务：执行适配器的 device-start。它是幂等的（已经在跑就直接成功），自己等聚合面就绪，
 * 拉起的服务另起会话、不继承这边的标准输入输出，所以这条 ssh 不会被它拖住。它说的话（成功时的那一行 JSON、
 * 没成功时的原因）原样带回来，每行前面加 `said=`；它的退出码放在 `code=` 里（0 能连了，3 是有一份不带聚合面的
 * 旧服务在跑，别的是没起来）。脚本自己以 0 退出：没走到 `code=` 这一行的，是半路断了。
 *
 * codex：已经有一份在听就什么都不做；没有就在后台起一份，轮询到它能连上。
 * “有没有在听”用代理子命令来试，和上面一样。
 */
export function startScript(peer: Peer): RemoteScript {
  if (peer === 'service') {
    return wrap(({ marker, adapter }) => [
      `printf '%s\\n' ${quote(marker)}`,
      `${has(adapter)} || exit ${EXIT.notFound}`,
      `said=$(${adapter} device-start --ssh=off </dev/null 2>&1)`,
      'code=$?',
      `printf '%s\\n' "$said" | sed 's/^/said=/'`,
      `printf 'code=%s\\n' "$code"`,
    ])
  }
  return wrap(({ marker, codex }) => [
    `printf '%s\\n' ${quote(marker)}`,
    `${has(codex)} || exit ${EXIT.notFound}`,
    `if ${codex} app-server proxy </dev/null >/dev/null 2>&1; then echo state=running; exit 0; fi`,
    'umask 077',
    'dir="$HOME/.litch"',
    `mkdir -p "$dir" || exit ${EXIT.noDir}`,
    'log="$dir/codex-app-server.log"',
    ': >"$log"',
    `nohup ${codex} app-server --listen unix:// </dev/null >>"$log" 2>&1 &`,
    'pid=$!',
    'n=0',
    'while [ "$n" -lt 60 ]; do',
    `  if ${codex} app-server proxy </dev/null >/dev/null 2>&1; then echo state=started; exit 0; fi`,
    '  kill -0 "$pid" 2>/dev/null || break',
    '  sleep 0.5 2>/dev/null || sleep 1',
    '  n=$((n + 1))',
    'done',
    'tail -n 20 "$log" 2>/dev/null | sed "s/^/log=/"',
    `exit ${EXIT.startFailed}`,
  ])
}

/**
 * 接到对面的服务上：标记那一行之后，这条 ssh 的标准输入输出就是那条套接字。
 * 标记后面跟着接的是哪一种（`<标记> service` 或 `<标记> codex`）。
 *
 * auto：由对面当场认，先适配器后 codex。平时每次连接的第一条 ssh 都是它：对面是什么不靠这边记，
 * 所以对面装上了适配器、卸掉了适配器，下一次连接自己就换过去了；认一次只是对面的一次 `command -v`，不多一趟往返。
 * 适配器在而它的服务没在跑（或者太旧、没有这条子命令）时，代理子命令会直接退出，这边握不上手，接着走探测和启动。
 */
export function proxyScript(peer: Peer | 'auto'): RemoteScript {
  return wrap(({ marker, adapter, codex }) => {
    const service = [`printf '%s service\\n' ${quote(marker)}`, `exec ${adapter} device-proxy`]
    const native = [`printf '%s codex\\n' ${quote(marker)}`, `exec ${codex} app-server proxy`]
    if (peer === 'service') return [`${has(adapter)} || exit ${EXIT.notFound}`, ...service]
    if (peer === 'codex') return [`${has(codex)} || exit ${EXIT.notFound}`, ...native]
    return [
      `if ${has(adapter)}; then`,
      ...service.map((line) => `  ${line}`),
      'fi',
      `${has(codex)} || exit ${EXIT.notFound}`,
      ...native,
    ]
  })
}
