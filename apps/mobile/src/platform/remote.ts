// 给核心的远程能力（RemotePlatform）：一份连接配置（RemoteTarget）怎么连。
// 每次连都现取钥匙和记下的主机指纹，所以改了钥匙、重新信任了主机，下一次重连就用上。
// 手机上没有 ssh 配置文件，discover 永远是空的；别名（kind: 'alias'）也就不认。
import {
  type Clock,
  ConnectError,
  phrase,
  type RemotePlatform,
  type RemoteTarget,
} from '@litch/core'
import { remoteDev } from './dev'
import { keySecret } from './keys'
import { knownHost } from './known-hosts'
import { checkRemote, type RemoteConfig, sshOpener } from './ssh-transport'

const ADAPTER = 'codex-harness-adapter'

/** 由设备配置拼出这一次连接要的全部东西。缺了什么就抛一个说明原因的错误 */
export async function configFor(target: RemoteTarget): Promise<RemoteConfig> {
  if (target.kind !== 'host') {
    throw new ConnectError(
      'unreachable',
      phrase('ssh.config'),
      false,
      '手机上没有 SSH 配置，不支持主机别名',
    )
  }
  if (!target.user) {
    throw new ConnectError('auth', phrase('ssh.auth'), false, '[invalid] 未填写用户名')
  }
  const secret = target.keyFile ? await keySecret(target.keyFile) : null
  if (!secret) {
    throw new ConnectError('auth', phrase('ssh.auth'), false, '[key] 此手机上已没有该密钥')
  }
  const port = target.port ?? 22
  const dev = remoteDev()
  return {
    target: {
      host: target.host,
      port,
      user: target.user,
      privateKey: secret.privateKey,
      passphrase: secret.passphrase,
      // 没记下就是空的：SSH 模块会以“没确认过指纹”拒绝，界面引导用户去确认
      hostFingerprint: knownHost(target.host, port)?.fingerprint ?? '',
      ...(dev.env ? { env: dev.env } : {}),
    },
    adapter: dev.adapter ?? ADAPTER,
    ...(dev.codex ? { codex: dev.codex } : {}),
  }
}

export function mobileRemote(clock: Clock, version: string): RemotePlatform {
  return {
    opener: (target) => sshOpener(() => configFor(target)),
    discover: async () => [],
    check: (target, signal) => checkRemote(() => configFor(target), signal, clock, version),
  }
}
