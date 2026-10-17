// 去掉一台设备之后：它用的钥匙没有别的设备在用了，就从这台手机上删掉。信任过的主机指纹留着（不是秘密，
// 再加同一台机器时不用再确认一遍）。
import type { RemoteTarget } from '@litch/core'
import { savedRemotes } from '../../platform/device-store'
import { forgetKey, isKeyId } from '../../platform/keys'

export async function forgetUnusedKey(target: RemoteTarget | null): Promise<void> {
  if (target?.kind !== 'host' || !isKeyId(target.keyFile)) return
  const keyId = target.keyFile
  const used = savedRemotes().some(
    (remote) => remote.target.kind === 'host' && remote.target.keyFile === keyId,
  )
  if (!used) await forgetKey(keyId)
}
