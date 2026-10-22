// 要在远程机器上跑的那几段脚本，以及怎么把它们送过去。
//
// 对面有两种东西可以连，先找前一种：
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
 * 看一眼对面有什么：适配器在不在、在哪（adapterPath）、报不报得出版本、它的服务现在在不在跑；codex 在不在、是什么版本。
 * 两样都看，由这边按“先设备服务、后 codex”定；不启动任何东西。输出是一行一个 `键=值`。
 * “服务在不在跑”用代理子命令来试：标准输入直接结束时，聚合面连得上它以 0 退出，连不上以非 0 退出。
 */
export function probeScript(): RemoteScript {
  return wrap(({ marker, adapter, codex }) => [
    `printf '%s\\n' ${quote(marker)}`,
    `printf 'system=%s\\n' "$(uname -s 2>/dev/null)"`,
    `if ${has(adapter)}; then`,
    '  echo adapter=yes',
    // 命令解开链接之后的真实位置：一键升级按它认是怎么装的（安装脚本、Homebrew），见核心的 installMethodOf。
    // 不用 readlink -f（老的 macOS 没有），照安装包入口 adapter-launcher.sh 的写法一层层解
    `  at=$(command -v ${adapter})`,
    '  n=0',
    '  while [ -L "$at" ] && [ "$n" -lt 20 ]; do',
    '    link=$(readlink "$at")',
    '    case $link in /*) at=$link ;; *) at=$(dirname "$at")/$link ;; esac',
    '    n=$((n + 1))',
    '  done',
    `  printf 'adapterPath=%s\\n' "$at"`,
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

// ---------- 一键升级：装新版、请服务空闲时停下 ----------
// 两段脚本的送法和上面三段一样。里面只有写死的命令名、应用自己的版本号和写死的下载地址，
// 没有任何对面给的值；版本号先校验成只有语义化版本的字符，再放进单引号。

/** 安装脚本和发布包都从这里取（scripts/install.sh 的 RELEASES 是同一个地址） */
const RELEASES = 'https://github.com/slovx2/litch/releases'

/**
 * 下载地址的前缀。平时就是 RELEASES；LITCH_REMOTE_RELEASES 只给开发和自检用：
 * 换成一个 file:// 的本地目录（里面照发布页的样子放 download/v<版本>/ 下的几样），装的时候就不联网
 */
function releases(): string {
  const given = process.env.LITCH_REMOTE_RELEASES?.trim()
  if (!given) return RELEASES
  if (!/^(?:https:\/\/|file:\/\/\/)[A-Za-z0-9_./:-]+$/.test(given)) {
    throw new Error(`LITCH_REMOTE_RELEASES 不是一个合规的地址：${given}`)
  }
  return given.replace(/\/+$/, '')
}

/** 只许是语义化版本的字符（和 install.sh 的 valid_version 一样严） */
function versionName(version: string): string {
  if (!/^[0-9][0-9A-Za-z.+-]*$/.test(version)) throw new Error(`不是一个版本号：${version}`)
  return version
}

/** 远端命令行说哪种语言：跟界面的。安装脚本和适配器都认 CHA_LANG */
export type RemoteLang = 'zh-CN' | 'en'

export interface InstallPlan {
  /** script：下载这一版的安装脚本来装；brew：brew upgrade */
  method: 'script' | 'brew'
  /** 要装的版本：应用自己的版本 */
  version: string
  lang: RemoteLang
}

/** 跑一句命令、把它的原话收进 said，退出码收进 code（这两行之后接着判断） */
const capture = (command: string): string[] => [
  `said=$(${command} </dev/null 2>&1)`,
  'code=$?',
  `printf '%s\\n' "$said" | sed 's/^/said=/'`,
]

/** 停在这一步：报出是哪一步、退出码，脚本以 0 结束（没走到 step= 这一行的，是半路断了） */
const stopAt = (step: string): string[] => [
  `echo step=${step}`,
  `printf 'code=%s\\n' "$code"`,
  'exit 0',
]

/**
 * 在对面装新版。输出一行一个 `键=值`：
 *   said=…        各步命令的原话（多行），给“详情”用
 *   step=…        走到了哪一步：fetch（没有 curl、wget）、download、install、brew、verify
 *   code=…        那一步的退出码；verify 是 0 才算装好了
 *   installed=…   装完问到的版本那一行（`codex-harness-adapter 0.16.0`）
 * 安装脚本那一种先把这一版的 install.sh 下到临时目录再执行（不用 curl | sh：下载断了时 sh 会拿到半截脚本），
 * 带上 --version（装的就是应用的这一版）和 --base-url（和下载 install.sh 的是同一处）。
 * 安装脚本自己核对 SHA-256 清单，对不上不装；它不停、不重启在跑的服务。
 */
export function installScript(plan: InstallPlan): RemoteScript {
  const version = quote(versionName(plan.version))
  const base = quote(releases())
  return wrap(({ marker, adapter }) => [
    `printf '%s\\n' ${quote(marker)}`,
    `CHA_LANG=${quote(plan.lang)}`,
    'export CHA_LANG',
    ...(plan.method === 'brew'
      ? [
          `if ! ${has('brew')}; then code=127; ${stopAt('brew').join('; ')}; fi`,
          ...capture('brew upgrade codex-harness-adapter'),
          `if [ "$code" -ne 0 ]; then ${stopAt('brew').join('; ')}; fi`,
        ]
      : [
          'work=$(mktemp -d 2>/dev/null || mktemp -d -t litch-upgrade 2>/dev/null)',
          `if [ -z "$work" ]; then code=1; ${stopAt('download').join('; ')}; fi`,
          `trap 'rm -rf "$work"' EXIT`,
          `url=${base}/download/v${version}/install.sh`,
          `if ${has('curl')}; then`,
          ...capture('curl -fsSL -o "$work/install.sh" "$url"').map((line) => `  ${line}`),
          `elif ${has('wget')}; then`,
          ...capture('wget -q -O "$work/install.sh" "$url"').map((line) => `  ${line}`),
          'else',
          `  code=127; ${stopAt('fetch').join('; ')}`,
          'fi',
          `if [ "$code" -ne 0 ]; then ${stopAt('download').join('; ')}; fi`,
          ...capture(`sh "$work/install.sh" --version ${version} --base-url ${base}`),
          `if [ "$code" -ne 0 ]; then ${stopAt('install').join('; ')}; fi`,
        ]),
    // 装完问一句现在装着的是哪一版。命令名还是那一个：安装脚本换的是它指向的 current，Homebrew 换的是 Cellar 里的那份
    `if said=$(${adapter} version </dev/null 2>&1); then`,
    `  printf '%s\\n' "$said" | sed -n '1s/^/installed=/p'`,
    '  code=0',
    'else',
    '  code=$?',
    `  printf '%s\\n' "$said" | sed 's/^/said=/'`,
    'fi',
    ...stopAt('verify'),
  ])
}

/**
 * 请对面的服务停下（device-stop）。ifIdle 为 true 时它不闲就不停（回合在跑、终端开着、别的客户端连着），
 * 为 false 时照停，进行中的事会被打断：只在“立即换上”的第二次确认之后用。
 * 输出：out=（它标准输出的那一行 JSON，里面有 busy）、said=（给人看的那一句）、code=（它的退出码，含义见 device_stop.go）。
 * 用的是装完之后命令名指向的那一份（新版），所以旧服务自己没有 device-stop 这条命令也停得了，只要它认得停止请求
 */
export function stopScript(options: { ifIdle: boolean; lang: RemoteLang }): RemoteScript {
  const flag = options.ifIdle ? ' --if-idle' : ''
  return wrap(({ marker, adapter }) => [
    `printf '%s\\n' ${quote(marker)}`,
    `${has(adapter)} || exit ${EXIT.notFound}`,
    `CHA_LANG=${quote(options.lang)}`,
    'export CHA_LANG',
    // 标准输出和标准错误分开收：前者是给程序读的那一行，后者是给人看的那一句
    'note=$(mktemp 2>/dev/null || mktemp -t litch-stop 2>/dev/null) || note=',
    `out=$(${adapter} device-stop${flag} </dev/null 2>"\${note:-/dev/null}")`,
    'code=$?',
    // 服务把连着的客户端也算“不闲”，发请求的这个应用自己就连着，光凭它永远等不到闲。
    // 客户端断了会自己重连（连上的就是新版），不算要等的事：不闲的原因只有客户端时，紧接着不带 --if-idle 再停一次
    ...(options.ifIdle
      ? [
          `if [ "$code" = 4 ] && printf '%s' "$out" | grep -q '"reason":"clients"' &&`,
          `  ! printf '%s' "$out" | grep -o '"reason":"[A-Za-z]*"' | grep -qv '"reason":"clients"'; then`,
          `  out=$(${adapter} device-stop </dev/null 2>"\${note:-/dev/null}")`,
          '  code=$?',
          'fi',
        ]
      : []),
    `if [ -n "$note" ]; then sed 's/^/said=/' "$note"; rm -f "$note"; fi`,
    `printf '%s\\n' "$out" | sed 's/^/out=/'`,
    `printf 'code=%s\\n' "$code"`,
  ])
}
