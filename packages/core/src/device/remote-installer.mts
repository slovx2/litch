// 首次安装与升级共用的脚本片段。纯 TypeScript，桌面和手机分别包进自己的 SSH 登录脚本。
import type { RemoteInstallMethod, RemoteInstallResult } from '../model-service.mjs'

export const REMOTE_RELEASES = 'https://github.com/slovx2/litch/releases'
export const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`
export function installVersion(version: string): string {
  if (!/^[0-9][0-9A-Za-z.+-]*$/.test(version)) throw new Error(`不是一个版本号：${version}`)
  return version
}
export const installCapture = (command: string): string[] => [
  `said=$(${command} </dev/null 2>&1)`,
  'code=$?',
  `printf '%s\\n' "$said" | sed 's/^/said=/'`,
]
export const installStop = (step: string): string[] => [
  `echo step=${step}`,
  `printf 'code=%s\\n' "$code"`,
  'exit 0',
]
export function downloadBody(version: string, base: string): string[] {
  return [
    `url=${shellQuote(base)}/download/v${shellQuote(installVersion(version))}/install.sh`,
    'if command -v curl >/dev/null 2>&1; then',
    ...installCapture('curl -fsSL -o "$work/install.sh" "$url"'),
    'elif command -v wget >/dev/null 2>&1; then',
    ...installCapture('wget -q -O "$work/install.sh" "$url"'),
    'else',
    'echo said=Neither curl nor wget is installed',
    `code=127; ${installStop('fetch').join('; ')}`,
    'fi',
    `if [ "$code" -ne 0 ]; then ${installStop('download').join('; ')}; fi`,
  ]
}
export function executeInstallBody(version: string, base: string): string[] {
  return [
    ...installCapture(
      `sh "$work/install.sh" --version ${shellQuote(installVersion(version))} --base-url ${shellQuote(base)}`,
    ),
    `if [ "$code" -ne 0 ]; then ${installStop('install').join('; ')}; fi`,
  ]
}
export function verifyInstallBody(adapter: string): string[] {
  return [
    `if said=$(${adapter} version </dev/null 2>&1); then`,
    `printf '%s\\n' "$said" | sed -n '1s/^/installed=/p'`,
    'code=0',
    'else',
    'code=$?',
    `printf '%s\\n' "$said" | sed 's/^/said=/'`,
    'fi',
    ...installStop('verify'),
  ]
}
/** 首次安装分两趟 SSH，原生手机桥也能准确显示下载/安装阶段，无需分析安装器的自然语言输出。 */
export function firstInstallBody(
  stage: 'download' | 'install' | 'clean',
  token: string,
  version: string,
  adapter: string,
  base = REMOTE_RELEASES,
): string[] {
  if (!/^[a-f0-9]{32}$/.test(token)) throw new Error('安装任务标识无效')
  const work = [`work="\${TMPDIR:-/tmp}/litch-install-${token}"`]
  if (stage === 'clean') return [...work, 'rm -rf -- "${work:?}"']
  if (stage === 'download')
    return [
      ...work,
      'umask 077',
      ...installCapture('mkdir "$work"'),
      `if [ "$code" -ne 0 ]; then ${installStop('download').join('; ')}; fi`,
      // 下载失败立即清理；成功留给下一步，核心在取消或过期时也会清理。
      `trap 'rm -rf -- "\${work:?}"' EXIT`,
      ...downloadBody(version, base),
      'trap - EXIT',
      'echo step=download',
      'echo code=0',
    ]
  return [
    ...work,
    `trap 'rm -rf -- "\${work:?}"' EXIT`,
    ...executeInstallBody(version, base),
    ...verifyInstallBody(adapter),
  ]
}
export const installProbeBody = [
  `printf 'system=%s\\n' "$(uname -s 2>/dev/null)"`,
  'if command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then echo downloader=yes; fi',
]
export function installBlocked(out: Record<string, string>): 'system' | 'fetch' | null {
  if (!/^(Linux|Darwin)$/.test(out.system ?? '')) return 'system'
  return out.downloader === 'yes' ? null : 'fetch'
}
export function firstInstallCommand(version: string): string {
  const url = `${REMOTE_RELEASES}/download/v${installVersion(version)}/install.sh`
  return `work=$(mktemp -d) && (trap 'rm -rf -- "\${work:?}"' EXIT; if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$work/install.sh" '${url}'; else wget -O "$work/install.sh" '${url}'; fi && sh "$work/install.sh" --version '${version}')`
}

const said = (text: string | undefined): string | null => text?.trim().slice(-4000) || null
export function readInstall(
  out: Record<string, string>,
  method: RemoteInstallMethod,
): RemoteInstallResult {
  const code = out.code === undefined ? null : Number(out.code)
  const step = out.step
  const installed = out.installed?.match(/^codex-harness-adapter\s+(\S+)/)?.[1]
  if (step === 'verify' && code === 0 && installed)
    return { ok: true, installed, said: said(out.said) }
  const at =
    step === 'fetch' ||
    step === 'download' ||
    step === 'install' ||
    step === 'brew' ||
    step === 'verify'
      ? step
      : method === 'brew'
        ? 'brew'
        : 'install'
  const match =
    method === 'script'
      ? out.said?.match(/^LITCH_INSTALL_DISK_SPACE\t([^\r\n\t]+)\t(\d+)\t(\d+)$/m)
      : null
  const requiredKiB = Number(match?.[2]),
    availableKiB = Number(match?.[3])
  const diskSpace =
    match?.[1] && Number.isSafeInteger(requiredKiB) && Number.isSafeInteger(availableKiB)
      ? { path: match[1], requiredKiB, availableKiB }
      : undefined
  return {
    ok: false,
    at,
    code: Number.isFinite(code) ? code : null,
    said: said(out.said),
    ...(diskSpace ? { diskSpace } : {}),
  }
}
