// 信任过的主机钥匙：按“主机:端口”记一个指纹（相当于 ssh 的 known_hosts）。手机上没有系统的 ssh，
// 第一次连之前由用户在加设备页上看过指纹、点了信任才记下；之后每次连都只认这一个（比对在 Go 那头，常量时间）。
// 主机钥匙变了不会自动换：要用户在设备详情里看过新的指纹、再点一次信任。
import type { HostKey } from '../../modules/litch-ssh/src'
import { jsonFile } from '../shell/json-file'

export interface KnownHost extends HostKey {
  trustedAt: number
}

const file = jsonFile<Record<string, KnownHost>>('known-hosts.json')

const keyOf = (host: string, port: number | null) => `${host.toLowerCase()}:${port ?? 22}`

function all(): Record<string, KnownHost> {
  const read = file.read()
  return read && typeof read === 'object' && !Array.isArray(read) ? read : {}
}

export function knownHost(host: string, port: number | null): KnownHost | null {
  const found = all()[keyOf(host, port)]
  return found && typeof found.fingerprint === 'string' ? found : null
}

export function trustHost(host: string, port: number | null, key: HostKey): void {
  file.write({
    ...all(),
    [keyOf(host, port)]: {
      fingerprint: key.fingerprint,
      keyType: key.keyType,
      trustedAt: Date.now(),
    },
  })
}

export function forgetHost(host: string, port: number | null): void {
  const next = all()
  delete next[keyOf(host, port)]
  file.write(next)
}
