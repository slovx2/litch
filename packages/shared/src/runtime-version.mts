export const CODEX_PROTOCOL_VERSION = '0.157.1'

export function platformFamily(): string {
  return process.platform === 'win32' ? 'windows' : 'unix'
}

export function platformOs(): string {
  return process.platform === 'darwin'
    ? 'macos'
    : process.platform === 'win32'
      ? 'windows'
      : process.platform
}

export function codexCliVersion(version = CODEX_PROTOCOL_VERSION, originator = ''): string {
  return `codex-cli ${version}${originator ? ` (${originator})` : ''}`
}

// Desktop 从首段解析 app-server 版本；引擎标识只能放在 originator，不能替代协议版本。
export function codexUserAgent(
  clientName: string,
  clientVersion: string,
  version = CODEX_PROTOCOL_VERSION,
  originator = 'unknown',
): string {
  const name = clientName.trim() || 'codex-app'
  const client = clientVersion.trim() || 'unknown'
  const cpu =
    process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch
  return `${name}/${version} (${platformOs()}; ${cpu}) ${originator || 'unknown'} (${name}; ${client})`
}
