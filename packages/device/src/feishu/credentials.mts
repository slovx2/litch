// App Secret 存设备私有目录 <状态目录>/feishu-credentials/，每一代一个文件（0600）；库里只有代次。
// 换 Secret 时先写新一代、库里切过去，再删旧一代，中途失败不影响正在用的那一代。
import { join } from 'node:path'
import { ExternalPrivateFiles } from '../external/secrets-files.mjs'

export const FEISHU_CREDENTIALS_DIRECTORY = 'feishu-credentials'

const key = (appId: string, generation: number) => `${appId}-${generation}`

export class FeishuCredentials {
  private readonly files: ExternalPrivateFiles
  constructor(stateDirectory: string) {
    this.files = new ExternalPrivateFiles(join(stateDirectory, FEISHU_CREDENTIALS_DIRECTORY))
  }

  read(appId: string, generation: number): string | null {
    const text = this.files.read(key(appId, generation))
    if (text === null) return null
    try {
      const value = JSON.parse(text) as { appSecret?: unknown }
      return typeof value.appSecret === 'string' ? value.appSecret : null
    } catch {
      return null
    }
  }

  write(appId: string, generation: number, appSecret: string): void {
    this.files.write(key(appId, generation), JSON.stringify({ appSecret }))
  }

  /** 删掉一个应用除 keep 以外的全部代次；keep 为空时全删 */
  prune(appId: string, keep?: number): void {
    for (const name of this.files.keys()) {
      if (!name.startsWith(`${appId}-`)) continue
      if (keep !== undefined && name === key(appId, keep)) continue
      this.files.remove(name)
    }
  }

  /** 启动时清理：只留每个应用当前那一代 */
  sweep(current: ReadonlyMap<string, number>): void {
    for (const name of this.files.keys()) {
      const match = /^(cli_[0-9a-f]{16})-(\d+)$/.exec(name)
      if (!match || current.get(match[1] ?? '') !== Number(match[2])) this.files.remove(name)
    }
  }
}
