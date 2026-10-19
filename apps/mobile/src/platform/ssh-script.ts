// 要在远程机器上跑的那几段脚本：和桌面端 apps/desktop/src/ssh/script.mts 同一套做法，只是不依赖 Node：
// 随机数由外壳给，命令名由调用方给。三步走（探测、启动、代理）、经登录 shell、打印随机标记切掉启动脚本的
// 杂乱输出、整段包在花括号里，这几条的道理都写在桌面端那一份的开头，这里不重抄。
//
// 对面有两种东西可以连，先找前一种：
//   设备服务：装了我们的适配器（完整模式）
//   codex：只有原生 codex（单 harness 模式）

/** 远程脚本用退出码说明停在了哪一步（和桌面端一致） */
export const EXIT = { notFound: 71, broken: 72, noDir: 73, startFailed: 74 } as const

/** 原生 codex 从这个版本起才有“常驻服务加代理子命令”（和桌面端一致） */
export const MIN_CODEX = '0.125.0'
/** 适配器的版本下限：认识 version、device-start、device-proxy 的第一版（和桌面端一致） */
export const MIN_ADAPTER = '0.6.0'

/** 对面连的是哪一种 */
export type Peer = 'service' | 'codex'

export interface RemoteScript {
  /** 喂给对面 `exec sh` 的全部内容 */
  text: string
  /** 这一行之后才是脚本自己的输出 */
  marker: string
}

export interface ScriptNames {
  /** 远端适配器的命令名。平时是 codex-harness-adapter；测试夹具里是一个替身的名字 */
  adapter: string
  /** 远端 codex 的命令名。平时是 codex */
  codex: string
  /** 16 字节随机数的十六进制写法 */
  randomHex: () => string
}

/** Litch 桌面端的应用包里自带适配器的目录（scripts/stage-adapter.mjs 摆的布局）：装在系统的和用户自己的“应用程序”里 */
const BUNDLED_ADAPTER_DIRS = [
  '/Applications/Litch.app/Contents/Resources/adapter/bin',
  '$HOME/Applications/Litch.app/Contents/Resources/adapter/bin',
].join(':')

const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`

/** 只许是一个不带空白和引号的命令名或路径 */
export function checkName(name: string): string {
  if (!/^[A-Za-z0-9_./-]+$/.test(name) || name.startsWith('-')) {
    throw new Error(`不是一个合规的命令名：${name}`)
  }
  return name
}

interface Quoted {
  marker: string
  adapter: string
  codex: string
}

function wrap(names: ScriptNames, inner: (quoted: Quoted) => string[]): RemoteScript {
  const marker = `litch-${names.randomHex()}`
  const body = [
    // 最后两项是 macOS 上 Litch 桌面端自带的适配器：只装了桌面端、没装独立版的电脑（比如手机绑本机）也找得到。
    // 放在最后，装了独立版的照旧用独立版；两份共用一个状态目录，设备服务已经在跑时 device-proxy 连的就是它
    `PATH="$PATH:\${CODEX_INSTALL_DIR:+$CODEX_INSTALL_DIR:}$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:${BUNDLED_ADAPTER_DIRS}"`,
    'export PATH',
    ...inner({
      marker,
      adapter: quote(checkName(names.adapter)),
      codex: quote(checkName(names.codex)),
    }),
  ].join('\n')
  // 花括号让 sh 把整段读完才执行：不然 exec 之后没读的几行会留在标准输入里，被代理当成数据发给对面
  const text = [
    '{',
    `LITCH_RUN=${quote(body)}`,
    'export LITCH_RUN',
    'shell="${SHELL:-}"',
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

const has = (command: string): string => `command -v ${command} >/dev/null 2>&1`

/**
 * 看一眼对面：适配器在不在、什么版本、它的服务在不在跑；codex 在不在、什么版本。不启动任何东西。
 * 输出一行一个 `键=值`
 */
export function probeScript(names: ScriptNames): RemoteScript {
  return wrap(names, ({ marker, adapter, codex }) => [
    `printf '%s\\n' ${quote(marker)}`,
    `printf 'system=%s\\n' "$(uname -s 2>/dev/null)"`,
    `if ${has(adapter)}; then`,
    '  echo adapter=yes',
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
 * 让对面的服务常驻（幂等）。设备服务：device-start 说的话每行前面加 `said=`，退出码在 `code=` 里；
 * codex：已经在听就什么都不做，没有就在后台起一份、轮询到能连，起不来时带回日志的末尾（`log=`）
 */
export function startScript(names: ScriptNames, peer: Peer): RemoteScript {
  if (peer === 'service') {
    return wrap(names, ({ marker, adapter }) => [
      `printf '%s\\n' ${quote(marker)}`,
      `${has(adapter)} || exit ${EXIT.notFound}`,
      `said=$(${adapter} device-start --ssh=off </dev/null 2>&1)`,
      'code=$?',
      `printf '%s\\n' "$said" | sed 's/^/said=/'`,
      `printf 'code=%s\\n' "$code"`,
    ])
  }
  return wrap(names, ({ marker, codex }) => [
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
 * 接到对面的服务上：`<标记> service` 或 `<标记> codex` 那一行之后，这条 ssh 的标准输入输出就是那条套接字。
 * auto 由对面当场认，先适配器后 codex
 */
export function proxyScript(names: ScriptNames, peer: Peer | 'auto'): RemoteScript {
  return wrap(names, ({ marker, adapter, codex }) => {
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

/** 把 `键=值` 的输出读成一张表；同一个键出现多次的（said、log）连成多行 */
export function parsePairs(output: string): Record<string, string> {
  const pairs: Record<string, string> = {}
  for (const line of output.split('\n')) {
    const at = line.indexOf('=')
    if (at <= 0) continue
    const key = line.slice(0, at)
    const value = line.slice(at + 1)
    pairs[key] = key in pairs ? `${pairs[key]}\n${value}` : value
  }
  return pairs
}
