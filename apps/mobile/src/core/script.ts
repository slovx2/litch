// 要在远程机器上跑的那几段脚本：和桌面端 apps/desktop/src/ssh/script.mts 同一套做法（三步走、经登录 shell、
// 打印随机标记切掉启动脚本的杂乱输出、整段包在花括号里），只是不依赖 Node：随机数由外壳给，命令名由调用方给。
// 原型只接设备服务（聚合面），不接原生 codex。

/** 远程脚本用退出码说明停在了哪一步（和桌面端一致） */
export const EXIT = { notFound: 71, broken: 72, noDir: 73, startFailed: 74 } as const

export interface RemoteScript {
  /** 喂给对面 `exec sh` 的全部内容 */
  text: string
  /** 这一行之后才是脚本自己的输出 */
  marker: string
}

export interface ScriptNames {
  /** 远端适配器的命令名。平时是 codex-harness-adapter；测试夹具里是一个替身的名字 */
  adapter: string
  /** 16 字节随机数的十六进制写法 */
  randomHex: () => string
}

const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`

function checkName(name: string): string {
  if (!/^[A-Za-z0-9_./-]+$/.test(name) || name.startsWith('-')) {
    throw new Error(`不是一个合规的命令名：${name}`)
  }
  return name
}

function wrap(
  names: ScriptNames,
  inner: (marker: string, adapter: string) => string[],
): RemoteScript {
  const marker = `litch-${names.randomHex()}`
  const adapter = quote(checkName(names.adapter))
  const body = [
    'PATH="$PATH:${CODEX_INSTALL_DIR:+$CODEX_INSTALL_DIR:}$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"',
    'export PATH',
    ...inner(marker, adapter),
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

/** 看一眼对面：适配器在不在、什么版本、服务在不在跑。输出一行一个 `键=值` */
export function probeScript(names: ScriptNames): RemoteScript {
  return wrap(names, (marker, adapter) => [
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
  ])
}

/** 让设备服务常驻（幂等），它说的话每行前面加 `said=`，退出码在 `code=` 里 */
export function startScript(names: ScriptNames): RemoteScript {
  return wrap(names, (marker, adapter) => [
    `printf '%s\\n' ${quote(marker)}`,
    `${has(adapter)} || exit ${EXIT.notFound}`,
    `said=$(${adapter} device-start --ssh=off </dev/null 2>&1)`,
    'code=$?',
    `printf '%s\\n' "$said" | sed 's/^/said=/'`,
    `printf 'code=%s\\n' "$code"`,
  ])
}

/** 接到设备服务上：`<标记> service` 那一行之后，这条 ssh 的标准输入输出就是聚合面的套接字 */
export function proxyScript(names: ScriptNames): RemoteScript {
  return wrap(names, (marker, adapter) => [
    `${has(adapter)} || exit ${EXIT.notFound}`,
    `printf '%s service\\n' ${quote(marker)}`,
    `exec ${adapter} device-proxy`,
  ])
}

/** 把 `键=值` 的输出读成一张表；同一个键出现多次的（said）连成多行 */
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
