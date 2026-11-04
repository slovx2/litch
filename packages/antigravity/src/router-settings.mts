import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessConfigReadResponse } from '../../protocol/src/harness-config.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import type { BackendId } from './id-space.mjs'

export class RouterSettings {
  readonly home: string
  constructor(home: string) {
    this.home = home
  }
  mode(): 'apiKey' | 'subscription' {
    try {
      const value = JSON.parse(readFileSync(join(this.home, 'routing.json'), 'utf8'))
      if (!['apiKey', 'subscription'].includes(value.authenticationMode))
        throw new Error('Antigravity 鉴权方式配置无效')
      return value.authenticationMode
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'subscription'
      throw error
    }
  }
  backend(): BackendId {
    return this.mode() === 'apiKey' ? 'sdk' : 'acp'
  }
  version(inner: string): string {
    return createHash('sha256').update(`${this.mode()}:${inner}`).digest('hex')
  }
  read(inner: HarnessConfigReadResponse): HarnessConfigReadResponse {
    return {
      ...inner,
      groups: [
        { id: 'backend', title: { 'zh-CN': '鉴权方式', en: 'Authentication' }, description: null },
        ...inner.groups,
      ],
      settings: [
        {
          key: 'authenticationMode',
          group: 'backend',
          type: 'enum',
          title: { 'zh-CN': '鉴权方式', en: 'Authentication' },
          description: {
            'zh-CN':
              '订阅通过官方 agy acp 使用 CLI 登录；第三方客户端在消费套餐下的适用范围仍需你确认，存在账号限制风险。Litch 不读取或转存登录令牌。新会话使用所选方式，已有会话保留原后端。',
            en: 'Subscription access uses the CLI sign-in through official agy acp. You must confirm that your consumer plan permits this third-party client; account restrictions may apply. Litch does not read or copy sign-in tokens. This choice applies to new sessions; existing sessions retain their backend.',
          },
          default: 'subscription',
          effect: 'harness',
          clearable: false,
          options: [
            { value: 'apiKey', title: { 'zh-CN': 'Gemini API key', en: 'Gemini API key' } },
            {
              value: 'subscription',
              title: {
                'zh-CN': 'Google 订阅（官方 ACP）',
                en: 'Google subscription (official ACP)',
              },
            },
          ],
        },
        ...inner.settings,
      ],
      values: { ...inner.values, authenticationMode: this.mode() },
      version: this.version(inner.version),
      files: [{ role: 'routing', path: join(this.home, 'routing.json') }, ...inner.files],
    }
  }
  write(mode: unknown): void {
    if (mode !== 'apiKey' && mode !== 'subscription')
      throw new ProtocolError(-32602, '鉴权方式无效')
    mkdirSync(this.home, { recursive: true, mode: 0o700 })
    const path = join(this.home, 'routing.json')
    const temporary = `${path}.${randomUUID()}`
    writeFileSync(temporary, JSON.stringify({ authenticationMode: mode }), {
      mode: 0o600,
      flag: 'wx',
    })
    renameSync(temporary, path)
  }
}
